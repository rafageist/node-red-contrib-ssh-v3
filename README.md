![Schermata del 2022-09-17 06-41-12](https://user-images.githubusercontent.com/68069659/190840770-922ae42c-4c7f-4fbb-a0e0-8a8e5da53058.png)


[![library](https://img.shields.io/badge/library-nodered-red)](https://flows.nodered.org/node/node-red-contrib-ssh-v3)
[![package](https://img.shields.io/badge/package-npm-success)](https://www.npmjs.com/package/node-red-contrib-ssh-v3)
[![license](https://img.shields.io/badge/license-Apache--2.0-yellowgreen)](https://apache.org/licenses/LICENSE-2.0)
[![donate](https://img.shields.io/badge/donate-wango-blue)](https://www.wango.org/donate.aspx)

# node-red-contrib-ssh-v3

ssh connection remote host.

### installation

![Schermata del 2022-09-17 06-29-57](https://user-images.githubusercontent.com/68069659/190840457-8a8a09c0-ab3c-4dc7-bcd7-dfe18ef8e768.png)

or 
```bash 
npm i node-red-contrib-ssh-v3
```

### usage

```add ssh-conf```:

![Schermata del 2022-09-19 19-54-53](https://user-images.githubusercontent.com/68069659/191082553-e61bdb3b-892e-46a1-a1d8-758d6f4ff114.png)

```ssh configuration```:

![Schermata del 2022-09-19 19-55-23](https://user-images.githubusercontent.com/68069659/191082969-2d9b83f0-766b-4a3c-834a-3a5cbe3fa9d3.png)

### example:

```send input msg.payload = "string"```:

![immagine](https://user-images.githubusercontent.com/68069659/191083539-4a9b067d-67a1-4d63-8b23-829dab4174ee.png)

```use msg.session for capture stdout```:

![image](https://github.com/william89731/node-red-contrib-ssh-v3/assets/68069659/c1e3825c-390d-4eb7-8cb0-087e05f0c6fe)



### configuration modes

**A. Static** – select an `ssh-conf` server and send the command:

```js
msg.payload = "uname -a";
return msg;
```

**B. Dynamic** – no server needed; the target comes with each message, so one node can run
commands on many hosts:

```js
msg.payload = "hostname";
msg.ssh = {
    host: "lab.vvm.sr",
    port: 22,
    username: "root",
    privateKeyPath: "/var/lib/odoo/.ssh/id_ed25519"
};
return msg;
```

**C. Hybrid** – the `ssh-conf` server provides defaults, `msg.ssh` overrides only some of them
(here port, key/password are inherited from the server):

```js
msg.payload = "df -h";
msg.ssh = { host: "host2.example.com", username: "deploy" };
return msg;
```

`msg.ssh` properties: `host` (or `hostname`), `port`, `username`, `password`, `privateKey`
(key content), `privateKeyPath`, `passphrase`, `readyTimeout`, `keepaliveInterval`, `keepaliveCountMax`.

### precedence

- effective options = `ssh-conf` values, overridden by each `msg.ssh` value that is set;
  `undefined`, `null` and `""` in `msg.ssh` never erase a server value. `msg.ssh` is not modified.
- private key: `msg.ssh.privateKey` > `msg.ssh.privateKeyPath` > server key.
- `privateKeyPath` (and the server's key path) is a file **visible to the Node-RED runtime /
  container**, not a path on the remote SSH server.
- old ssh-v2 input `msg.payload = {command, hostname, port, username, password, privateKey}` is
  accepted for compatibility (`privateKey` there is a path); `msg.ssh` wins over it.
- hybrid use sends the server's credentials to the host in `msg.ssh` unless you override them.

### output

`msg.session = { code, signal, stdout: [], stderr: [], host: "user@host:port" }`, added to the
original message (all other properties are kept). Credentials are never copied to the output.

A non-zero exit code is a normal result. Failures go through `done(err)` (use a `catch` node), with
`err.code`: `SSH_CONFIG`, `SSH_CONNECT`, `SSH_AUTH` or `SSH_EXEC`. They never crash Node-RED.

### connections

- **static** (server only): one connection reused, closed after the node's *Keep open* idle
  seconds (0 = per message), re-opened if it drops; commands run one at a time, in order.
- **dynamic / hybrid** (any `msg.ssh` value): a new connection per message, closed when the
  command finishes. Messages for different hosts run concurrently and never share a connection.

### tests

```bash
npm test
```

### credits

source from [node-red-contrib-ssh](https://github.com/yroffin/node-red-contrib-ssh)
