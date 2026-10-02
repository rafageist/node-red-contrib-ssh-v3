'use strict';

const { Client } = require('ssh2');

// Clients whose connection has closed. ssh2 emits the client's 'close' before
// it closes the open channels, so exec() can tell "connection lost" apart from
// a server that simply sends no exit status (e.g. some network appliances).
const closedClients = new WeakSet();

// Tags an error with a stage so callers can tell connection, authentication
// and command failures apart: err.code = SSH_CONNECT | SSH_AUTH | SSH_EXEC.
function tag(err, code, target) {
	const e = err instanceof Error ? err : new Error(String(err));
	if (!e.code || typeof e.code !== 'string' || !e.code.startsWith('SSH_')) {
		e.sshCause = e.code;
		e.code = code;
	}
	if (target && !String(e.message).includes(target)) {
		e.message = `${target}: ${e.message}`;
	}
	return e;
}

function connectionError(err, target) {
	return tag(err, err && err.level === 'client-authentication' ? 'SSH_AUTH' : 'SSH_CONNECT', target);
}

// Opens a connection. Resolves with the ready client; rejects (and cleans up)
// if the connection fails before it is ready.
function connect(options, target) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let ready = false;
		client.on('ready', () => {
			ready = true;
			resolve(client);
		});
		client.on('error', (err) => {
			if (!ready) {
				client.end();
				reject(connectionError(err, target));
			}
			// after ready, errors are followed by 'close'; callers watch that
		});
		client.on('close', () => {
			closedClients.add(client);
			if (!ready) {
				reject(tag(new Error('connection closed before it was ready'), 'SSH_CONNECT', target));
			}
		});
		try {
			client.connect(options);
		} catch (err) {
			client.end();
			reject(connectionError(err, target));
		}
	});
}

// Runs one command on a ready client and collects its output.
function exec(client, command, target) {
	return new Promise((resolve, reject) => {
		const session = { code: null, signal: null, stdout: [], stderr: [] };
		let settled = false;
		const finish = (err) => {
			if (settled) {
				return;
			}
			settled = true;
			err ? reject(err) : resolve(session);
		};
		try {
			client.exec(command, (err, stream) => {
				if (err) {
					finish(tag(err, 'SSH_EXEC', target));
					return;
				}
				stream.on('data', (data) => session.stdout.push(data.toString()));
				stream.stderr.on('data', (data) => session.stderr.push(data.toString()));
				stream.on('exit', (code, signal) => {
					session.code = code === undefined ? null : code;
					session.signal = signal === undefined ? null : signal;
				});
				stream.on('error', (e) => finish(tag(e, 'SSH_EXEC', target)));
				stream.on('close', (code, signal) => {
					if (session.code === null && code !== undefined) {
						session.code = code;
					}
					if (session.signal === null && signal !== undefined) {
						session.signal = signal;
					}
					if (session.code === null && session.signal === null && closedClients.has(client)) {
						finish(tag(new Error('connection lost before the command finished'), 'SSH_CONNECT', target));
						return;
					}
					finish();
				});
			});
		} catch (err) {
			finish(tag(err, 'SSH_EXEC', target));
		}
	});
}

// Dynamic mode: a fresh connection for exactly one command, always closed afterwards.
// `track` (optional) receives the client so the node can end it on shutdown.
async function runOnce(options, command, target, track) {
	const client = await connect(options, target);
	const untrack = track ? track(client) : () => {};
	try {
		return await exec(client, command, target);
	} finally {
		untrack();
		client.end();
	}
}

module.exports = { connect, exec, runOnce };
