'use strict';

// Lifecycle tests against in-process ssh2 servers and a minimal fake Node-RED runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils } = require('ssh2');

const HOST_KEY = utils.generateKeyPairSync('ed25519').private;
const USER_KEY = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-cbc' });
const USER_PUB = utils.parseKey(USER_KEY.public);

// ---- SSH test servers -------------------------------------------------------

function startServer(name) {
	const stats = { name, connections: 0, open: 0, sockets: new Set() };
	const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
		stats.connections++;
		stats.open++;
		const sock = client._sock;
		stats.sockets.add(sock);
		client.on('close', () => { stats.open--; stats.sockets.delete(sock); });
		client.on('error', () => {});
		client.on('authentication', (ctx) => {
			if (ctx.method === 'password' && ctx.username === 'bob' && ctx.password === 'secret') return ctx.accept();
			if (ctx.method === 'publickey' && ctx.username === 'alice' && ctx.key.algo === USER_PUB.type
				&& Buffer.compare(ctx.key.data, USER_PUB.getPublicSSH()) === 0) return ctx.accept();
			ctx.reject(['password', 'publickey']);
		});
		client.on('ready', () => {
			client.on('session', (accept) => {
				accept().once('exec', (acceptExec, rejectExec, info) => {
					if (info.command === 'reject') return rejectExec();
					const s = acceptExec();
					const reply = () => {
						if (info.command === 'fail') { s.stderr.write('boom\n'); s.exit(3); return s.end(); }
						if (info.command === 'signal') { s.exit('TERM'); return s.end(); }
						if (info.command === 'drop') { sock.destroy(); return; }
						s.write(`${name}:${info.command}\n`);
						s.exit(0);
						s.end();
					};
					info.command.startsWith('slow') ? setTimeout(reply, 150) : reply();
				});
			});
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
		stats.port = server.address().port;
		stats.server = server;
		resolve(stats);
	}));
}

// ---- fake Node-RED ----------------------------------------------------------

function loadNodes() {
	const types = {};
	const registry = {};
	const RED = {
		nodes: {
			createNode(node, cfg) {
				EventEmitter.call(node);
				Object.setPrototypeOf(Object.getPrototypeOf(node), EventEmitter.prototype);
				node.id = cfg.id;
				node.credentials = cfg.credentials;
				node.statuses = [];
				node.status = (s) => node.statuses.push(s);
				node.log = node.debug = node.warn = node.error = () => {};
			},
			registerType(name, fn) { types[name] = fn; },
			getNode(id) { return registry[id]; },
		},
	};
	delete require.cache[require.resolve('../ssh.js')];
	require('../ssh.js')(RED);
	return {
		make(type, cfg) { const n = new types[type](cfg); registry[cfg.id] = n; return n; },
	};
}

// Sends one message; resolves with { msg, err, sends, dones } once done() is called.
function send(node, msg) {
	return new Promise((resolve) => {
		const result = { sends: 0, dones: 0 };
		node.emit('input', msg, (m) => { result.sends++; result.msg = m; }, (err) => {
			result.dones++;
			result.err = err;
			// give any (buggy) second done() call a chance to show up
			setTimeout(() => resolve(result), 20);
		});
	});
}

const close = (node) => new Promise((r) => node.emit('close', false, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls until cond() is true (or the timeout passes) so connection-count checks do not depend on timing.
async function settle(cond, timeout = 3000) {
	const end = Date.now() + timeout;
	while (!cond() && Date.now() < end) await wait(20);
}

// ---- tests ------------------------------------------------------------------

test('ssh-v3 node', async (t) => {
	const A = await startServer('A');
	const B = await startServer('B');
	const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sshv3-')), 'id');
	fs.writeFileSync(keyFile, USER_KEY.private);
	const RED = loadNodes();

	const conf = RED.make('ssh-conf', { id: 'conf', ssh: '', credentials: { hostname: '127.0.0.1', port: String(A.port), username: 'bob', password: 'secret' } });
	assert.ok(conf);

	await t.test('static: ssh-conf + string payload, msg preserved, connection reused', async () => {
		const node = RED.make('ssh-v3', { id: 's1', conf: 'conf', keepOpen: 60 });
		const before = A.connections;
		const r1 = await send(node, { payload: 'hello', resource_id: 7, meta: { q: 1 } });
		const r2 = await send(node, { payload: 'again' });
		assert.equal(r1.err, undefined);
		assert.equal(r1.msg.resource_id, 7);
		assert.deepEqual(r1.msg.meta, { q: 1 });
		assert.equal(r1.msg.payload, 'hello');
		assert.deepEqual(r1.msg.session.stdout, ['A:hello\n']);
		assert.equal(r1.msg.session.code, 0);
		assert.equal(r1.msg.session.signal, null);
		assert.equal(r1.msg.session.host, `bob@127.0.0.1:${A.port}`);
		assert.ok(!JSON.stringify(r1.msg.session).includes('secret'));
		assert.equal(r2.msg.session.stdout[0], 'A:again\n');
		assert.equal(A.connections - before, 1, 'static mode reuses one connection');
		await close(node);
		await wait(50);
	});

	await t.test('static: keepOpen 0 opens and closes a connection per message', async () => {
		const node = RED.make('ssh-v3', { id: 's0', conf: 'conf', keepOpen: 0 });
		const before = A.connections;
		await send(node, { payload: 'x' });
		await send(node, { payload: 'y' });
		await settle(() => A.open === 0);
		assert.equal(A.connections - before, 2);
		assert.equal(A.open, 0);
		await close(node);
	});

	await t.test('static: reconnects after the connection drops', async () => {
		const node = RED.make('ssh-v3', { id: 's2', conf: 'conf', keepOpen: 60 });
		await send(node, { payload: 'one' });
		for (const s of A.sockets) s.destroy();
		await wait(50);
		const r = await send(node, { payload: 'two' });
		assert.equal(r.err, undefined);
		assert.equal(r.msg.session.stdout[0], 'A:two\n');
		await close(node);
	});

	await t.test('dynamic: different hosts concurrently on one node, connections closed', async () => {
		const node = RED.make('ssh-v3', { id: 'd1', conf: '', keepOpen: 60 });
		const [ra, rb] = await Promise.all([
			send(node, { payload: 'slow-a', ssh: { host: '127.0.0.1', port: A.port, username: 'bob', password: 'secret' }, id: 'a' }),
			send(node, { payload: 'slow-b', ssh: { host: '127.0.0.1', port: B.port, username: 'alice', privateKeyPath: keyFile, passphrase: 'pp' }, id: 'b' }),
		]);
		assert.equal(ra.err, undefined);
		assert.equal(rb.err, undefined);
		assert.equal(ra.msg.id, 'a');
		assert.deepEqual(ra.msg.session.stdout, ['A:slow-a\n']);
		assert.deepEqual(rb.msg.session.stdout, ['B:slow-b\n']);
		assert.equal(rb.msg.session.host, `alice@127.0.0.1:${B.port}`);
		await settle(() => A.open + B.open === 0);
		assert.equal(A.open + B.open, 0, 'per-message connections are closed');
		await close(node);
	});

	await t.test('hybrid: msg.ssh overrides host/user, inherits port and password from ssh-conf', async () => {
		const node = RED.make('ssh-v3', { id: 'h1', conf: 'conf', keepOpen: 60 });
		const r = await send(node, { payload: 'hyb', ssh: { host: 'localhost' } });
		assert.equal(r.err, undefined);
		assert.equal(r.msg.session.host, `bob@localhost:${A.port}`);
		await settle(() => A.open === 0);
		assert.equal(A.open, 0, 'hybrid messages are per-message too');
		await close(node);
	});

	await t.test('direct privateKey value', async () => {
		const node = RED.make('ssh-v3', { id: 'k1', conf: '' });
		const r = await send(node, { payload: 'k', ssh: { host: '127.0.0.1', port: B.port, username: 'alice', privateKey: USER_KEY.private, passphrase: 'pp' } });
		assert.equal(r.err, undefined);
		assert.equal(r.msg.session.code, 0);
		await close(node);
	});

	await t.test('v2 compatibility payload object', async () => {
		const node = RED.make('ssh-v3', { id: 'v2', conf: '' });
		const r = await send(node, { payload: { command: 'legacy', hostname: '127.0.0.1', port: A.port, username: 'bob', password: 'secret' } });
		assert.equal(r.err, undefined);
		assert.deepEqual(r.msg.session.stdout, ['A:legacy\n']);
		assert.equal(r.msg.payload.command, 'legacy', 'original payload is kept');
		await close(node);
	});

	await t.test('non-zero exit, stderr and signal are reported, not errors', async () => {
		const node = RED.make('ssh-v3', { id: 'e0', conf: 'conf' });
		const f = await send(node, { payload: 'fail' });
		assert.equal(f.err, undefined);
		assert.equal(f.msg.session.code, 3);
		assert.deepEqual(f.msg.session.stderr, ['boom\n']);
		const s = await send(node, { payload: 'signal' });
		assert.equal(s.err, undefined);
		assert.equal(s.msg.session.signal, 'SIGTERM');
		await close(node);
	});

	await t.test('errors are classified, done() once, no send, runtime survives', async () => {
		const node = RED.make('ssh-v3', { id: 'e1', conf: '' });
		const base = { host: '127.0.0.1', port: A.port, username: 'bob', password: 'secret' };
		const cases = [
			[{ payload: 'x', ssh: Object.assign({}, base, { password: 'wrong' }) }, 'SSH_AUTH'],
			[{ payload: 'x', ssh: Object.assign({}, base, { port: 1 }) }, 'SSH_CONNECT'],
			[{ payload: 'reject', ssh: base }, 'SSH_EXEC'],
			[{ payload: 'drop', ssh: base }, 'SSH_CONNECT'],
			[{ payload: 'x', ssh: Object.assign({}, base, { password: undefined, privateKeyPath: '/no/such/key' }) }, 'SSH_CONFIG'],
			[{ payload: 'x' }, 'SSH_CONFIG'],
			[{ payload: 42, ssh: base }, 'SSH_CONFIG'],
			[{ payload: '   ', ssh: base }, 'SSH_CONFIG'],
		];
		for (const [msg, code] of cases) {
			const r = await send(node, msg);
			assert.equal(r.err && r.err.code, code, `${JSON.stringify(msg.payload)} -> ${r.err && r.err.message}`);
			assert.equal(r.dones, 1, 'done called exactly once');
			assert.equal(r.sends, 0);
			assert.ok(!r.err.message.includes('secret') && !r.err.message.includes('wrong'));
		}
		const last = node.statuses[node.statuses.length - 1];
		assert.equal(last.fill, 'red');
		await settle(() => A.open === 0);
		assert.equal(A.open, 0, 'failed executions leave no connection open');
		await close(node);
	});

	await t.test('status: connecting then result, no credentials', async () => {
		const node = RED.make('ssh-v3', { id: 'st', conf: '' });
		await send(node, { payload: 'st', ssh: { host: '127.0.0.1', port: A.port, username: 'bob', password: 'secret' } });
		const texts = node.statuses.map((s) => s.text || '');
		assert.ok(texts.some((t) => t.startsWith('connecting bob@127.0.0.1')));
		assert.ok(texts[texts.length - 1].endsWith('exit 0'));
		assert.ok(!texts.join(' ').includes('secret'));
		await close(node);
	});

	await t.test('shutdown ends open connections and does not report errors', async () => {
		const node = RED.make('ssh-v3', { id: 'sd', conf: 'conf', keepOpen: 60 });
		await send(node, { payload: 'warm' });
		const pending = send(node, { payload: 'slow-x', ssh: { host: '127.0.0.1', port: B.port, username: 'bob', password: 'secret' } });
		await wait(60);
		await close(node);
		const r = await pending;
		assert.equal(r.err, undefined);
		assert.equal(r.dones, 1);
		await settle(() => A.open + B.open === 0);
		assert.equal(A.open + B.open, 0);
	});

	A.server.close();
	B.server.close();
});
