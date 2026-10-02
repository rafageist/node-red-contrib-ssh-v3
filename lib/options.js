'use strict';

const fs = require('fs');

// Connection properties accepted from the ssh-conf node and from msg.ssh
const KEYS = [
	'host', 'port', 'username', 'password', 'privateKey', 'privateKeyPath',
	'passphrase', 'readyTimeout', 'keepaliveInterval', 'keepaliveCountMax'
];

const DEFAULT_PORT = 22;
const DEFAULT_KEEPALIVE_INTERVAL = 10000;

function isSet(value) {
	return value !== undefined && value !== null && value !== '';
}

// Copies the known connection properties that have a value.
// Never mutates `source`.
function pick(source) {
	const out = {};
	if (!source || typeof source !== 'object') {
		return out;
	}
	for (const key of KEYS) {
		if (isSet(source[key])) {
			out[key] = source[key];
		}
	}
	if (!isSet(out.host) && isSet(source.hostname)) {
		out.host = source.hostname;
	}
	return out;
}

function configError(message) {
	const err = new Error(message);
	err.code = 'SSH_CONFIG';
	return err;
}

// Splits an input message into the command and the dynamic connection settings.
//
// Primary contract:   msg.payload = "<command>", msg.ssh = { ... }
// v2 compatibility:   msg.payload = { command, hostname, port, privateKey, username, password }
//                     where v2's `privateKey` is a key *path*. msg.ssh wins over it.
function parseInput(msg) {
	const payload = msg.payload;
	if (typeof payload === 'string') {
		return { command: payload, dynamic: pick(msg.ssh) };
	}
	if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && typeof payload.command === 'string') {
		const legacy = pick(payload);
		if (isSet(legacy.privateKey)) {
			legacy.privateKeyPath = legacy.privateKey;
			delete legacy.privateKey;
		}
		return { command: payload.command, dynamic: Object.assign(legacy, pick(msg.ssh)) };
	}
	return { command: undefined, dynamic: pick(msg.ssh) };
}

// Effective ssh2 options = static config overridden by dynamic (msg.ssh) values.
// Private key precedence: dynamic privateKey > dynamic privateKeyPath > static key.
// Throws an SSH_CONFIG error (never logs secrets) when the result is unusable.
function resolveOptions(staticConfig, dynamicConfig, readFile) {
	const read = readFile || fs.readFileSync;
	const base = pick(staticConfig);
	const dyn = pick(dynamicConfig);
	const merged = Object.assign({}, base, dyn);

	let keySource = null;
	if (isSet(dyn.privateKey)) {
		keySource = { value: dyn.privateKey };
	} else if (isSet(dyn.privateKeyPath)) {
		keySource = { path: dyn.privateKeyPath };
	} else if (isSet(base.privateKey)) {
		keySource = { value: base.privateKey };
	} else if (isSet(base.privateKeyPath)) {
		keySource = { path: base.privateKeyPath };
	}

	if (!isSet(merged.host)) {
		throw configError('No SSH host: set it in the ssh-conf node or in msg.ssh.host');
	}
	if (!isSet(merged.username)) {
		throw configError('No SSH username: set it in the ssh-conf node or in msg.ssh.username');
	}

	const port = isSet(merged.port) ? Number(merged.port) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw configError(`Invalid SSH port: ${merged.port}`);
	}

	const options = {
		host: String(merged.host),
		port,
		username: String(merged.username),
		keepaliveInterval: isSet(merged.keepaliveInterval) ? Number(merged.keepaliveInterval) : DEFAULT_KEEPALIVE_INTERVAL,
	};
	if (isSet(merged.keepaliveCountMax)) {
		options.keepaliveCountMax = Number(merged.keepaliveCountMax);
	}
	if (isSet(merged.readyTimeout)) {
		options.readyTimeout = Number(merged.readyTimeout);
	}
	if (isSet(merged.password)) {
		options.password = String(merged.password);
	}
	if (keySource) {
		if (keySource.path !== undefined) {
			try {
				options.privateKey = read(String(keySource.path));
			} catch (e) {
				// only the path and the system error code, never file contents
				throw configError(`Cannot read private key file "${keySource.path}" (${e.code || e.message})`);
			}
		} else {
			options.privateKey = keySource.value;
		}
		if (isSet(merged.passphrase)) {
			options.passphrase = String(merged.passphrase);
		}
	}
	if (!options.password && !options.privateKey) {
		throw configError(`No SSH password or private key for ${options.username}@${options.host}`);
	}
	return options;
}

// Safe identifier for status text and msg.session (no credentials).
function describe(options) {
	return `${options.username}@${options.host}:${options.port}`;
}

module.exports = { KEYS, pick, parseInput, resolveOptions, describe };
