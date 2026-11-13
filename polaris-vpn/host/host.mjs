#!/usr/bin/env node
// Native messaging helper for the Polaris VPN extension. Chrome cannot speak
// VLESS/REALITY/Hysteria2 itself, so this process runs Xray-core on loopback
// and measures latency. It exits (and stops the core) when the browser closes
// the pipe.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const XRAY = path.join(HERE, 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray');
const TEST_URL = 'http://www.gstatic.com/generate_204';

let main = null; // { child, port } for the active connection

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function tcpConnect(host, port, timeout) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host, port });
    const done = (ms) => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeout, () => done(null));
    socket.once('connect', () => done(Math.max(1, Math.round(performance.now() - started))));
    socket.once('error', () => done(null));
  });
}

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

// Starts Xray with the config on stdin (credentials never touch the disk) and
// resolves once the first inbound accepts connections.
async function startCore(config) {
  if (!existsSync(XRAY)) throw new Error('Xray core is missing. Run "node host/install.mjs" again.');
  const ports = [];
  for (const inbound of config.inbounds) {
    inbound.listen = '127.0.0.1';
    inbound.port = await freePort();
    ports.push(inbound.port);
  }
  const child = spawn(XRAY, ['run', '-c', 'stdin:'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const core = { child, ports, log: '', exited: false };
  const collect = (chunk) => {
    core.log = (core.log + chunk).slice(-2000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('error', (error) => {
    collect(error.message);
    core.exited = true;
  });
  child.once('exit', () => {
    core.exited = true;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(config));

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (core.exited) throw new Error(`Xray failed to start: ${lastLine(core.log)}`);
    if ((await tcpConnect('127.0.0.1', ports[0], 300)) !== null) return core;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Xray did not start in time');
}

function lastLine(log) {
  return log.trim().split('\n').pop() || 'no output';
}

function stopMain() {
  if (!main) return;
  const { child } = main;
  main = null;
  child.kill();
}

function requestThrough(port, timeout) {
  return new Promise((resolve) => {
    const started = performance.now();
    const req = http.request(
      { host: '127.0.0.1', port, path: TEST_URL, headers: { Host: new URL(TEST_URL).host }, timeout },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode === 204 ? Math.round(performance.now() - started) : null));
      },
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(null));
    req.end();
  });
}

const commands = {
  hello() {
    let core = null;
    if (existsSync(XRAY)) {
      const out = spawnSync(XRAY, ['version'], { encoding: 'utf8', windowsHide: true });
      core = out.stdout?.split('\n')[0].split('(')[0].trim() || null;
    }
    return { version: VERSION, core };
  },

  async start({ config }) {
    stopMain();
    const core = await startCore(config);
    main = { child: core.child, port: core.ports[0] };
    core.child.once('exit', () => {
      // Only an exit we did not ask for is worth reporting.
      if (main?.child !== core.child) return;
      main = null;
      send({ event: 'core-exit', log: lastLine(core.log) });
    });
    return { port: main.port };
  },

  stop() {
    stopMain();
    return {};
  },

  // TCP handshake time to each server, best of `count` attempts.
  async tcping({ targets, count = 3, timeout = 3000 }) {
    const results = {};
    await pool(targets, 24, async ({ id, host, port }) => {
      let best = null;
      for (let i = 0; i < count; i++) {
        const ms = await tcpConnect(host, port, timeout);
        if (ms === null) break;
        best = best === null ? ms : Math.min(best, ms);
      }
      results[id] = best;
    });
    return { results };
  },

  // Round trip of a real HTTP request through each server's tunnel.
  async urltest({ config, ids, timeout = 8000 }) {
    const core = await startCore(config);
    try {
      const times = await Promise.all(core.ports.map((port) => requestThrough(port, timeout)));
      return { results: Object.fromEntries(ids.map((id, i) => [id, times[i]])) };
    } finally {
      core.child.kill();
    }
  },
};

async function handle(message) {
  const { id, cmd, ...payload } = message;
  try {
    if (!Object.hasOwn(commands, cmd)) throw new Error(`Unknown command: ${cmd}`);
    send({ id, ok: true, ...(await commands[cmd](payload)) });
  } catch (error) {
    send({ id, ok: false, error: error.message });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const body = buffer.subarray(4, 4 + length).toString('utf8');
    buffer = buffer.subarray(4 + length);
    handle(JSON.parse(body));
  }
});

function shutdown() {
  stopMain();
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
