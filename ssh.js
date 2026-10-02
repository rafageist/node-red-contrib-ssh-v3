'use strict';

const { pick, parseInput, resolveOptions, describe } = require('./lib/options');
const { connect, exec, runOnce } = require('./lib/exec');

const STATUS_MAX = 60;

function short(text) {
	text = String(text);
	return text.length > STATUS_MAX ? text.slice(0, STATUS_MAX - 1) + '…' : text;
}

module.exports = function (RED) {

	function SshConf(n) {
		RED.nodes.createNode(this, n);
		const creds = this.credentials || {};
		// Only the key *path* is stored; the file is read when a connection is made.
		this.options = pick({
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
		// Static mode only: seconds the shared connection stays open while idle.
		// 0 = open and close a connection for every message.
		const keepOpen = Number(config.keepOpen);
		node.keepOpen = config.keepOpen === undefined || config.keepOpen === '' || !Number.isFinite(keepOpen) ? 60 : keepOpen;

		let closing = false;
		let active = 0;
		// Static (ssh-conf only) persistent connection, or null.
		let shared = null;
		// Per-message clients currently open, so shutdown can end them.
		const ephemeral = new Set();

		const track = (client) => {
			ephemeral.add(client);
			return () => ephemeral.delete(client);
		};

		function started(text) {
			active++;
			node.status({ fill: "blue", shape: "ring", text: short(active > 1 ? `${active} running` : text) });
		}

		function finished(label, err, session) {
			active--;
			if (closing || active > 0) {
				if (active > 0) {
					node.status({ fill: "blue", shape: "ring", text: `${active} running` });
				}
				return;
			}
			if (err) {
				node.status({ fill: "red", shape: "dot", text: short(err.message) });
			} else {
				node.status({ fill: session.code === 0 ? "green" : "yellow", shape: "dot", text: short(`${label} exit ${session.code}`) });
			}
		}

		function closeShared() {
			if (!shared) {
				return;
			}
			clearTimeout(shared.idleTimer);
			const client = shared.client;
			shared = null;
			if (client) {
				client.end();
			}
		}

		// Static mode: one connection for the fixed ssh-conf target, reused while
		// busy or within keepOpen, re-opened on the next message if it dropped.
		// Commands on it are queued: this keeps the original v3 one-at-a-time
		// behaviour and stays under the server's per-connection session limit.
		function runShared(options, command, label) {
			if (!shared) {
				const entry = { client: null, queue: Promise.resolve(), pending: 0, idleTimer: null };
				entry.ready = connect(options, label).then((client) => {
					entry.client = client;
					client.on('close', () => {
						if (shared === entry) {
							clearTimeout(entry.idleTimer);
							shared = null;
						}
					});
					return client;
				}, (err) => {
					if (shared === entry) {
						shared = null;
					}
					throw err;
				});
				shared = entry;
			}
			const entry = shared;
			entry.pending++;
			clearTimeout(entry.idleTimer);

			const run = entry.queue.then(() => entry.ready).then((client) => exec(client, command, label));
			entry.queue = run.catch(() => {});
			return run.finally(() => {
				entry.pending--;
				if (entry.pending === 0 && shared === entry) {
					entry.idleTimer = setTimeout(() => {
						if (shared === entry && entry.pending === 0) {
							closeShared();
						}
					}, node.keepOpen * 1000);
				}
			});
		}

		node.status({});

		node.on('input', async (msg, send, done) => {
			const { command, dynamic } = parseInput(msg);
			if (typeof command !== 'string' || command.trim() === '') {
				const err = new Error('msg.payload must be the command to run (a non-empty string)');
				err.code = 'SSH_CONFIG';
				node.status({ fill: "red", shape: "ring", text: "no command" });
				done(err);
				return;
			}

			let options;
			try {
				options = resolveOptions(node.conf ? node.conf.options : {}, dynamic);
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: short(err.message) });
				done(err);
				return;
			}

			const label = describe(options);
			// Any msg.ssh value (or v2 payload object) means a per-message target:
			// never share that connection with other messages.
			const perMessage = Object.keys(dynamic).length > 0 || node.keepOpen <= 0;

			started(`${perMessage ? 'connecting' : 'running on'} ${label}`);
			try {
				const session = perMessage
					? await runOnce(options, command, label, track)
					: await runShared(options, command, label);
				finished(label, null, session);
				msg.session = {
					code: session.code,
					signal: session.signal,
					stdout: session.stdout,
					stderr: session.stderr,
					host: label,
				};
				send(msg);
				done();
			} catch (err) {
				finished(label, err);
				// connections cut by a redeploy/shutdown are not errors of the flow
				closing ? done() : done(err);
			} finally {
				options = null;
			}
		});

		node.on('close', (removed, done) => {
			closing = true;
			closeShared();
			for (const client of ephemeral) {
				client.end();
			}
			ephemeral.clear();
			node.status({});
			done();
		});
	}

	RED.nodes.registerType("ssh-v3", SshV3);

};
