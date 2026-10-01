'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { Mutex } = require('async-mutex');

// Connection options that can be set from the config node and/or msg.ssh
const OPTION_KEYS = [
	'host', 'port', 'username', 'password', 'privateKey', 'privateKeyPath',
	'passphrase', 'readyTimeout', 'keepaliveInterval', 'keepaliveCountMax'
];

const DEFAULT_KEEPALIVE_INTERVAL = 10000;

module.exports = function (RED) {

	function pick(obj) {
		const out = {};
		if (!obj || typeof obj !== 'object') {
			return out;
		}
		for (const key of OPTION_KEYS) {
			if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
				out[key] = obj[key];
			}
		}
		// accept "hostname" as an alias of "host"
		if (out.host === undefined && obj.hostname) {
			out.host = obj.hostname;
		}
		return out;
	}

	// Merge static config (config node) with dynamic config (msg.ssh) and
	// build the options object expected by ssh2.
	function buildOptions(base, override) {
		// values from msg.ssh win; anything missing falls back to the config node
		const merged = Object.assign({}, base, pick(override));

		if (!merged.host) {
			throw new Error('No host configured: set it in the ssh-conf node or in msg.ssh.host');
		}
		if (!merged.username) {
			throw new Error('No username configured: set it in the ssh-conf node or in msg.ssh.username');
		}

		const options = {
			host: String(merged.host),
			port: merged.port ? Number(merged.port) : 22,
			username: String(merged.username),
			keepaliveInterval: merged.keepaliveInterval !== undefined ? Number(merged.keepaliveInterval) : DEFAULT_KEEPALIVE_INTERVAL,
		};
		if (merged.keepaliveCountMax !== undefined) {
			options.keepaliveCountMax = Number(merged.keepaliveCountMax);
		}
		if (merged.readyTimeout !== undefined) {
			options.readyTimeout = Number(merged.readyTimeout);
		}
		if (merged.password !== undefined) {
			options.password = String(merged.password);
		}
		if (merged.privateKey !== undefined) {
			options.privateKey = merged.privateKey;
		} else if (merged.privateKeyPath) {
			try {
				options.privateKey = fs.readFileSync(merged.privateKeyPath);
			} catch (e) {
				throw new Error(`Cannot read private key "${merged.privateKeyPath}": ${e.message}`);
			}
		}
		if (merged.passphrase !== undefined) {
			options.passphrase = String(merged.passphrase);
		}
		if (!options.password && !options.privateKey) {
			throw new Error('No password or private key configured');
		}
		return options;
	}

	// Connections are pooled per node and identified by destination + credentials,
	// so two messages with the same target reuse the connection and messages with
	// different targets/credentials never share one.
	function connectionKey(options) {
		const secret = crypto.createHash('sha256')
			.update(String(options.password || ''))
			.update('\0')
			.update(options.privateKey ? Buffer.from(options.privateKey) : '')
			.update('\0')
			.update(String(options.passphrase || ''))
			.digest('hex');
		return `${options.username}@${options.host}:${options.port}#${secret}`;
	}

	function label(options) {
		return `${options.username}@${options.host}:${options.port}`;
	}

	function SshConf(n) {
		RED.nodes.createNode(this, n);
		const node = this;
		const creds = node.credentials || {};
		node.options = pick({
			host: creds.hostname,
			port: creds.port,
			username: creds.username,
			password: creds.password,
			passphrase: creds.passphrase,
			privateKeyPath: n.ssh,
		});
	}

	RED.nodes.registerType("ssh-conf", SshConf, {
		credentials: {
			username: { type: "text" },
			password: { type: "password" },
			passphrase: { type: "password" },
			hostname: { value: "" },
			port: { value: "" },
		}
	});

	function SshV3(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		node.conf = RED.nodes.getNode(config.conf);
		node.name = config.name;
		// seconds an idle connection is kept open; 0 = close after every command
		node.keepOpen = config.keepOpen === undefined || config.keepOpen === '' ? 60 : Number(config.keepOpen);
		node.pool = new Map();
		node.closing = false;

		function updateStatus() {
			const connected = [...node.pool.values()].filter((e) => e.connected);
			if (connected.length === 0) {
				node.status({ fill: "grey", shape: "ring", text: "idle" });
			} else if (connected.length === 1) {
				node.status({ fill: "green", shape: "dot", text: `connected ${connected[0].label}` });
			} else {
				node.status({ fill: "green", shape: "dot", text: `${connected.length} connections` });
			}
		}

		function dispose(entry) {
			clearTimeout(entry.idleTimer);
			if (node.pool.get(entry.key) === entry) {
				node.pool.delete(entry.key);
			}
			entry.connected = false;
			try {
				entry.client.end();
			} catch (e) { /* already closed */ }
		}

		function scheduleIdleClose(entry) {
			clearTimeout(entry.idleTimer);
			if (node.keepOpen <= 0) {
				dispose(entry);
				updateStatus();
				return;
			}
			entry.idleTimer = setTimeout(() => {
				if (entry.busy === 0) {
					dispose(entry);
					updateStatus();
				}
			}, node.keepOpen * 1000);
		}

		// Returns a ready pool entry, opening (or re-opening) the connection if needed.
		function getConnection(options) {
			const key = connectionKey(options);
			const existing = node.pool.get(key);
			if (existing) {
				return existing.ready;
			}

			const entry = {
				key,
				label: label(options),
				client: new Client(),
				mutex: new Mutex(),
				connected: false,
				busy: 0,
				idleTimer: null,
			};
			node.pool.set(key, entry);

			entry.ready = new Promise((resolve, reject) => {
				let settled = false;
				entry.client.on('ready', () => {
					settled = true;
					entry.connected = true;
					node.debug(`SSH connected to ${entry.label}`);
					updateStatus();
					resolve(entry);
				});
				entry.client.on('error', (err) => {
					node.debug(`SSH error on ${entry.label}: ${err.message}`);
					if (!settled) {
						settled = true;
						dispose(entry);
						node.status({ fill: "red", shape: "dot", text: `${entry.label}: ${err.message}` });
						reject(err);
					}
				});
				entry.client.on('close', () => {
					// drop it from the pool so the next message reconnects
					clearTimeout(entry.idleTimer);
					entry.connected = false;
					if (node.pool.get(key) === entry) {
						node.pool.delete(key);
					}
					if (!settled) {
						settled = true;
						reject(new Error(`Connection to ${entry.label} closed before ready`));
					}
					if (!node.closing) {
						updateStatus();
					}
				});
				try {
					entry.client.connect(options);
				} catch (err) {
					settled = true;
					dispose(entry);
					reject(err);
				}
			});
			return entry.ready;
		}

		function exec(entry, command) {
			return new Promise((resolve, reject) => {
				const session = { code: 0, signal: undefined, stdout: [], stderr: [] };
				entry.client.exec(command, (err, stream) => {
					if (err) {
						reject(err);
						return;
					}
					stream.on('close', (code, signal) => {
						session.code = code;
						session.signal = signal;
						resolve(session);
					}).on('data', (data) => {
						session.stdout.push(data.toString());
					}).stderr.on('data', (data) => {
						session.stderr.push(data.toString());
					});
				});
			});
		}

		updateStatus();

		node.on('input', async (msg, send, done) => {
			if (!msg.payload || typeof msg.payload !== "string") {
				done(new Error("msg.payload must be a non-empty string with the command to run"));
				return;
			}

			let options;
			try {
				options = buildOptions(node.conf ? node.conf.options : {}, msg.ssh);
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: err.message });
				done(err);
				return;
			}

			let entry;
			try {
				entry = await getConnection(options);
			} catch (err) {
				done(err);
				return;
			}

			entry.busy++;
			clearTimeout(entry.idleTimer);
			// commands on the same connection run one at a time
			const release = await entry.mutex.acquire();
			try {
				msg.session = await exec(entry, msg.payload);
				msg.session.host = entry.label;
				send(msg);
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "dot", text: `${entry.label}: ${err.message}` });
				done(err);
			} finally {
				release();
				entry.busy--;
				if (entry.busy === 0 && node.pool.get(entry.key) === entry) {
					scheduleIdleClose(entry);
				}
			}
		});

		node.on('close', (done) => {
			node.closing = true;
			for (const entry of [...node.pool.values()]) {
				dispose(entry);
			}
			done();
		});
	}

	RED.nodes.registerType("ssh-v3", SshV3);

};
