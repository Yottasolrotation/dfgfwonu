const $ = (id) => document.getElementById(id);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu;
// Latency (ms) below which a result counts as good / fair, per test type.
const LIMITS = { tcp: [120, 300], tunnel: [900, 1800] };

let state = { servers: [], connection: { status: 'disconnected' } };
let settingsOpen = false;
let search = '';
let countryOptionsKey = '';
let refreshing = false;
// Failure of the last user action; shown until the next one.
let actionError = null;

async function send(type, payload = {}) {
  if (type !== 'checkHelper') actionError = null;
  const reply = await chrome.runtime.sendMessage({ type, ...payload });
  if (!reply?.ok) throw new Error(reply?.error ?? 'The extension did not respond');
  return reply.result;
}

async function load() {
  const [local, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
  state = { servers: [], connection: { status: 'disconnected' }, pings: {}, ...local, ...session };
  render();
}

function countryName(code) {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function displayName(server) {
  return server.name.replace(FLAG, '').trim() || server.host;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(since) {
  const total = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  return `${hours ? `${hours}:` : ''}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

// Korea is the default view when the subscription has it; "all" otherwise.
function activeCountry() {
  const codes = new Set(state.servers.map((server) => server.country));
  if (state.country && (state.country === 'all' || codes.has(state.country))) return state.country;
  return codes.has('KR') ? 'KR' : 'all';
}

function visibleServers() {
  const country = activeCountry();
  const query = search.trim().toLowerCase();
  return state.servers.filter(
    (server) =>
      (country === 'all' || server.country === country) &&
      (!query || `${server.name} ${server.host}`.toLowerCase().includes(query)),
  );
}

function selectedServer() {
  return state.servers.find((server) => server.id === state.selectedId) ?? null;
}

// ------------------------------------------------------------------- render

function render() {
  const hasServers = state.servers.length > 0;
  const showSetup = !hasServers || settingsOpen;
  $('setup').hidden = !showSetup;
  $('app').hidden = showSetup;
  $('refresh').hidden = !hasServers || showSetup;
  $('settings').hidden = !hasServers || showSetup;
  $('profile').textContent = state.meta?.title?.trim() || 'Browser VPN';

  if (showSetup) return renderSetup(hasServers);
  renderHero();
  renderNotice();
  renderQuota();
  renderToolbar();
  renderServers();
}

function renderSetup(hasServers) {
  $('setup-title').textContent = hasServers ? 'Subscription' : 'Add your subscription';
  $('setup-submit').textContent = hasServers ? 'Save and reload' : 'Load servers';
  $('setup-back').hidden = !hasServers;
  $('setup-remove').hidden = !hasServers;
  if (hasServers && !$('sub-url').value) $('sub-url').value = state.subscriptionUrl ?? '';
}

function renderHero() {
  const { connection } = state;
  const { status } = connection;
  document.body.dataset.status = status;
  const server = state.servers.find((s) => s.id === connection.serverId) ?? selectedServer();
  const titles = { disconnected: 'Not connected', connecting: 'Connecting…', connected: 'Protected', error: 'Connection failed' };
  $('status-title').textContent = titles[status];
  $('status-sub').textContent = server ? displayName(server) : 'Pick a server and press the button';

  const live = status === 'connected';
  const exitIp = connection.exit?.ip ?? (connection.warning ? 'Exit IP unknown' : 'Checking exit IP…');
  $('stat-ip').textContent = live ? exitIp : 'This browser uses your own IP';
  $('stat-ip').title = live && connection.exit ? `Exit IP ${connection.exit.ip}` : '';
  $('stat-loc').textContent = live && connection.exit?.country ? countryName(connection.exit.country) : '';
  $('stat-up').textContent = live ? formatUptime(connection.since) : '';

  const busy = status === 'connected' || status === 'connecting';
  $('power').disabled = !busy && (!selectedServer() || selectedServer().unsupported || state.helper?.ok === false);
  $('power').setAttribute('aria-label', busy ? 'Disconnect' : 'Connect');
  $('power').title = busy ? 'Disconnect' : 'Connect';
}

function renderNotice() {
  const { helper, connection } = state;
  const text = $('notice-text');
  let kind = null;
  text.textContent = '';
  if (helper?.ok === false) {
    kind = 'warn';
    const code = document.createElement('code');
    code.textContent = 'node host/install.mjs';
    text.append(
      helper.reason === 'no-core' ? 'The VPN core is missing. Run ' : 'The helper is not installed. In the project folder run ',
      code,
      ' and try again.',
    );
  } else if (connection.status === 'error') {
    kind = 'error';
    text.textContent = connection.error;
  } else if (actionError) {
    kind = 'error';
    text.textContent = actionError;
  } else if (connection.warning) {
    kind = 'warn';
    text.textContent = connection.warning;
  }
  $('notice').hidden = !kind;
  $('notice').classList.toggle('error', kind === 'error');
  $('notice-action').hidden = helper?.ok !== false;
}

function renderQuota() {
  const info = state.meta?.userinfo;
  $('quota').hidden = !info?.total;
  if (!info?.total) return;
  const used = (info.upload ?? 0) + (info.download ?? 0);
  $('quota-used').textContent = `${formatBytes(used)} of ${formatBytes(info.total)} used`;
  $('quota-expire').textContent = info.expire
    ? `until ${new Date(info.expire * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';
  $('quota-bar').style.width = `${Math.min(100, (used / info.total) * 100)}%`;
}

function renderToolbar() {
  const counts = new Map();
  for (const server of state.servers) {
    if (server.country) counts.set(server.country, (counts.get(server.country) ?? 0) + 1);
  }
  const key = [...counts].join('|') + state.servers.length;
  const select = $('country');
  if (key !== countryOptionsKey) {
    countryOptionsKey = key;
    const options = [...counts]
      .map(([code, count]) => ({ code, label: `${countryName(code)} (${count})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    select.replaceChildren(
      new Option(`All countries (${state.servers.length})`, 'all'),
      ...options.map(({ code, label }) => new Option(label, code)),
    );
  }
  select.value = activeCountry();

  const mode = state.pingMode ?? 'tcp';
  for (const button of document.querySelectorAll('.seg button')) {
    button.classList.toggle('on', button.dataset.mode === mode);
  }
  const pinging = Boolean(state.pinging);
  $('ping-all').disabled = pinging || state.helper?.ok === false;
  $('ping-all').classList.toggle('busy', pinging);
  $('ping-all').querySelector('span').textContent = pinging ? 'Testing…' : 'Test all';
  $('refresh').classList.toggle('spin', refreshing);
}

function latencyView(server, fastestId) {
  const result = state.pings?.[server.id];
  const pending = state.pinging?.ids.includes(server.id) && !(result?.at >= state.pinging.startedAt);
  if (pending) return { text: '···', cls: 'pending' };
  if (!result) return { text: 'test', cls: '' };
  if (result.ms === null) return { text: 'timeout', cls: 'dead' };
  const [good, fair] = LIMITS[result.mode];
  const cls = result.ms < good ? 'good' : result.ms < fair ? 'fair' : 'slow';
  return { text: `${result.ms} ms`, cls, fastest: server.id === fastestId, mode: result.mode };
}

function renderServers() {
  const servers = visibleServers();
  const { connection } = state;
  const box = $('servers');

  const timed = servers.filter((server) => state.pings?.[server.id]?.ms != null);
  const fastestId =
    timed.length > 1 ? timed.reduce((a, b) => (state.pings[a.id].ms <= state.pings[b.id].ms ? a : b)).id : null;

  const rows = servers.map((server) => {
    const row = document.createElement('div');
    const active = connection.serverId === server.id && ['connected', 'connecting'].includes(connection.status);
    row.className = 'server';
    row.classList.toggle('selected', server.id === state.selectedId);
    row.classList.toggle('active', active);
    row.classList.toggle('disabled', Boolean(server.unsupported));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(server.id === state.selectedId));
    row.tabIndex = server.unsupported ? -1 : 0;
    row.dataset.id = server.id;

    const cc = document.createElement('span');
    cc.className = 'cc';
    cc.textContent = server.country ?? '··';
    cc.title = server.country ? countryName(server.country) : '';

    const view = latencyView(server, fastestId);
    const name = document.createElement('div');
    name.className = 'name';
    const label = document.createElement('span');
    label.textContent = displayName(server);
    label.title = server.name;
    name.append(label);
    if (view.fastest) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'fastest';
      name.append(tag);
    }

    const sub = document.createElement('div');
    sub.className = 'sub';
    const kind =
      server.protocol === 'hysteria2' ? 'Hysteria2' : `VLESS · ${server.security === 'reality' ? 'REALITY' : server.transport.toUpperCase()}`;
    sub.textContent = server.unsupported ?? `${server.host}:${server.port} · ${kind}`;

    const info = document.createElement('div');
    info.className = 'info';
    info.append(name, sub);

    const latency = document.createElement('button');
    latency.className = `latency ${view.cls}`;
    latency.textContent = view.text;
    latency.title = view.mode === 'tunnel' ? 'Request through the tunnel. Click to test again' : 'Click to test this server';
    latency.disabled = Boolean(server.unsupported) || Boolean(state.pinging) || state.helper?.ok === false;
    latency.dataset.ping = server.id;

    row.append(cc, info, latency);
    return row;
  });

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No servers match this filter';
    rows.push(empty);
  }
  const scroll = box.scrollTop;
  box.replaceChildren(...rows);
  box.scrollTop = scroll;

  const updated = state.meta?.fetchedAt ? new Date(state.meta.fetchedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  $('footer').textContent = `${servers.length} of ${state.servers.length} servers · updated ${updated}`;
}

// ------------------------------------------------------------------ actions

function report(error) {
  actionError = error.message;
  renderNotice();
}

async function selectServer(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server || server.unsupported) return;
  await chrome.storage.local.set({ selectedId: id });
  const { connection } = state;
  if (connection.status === 'connected' && connection.serverId !== id) {
    await send('connect', { serverId: id }).catch(report);
  }
}

async function togglePower() {
  const { status } = state.connection;
  if (status === 'connected' || status === 'connecting') return send('disconnect').catch(report);
  const server = selectedServer();
  if (server) await send('connect', { serverId: server.id }).catch(report);
}

function runPing(ids) {
  if (ids.length) send('ping', { ids, mode: state.pingMode ?? 'tcp' }).catch(report);
}

async function reload() {
  refreshing = true;
  renderToolbar();
  try {
    await send('refresh');
  } catch (error) {
    report(error);
  } finally {
    refreshing = false;
    renderToolbar();
  }
}

async function submitSubscription(event) {
  event.preventDefault();
  const error = $('setup-error');
  error.hidden = true;
  let url;
  try {
    url = new URL($('sub-url').value.trim());
  } catch {
    error.textContent = 'That does not look like a link';
    error.hidden = false;
    return;
  }
  const button = $('setup-submit');
  const label = button.textContent;
  try {
    // Must be the first await so it still counts as a user gesture.
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error('Permission to read the subscription link was declined');
    button.disabled = true;
    button.textContent = 'Loading…';
    await send('refresh', { url: url.href });
    settingsOpen = false;
    $('sub-url').value = '';
    await load();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ------------------------------------------------------------------- wiring

$('setup-form').addEventListener('submit', submitSubscription);
$('setup-back').addEventListener('click', () => {
  settingsOpen = false;
  render();
});
$('setup-remove').addEventListener('click', async () => {
  await send('removeSubscription').catch(report);
  settingsOpen = false;
  $('sub-url').value = '';
  await load();
});
$('settings').addEventListener('click', () => {
  settingsOpen = true;
  render();
});
$('refresh').addEventListener('click', reload);
$('power').addEventListener('click', togglePower);
$('notice-action').addEventListener('click', () => send('checkHelper').catch(report));
$('ping-all').addEventListener('click', () => runPing(visibleServers().map((server) => server.id)));
$('country').addEventListener('change', (event) => chrome.storage.local.set({ country: event.target.value }));
$('search').addEventListener('input', (event) => {
  search = event.target.value;
  renderServers();
});
for (const button of document.querySelectorAll('.seg button')) {
  button.addEventListener('click', () => chrome.storage.local.set({ pingMode: button.dataset.mode }));
}
$('servers').addEventListener('click', (event) => {
  const pingId = event.target.closest('[data-ping]')?.dataset.ping;
  if (pingId) return runPing([pingId]);
  const id = event.target.closest('.server')?.dataset.id;
  if (id) selectServer(id);
});
$('servers').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.classList.contains('server')) return;
  event.preventDefault();
  selectServer(event.target.dataset.id);
});

chrome.storage.onChanged.addListener(load);
setInterval(() => {
  if (state.connection.status === 'connected') $('stat-up').textContent = formatUptime(state.connection.since);
}, 1000);

await load();
send('checkHelper').catch(() => {});
