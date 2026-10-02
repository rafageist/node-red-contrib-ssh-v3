'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInput, resolveOptions } = require('../lib/options');

const fakeRead = (files) => (path) => {
	if (Object.prototype.hasOwnProperty.call(files, path)) {
		return Buffer.from(files[path]);
	}
	const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
	err.code = 'ENOENT';
	throw err;
};

const STATIC = { host: 'static.example', port: 2222, username: 'svc', password: 'static-pw' };

test('static options only', () => {
	const o = resolveOptions(STATIC, {});
	assert.equal(o.host, 'static.example');
	assert.equal(o.port, 2222);
	assert.equal(o.username, 'svc');
	assert.equal(o.password, 'static-pw');
});

test('dynamic options only', () => {
	const o = resolveOptions({}, { host: 'lab.vvm.sr', username: 'root', password: 'x' });
	assert.equal(o.host, 'lab.vvm.sr');
	assert.equal(o.port, 22);
	assert.equal(o.username, 'root');
});

test('dynamic overrides static, inherits the rest (hybrid)', () => {
	const o = resolveOptions(STATIC, { host: 'host2', username: 'root' });
	assert.equal(o.host, 'host2');
	assert.equal(o.username, 'root');
	assert.equal(o.port, 2222);
	assert.equal(o.password, 'static-pw');
});

test('undefined / null / empty dynamic values do not erase static values', () => {
	const o = resolveOptions(STATIC, { host: undefined, port: null, username: '', password: undefined });
	assert.equal(o.host, 'static.example');
	assert.equal(o.port, 2222);
	assert.equal(o.username, 'svc');
	assert.equal(o.password, 'static-pw');
});

test('hostname is accepted as an alias of host', () => {
	assert.equal(resolveOptions({}, { hostname: 'h', username: 'u', password: 'p' }).host, 'h');
});

test('password auth', () => {
	const o = resolveOptions({}, { host: 'h', username: 'u', password: 'secret' });
	assert.equal(o.password, 'secret');
	assert.equal(o.privateKey, undefined);
});

test('privateKeyPath is read from the Node-RED host filesystem', () => {
	const read = fakeRead({ '/keys/id': 'KEY-FROM-FILE' });
	const o = resolveOptions({}, { host: 'h', username: 'u', privateKeyPath: '/keys/id', passphrase: 'pp' }, read);
	assert.equal(o.privateKey.toString(), 'KEY-FROM-FILE');
	assert.equal(o.passphrase, 'pp');
});

test('privateKey direct value', () => {
	const o = resolveOptions({}, { host: 'h', username: 'u', privateKey: 'KEY-CONTENT' });
	assert.equal(o.privateKey, 'KEY-CONTENT');
});

test('key precedence: dynamic privateKey > dynamic privateKeyPath > static key', () => {
	const read = fakeRead({ '/static': 'STATIC-KEY', '/dyn': 'DYN-PATH-KEY' });
	const base = { host: 'h', username: 'u', privateKeyPath: '/static' };
	assert.equal(resolveOptions(base, {}, read).privateKey.toString(), 'STATIC-KEY');
	assert.equal(resolveOptions(base, { privateKeyPath: '/dyn' }, read).privateKey.toString(), 'DYN-PATH-KEY');
	assert.equal(resolveOptions(base, { privateKeyPath: '/dyn', privateKey: 'DYN-VALUE' }, read).privateKey, 'DYN-VALUE');
});

test('missing private key file fails safely without leaking contents', () => {
	assert.throws(
		() => resolveOptions({}, { host: 'h', username: 'u', privateKeyPath: '/nope' }, fakeRead({})),
		(err) => err.code === 'SSH_CONFIG' && /\/nope/.test(err.message) && /ENOENT/.test(err.message)
	);
});

test('missing host, username or auth is a config error', () => {
	assert.throws(() => resolveOptions({}, { username: 'u', password: 'p' }), { code: 'SSH_CONFIG' });
	assert.throws(() => resolveOptions({}, { host: 'h', password: 'p' }), { code: 'SSH_CONFIG' });
	assert.throws(() => resolveOptions({}, { host: 'h', username: 'u' }), { code: 'SSH_CONFIG' });
	assert.throws(() => resolveOptions({}, { host: 'h', username: 'u', password: 'p', port: 'abc' }), { code: 'SSH_CONFIG' });
});

test('config errors never contain the password or passphrase', () => {
	try {
		resolveOptions({}, { host: 'h', username: 'u', password: 'TOPSECRET', passphrase: 'PP', port: 99999 });
		assert.fail('should throw');
	} catch (err) {
		assert.ok(!err.message.includes('TOPSECRET'));
		assert.ok(!err.message.includes('PP'));
	}
});

test('two messages with different hosts resolve to independent configs', () => {
	const a = resolveOptions(STATIC, { host: 'lab.vvm.sr', username: 'root' });
	const b = resolveOptions(STATIC, { host: 'host2.example.com', username: 'deploy' });
	assert.equal(a.host, 'lab.vvm.sr');
	assert.equal(b.host, 'host2.example.com');
	assert.equal(a.username, 'root');
	assert.equal(b.username, 'deploy');
	assert.notEqual(a, b);
});

test('msg.ssh is not mutated', () => {
	const ssh = Object.freeze({ host: 'h', username: 'u', privateKeyPath: '/k' });
	const msg = { payload: 'ls', ssh };
	const { dynamic } = parseInput(msg);
	resolveOptions({}, dynamic, fakeRead({ '/k': 'K' }));
	assert.deepEqual(msg.ssh, { host: 'h', username: 'u', privateKeyPath: '/k' });
});

test('parseInput: string payload + msg.ssh', () => {
	const r = parseInput({ payload: 'uname -a', ssh: { host: 'h', username: 'u', extra: 'ignored' } });
	assert.equal(r.command, 'uname -a');
	assert.deepEqual(r.dynamic, { host: 'h', username: 'u' });
});

test('parseInput: v2 object payload is normalized (privateKey is a path in v2)', () => {
	const r = parseInput({ payload: { command: 'id', hostname: 'old', port: 22, username: 'u', privateKey: '/k' } });
	assert.equal(r.command, 'id');
	assert.deepEqual(r.dynamic, { host: 'old', port: 22, username: 'u', privateKeyPath: '/k' });
});

test('parseInput: msg.ssh wins over v2 payload fields', () => {
	const r = parseInput({ payload: { command: 'id', hostname: 'old', username: 'u' }, ssh: { host: 'new' } });
	assert.equal(r.dynamic.host, 'new');
	assert.equal(r.dynamic.username, 'u');
});

test('parseInput: non-command payloads give no command', () => {
	assert.equal(parseInput({ payload: 42 }).command, undefined);
	assert.equal(parseInput({ payload: { foo: 1 } }).command, undefined);
	assert.equal(parseInput({}).command, undefined);
});
