import { decodeHeaderText, parseSubscription, parseUserinfo } from './lib/subscription.js';
import { buildConnectConfig, buildTestConfig } from './lib/xray.js';

const HOST_NAME = 'com.polaris.vpn';
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const BYPASS = ['<local>', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];
const TCP_BATCH = 64;
const TUNNEL_BATCH = 24;

const local = chrome.storage.local;
const session = chrome.storage.session;

// ---------------------------------------------------------------- helper port

let port = null;
let nextId = 1;
let releaseTimer = null;
const pending = new Map();

function openPort() {
  clearTimeout(releaseTimer);
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((message) => {
    if (message.event === 'core-exit') return onCoreExit(message.log);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(new Error(message.error));
  });
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? 'Helper disconnected';
    port = null;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
    onHelperGone();
  });
  return port;
}

function call(cmd, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Helper did not answer in time'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      openPort().postMessage({ id, cmd, ...payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

// An open native port keeps both the helper and this worker alive, so drop it
// once nothing needs it.
async function releaseWhenIdle() {
  clearTimeout(releaseTimer);
  const { connection } = await session.get('connection');
  if (connection?.status === 'connected' || connection?.status === 'connecting') return;
  releaseTimer = setTimeout(() => {
    if (pending.size === 0 && port) {
      port.disconnect();
      port = null;
    }
  }, 20000);
}

async function checkHelper() {
  let helper;
  try {
    const hello = await call('hello', {}, 5000);
    helper = hello.core ? { ok: true, core: hello.core } : { ok: false, reason: 'no-core' };
  } catch (error) {
    helper = { ok: false, reason: 'missing', detail: error.message };
  }
  await session.set({ helper });
  releaseWhenIdle();
  return helper;
}

// ------------------------------------------------------------------ browser

async function applyProxy(socksPort) {
  await chrome.proxy.settings.set({
    scope: 'regular',
    value: {
      mode: 'fixed_servers',
      // Chrome resolves hostnames through a SOCKS5 proxy, so DNS goes through the tunnel too.
      rules: { singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: socksPort }, bypassList: BYPASS },
    },
  });
  const { levelOfControl } = await chrome.proxy.settings.get({});
  if (levelOfControl !== 'controlled_by_this_extension') {
    throw new Error('Another extension or a policy controls the proxy settings');
  }
  // Without this WebRTC can reveal the real address over UDP outside the proxy.
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
}

async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
}

async function setConnection(connection) {
  await session.set({ connection });
  const on = connection.status === 'connected';
  await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
}

// --------------------------------------------------------------- connection

let generation = 0;
let queue = Promise.resolve();

// Connect/disconnect requests run one at a time, in order.
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function findServers(ids) {
  const { servers = [] } = await local.get('servers');
  const wanted = new Set(ids);
  return servers.filter((server) => wanted.has(server.id));
}

async function connect(serverId) {
  const [server] = await findServers([serverId]);
  if (!server) throw new Error('Server is no longer in the subscription');
  const current = ++generation;
  await local.set({ selectedId: serverId });
  await setConnection({ status: 'connecting', serverId });
  try {
    const { port: socksPort } = await call('start', { config: buildConnectConfig(server) }, 15000);
    await applyProxy(socksPort);
    await setConnection({ status: 'connected', serverId, since: Date.now() });
  } catch (error) {
    await teardown();
    await setConnection({ status: 'error', serverId, error: error.message });
    throw error;
  }
  verifyExit(current, serverId);
}

// Confirms traffic really leaves through the tunnel and reports the exit address.
async function verifyExit(current, serverId) {
  let exit = null;
  try {
    const response = await fetch(TRACE_URL, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const fields = Object.fromEntries((await response.text()).trim().split('\n').map((line) => line.split('=')));
    if (fields.ip) exit = { ip: fields.ip, country: fields.loc ?? null };
  } catch {
    // reported below
  }
  if (current !== generation) return;
  const { connection } = await session.get('connection');
  if (connection?.status !== 'connected' || connection.serverId !== serverId) return;
  await setConnection({ ...connection, exit, warning: exit ? null : 'Connected, but the test request through this server failed' });
}

async function teardown() {
  await clearProxy();
  if (port) await call('stop', {}, 5000).catch(() => {});
}

async function disconnect() {
  generation++;
  await teardown();
  await setConnection({ status: 'disconnected' });
  releaseWhenIdle();
}

async function onCoreExit(log) {
  generation++;
  await clearProxy();
  await setConnection({ status: 'error', error: `The VPN core stopped: ${log}` });
  releaseWhenIdle();
}

async function onHelperGone() {
  const { connection } = await session.get('connection');
  if (connection?.status !== 'connected' && connection?.status !== 'connecting') return;
  generation++;
  await clearProxy();
  await setConnection({ status: 'error', error: 'The helper stopped, so the VPN was turned off' });
}

// ------------------------------------------------------------- subscription

async function refresh(url) {
  const stored = await local.get('subscriptionUrl');
  const target = url ?? stored.subscriptionUrl;
  if (!target) throw new Error('No subscription link saved');
  const response = await fetch(target, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Subscription server answered HTTP ${response.status}`);
  const servers = parseSubscription(await response.text());
  if (!servers.length) throw new Error('No VLESS or Hysteria2 servers found at this link');
  await local.set({
    subscriptionUrl: target,
    servers,
    meta: {
      title: decodeHeaderText(response.headers.get('profile-title')),
      userinfo: parseUserinfo(response.headers.get('subscription-userinfo')),
      fetchedAt: Date.now(),
    },
  });
  return { count: servers.length };
}

async function removeSubscription() {
  await disconnect();
  await local.clear();
  await session.remove(['pings', 'pinging']);
}

// --------------------------------------------------------------------- ping

async function storeResults(results, mode) {
  const { pings = {} } = await session.get('pings');
  const at = Date.now();
  for (const [id, ms] of Object.entries(results)) pings[id] = { ms, mode, at };
  await session.set({ pings });
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// mode "tcp": handshake time to the server. mode "tunnel": a real request
// through the server. UDP-only servers have no TCP port, so they always use
// the tunnel test.
async function ping(ids, mode) {
  const servers = (await findServers(ids)).filter((server) => !server.unsupported);
  const viaTcp = mode === 'tcp' ? servers.filter((server) => server.transport !== 'udp') : [];
  const viaTunnel = servers.filter((server) => !viaTcp.includes(server));
  await session.set({ pinging: { ids: servers.map((server) => server.id), startedAt: Date.now() } });
  try {
    for (const batch of chunks(viaTcp, TCP_BATCH)) {
      const targets = batch.map(({ id, host, port: p }) => ({ id, host, port: p }));
      const { results } = await call('tcping', { targets }, 40000);
      await storeResults(results, 'tcp');
    }
    for (const batch of chunks(viaTunnel, TUNNEL_BATCH)) {
      const payload = { config: buildTestConfig(batch), ids: batch.map((server) => server.id) };
      const { results } = await call('urltest', payload, 40000);
      await storeResults(results, 'tunnel');
    }
  } finally {
    await session.remove('pinging');
    releaseWhenIdle();
  }
}

// ----------------------------------------------------------------- messages

const handlers = {
  checkHelper: () => checkHelper(),
  refresh: ({ url }) => refresh(url),
  removeSubscription: () => enqueue(removeSubscription),
  connect: ({ serverId }) => enqueue(() => connect(serverId)),
  disconnect: () => enqueue(disconnect),
  ping: ({ ids, mode }) => ping(ids, mode),
};

// A freshly started worker has no helper, so any earlier tunnel is gone and a
// proxy setting left behind would only break browsing.
const ready = (async () => {
  await clearProxy();
  await setConnection({ status: 'disconnected' });
  await session.remove('pinging');
})();

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  ready
    .then(() => handler(message))
    .then((result) => respond({ ok: true, result }))
    .catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
