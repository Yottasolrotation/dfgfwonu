const $ = (id) => document.getElementById(id);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu;
// Latency (ms) below which a result counts as good / fair, per test type.
const LIMITS = { tcp: [120, 300], tunnel: [900, 1800] };

let state = { servers: [], connection: { status: 'disconnected' } };
// Section shown in the popup: 'servers', 'details' or 'settings'.
let view = 'servers';
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
  // Without servers there is nothing to show but the subscription form.
  const shown = hasServers ? view : 'settings';
  $('app').hidden = shown !== 'servers';
  $('details').hidden = shown !== 'details';
  $('setup').hidden = shown !== 'settings';
  $('refresh').hidden = !hasServers;
  for (const button of document.querySelectorAll('.nav')) {
    button.disabled = !hasServers && button.dataset.view !== 'settings';
    if (button.dataset.view === shown) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  renderHero();
  renderNotice();
  if (shown === 'settings') return renderSetup(hasServers);
  if (shown === 'details') return renderDetails();
  renderToolbar();
  renderServers();
}

function renderSetup(hasServers) {
  $('setup-submit').textContent = hasServers ? 'Save and reload' : 'Load servers';
  $('setup-remove').hidden = !hasServers;
  if (hasServers && !$('sub-url').value) $('sub-url').value = state.subscriptionUrl ?? '';
}

function renderHero() {
  const { connection } = state;
  const { status } = connection;
  document.body.dataset.status = status;
  const server = state.servers.find((s) => s.id === connection.serverId) ?? selectedServer();
  const titles = { disconnected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', error: 'Connection failed' };
  $('status-title').textContent = titles[status];
  $('rail-label').textContent = { disconnected: 'Off', connecting: '···', connected: 'On', error: 'Error' }[status];
  $('rail-status').title = titles[status];
  $('status-sub').textContent = server ? displayName(server) : 'No server selected';

  const live = status === 'connected';
  $('status-exit').textContent = live ? exitText(connection) : '';
  $('status-exit').title = live && connection.exit ? 'Exit IP and country' : '';
  $('stat-up').textContent = live ? formatUptime(connection.since) : '';

  const busy = status === 'connected' || status === 'connecting';
  $('power').disabled = !busy && (!selectedServer() || selectedServer().unsupported || state.helper?.ok === false);
  $('power-label').textContent = status === 'connected' ? 'Disconnect' : status === 'connecting' ? 'Cancel' : 'Connect';
}

function exitText(connection) {
  const ip = connection.exit?.ip ?? (connection.warning ? 'Exit IP unknown' : 'Checking exit IP…');
  const country = connection.exit?.country ? countryName(connection.exit.country) : '';
  return [ip, country].filter(Boolean).join(' · ');
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

// Fills one row of the details view and hides the row when there is nothing to show.
function fact(id, value) {
  $(id).textContent = value;
  $(id).closest('.fact').hidden = !value;
}

function protocolLabel(server) {
  if (server.protocol === 'hysteria2') return 'Hysteria2';
  return `VLESS · ${server.security === 'reality' ? 'REALITY' : server.transport.toUpperCase()}`;
}

function renderDetails() {
  const { connection, meta } = state;
  const info = meta?.userinfo;
  const used = (info?.upload ?? 0) + (info?.download ?? 0);
  fact('quota-used', info?.total ? `${formatBytes(used)} of ${formatBytes(info.total)}` : info ? formatBytes(used) : '');
  $('quota-track').hidden = !info?.total;
  if (info?.total) $('quota-bar').style.width = `${Math.min(100, (used / info.total) * 100)}%`;
  fact(
    'quota-expire',
    info?.expire ? new Date(info.expire * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
  );
  fact('fact-servers', String(state.servers.length));
  fact('fact-updated', meta?.fetchedAt ? new Date(meta.fetchedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  const server = state.servers.find((s) => s.id === connection.serverId) ?? selectedServer();
  $('details-server').hidden = !server;
  if (!server) return;
  fact('fact-name', displayName(server));
  fact('fact-address', `${server.host}:${server.port}`);
  fact('fact-protocol', protocolLabel(server));
  fact('fact-exit', connection.status === 'connected' ? exitText(connection) : '');
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

    const latencyInfo = latencyView(server, fastestId);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = displayName(server);
    // Address and protocol stay out of the row; the tooltip and the details view carry them.
    row.title = server.unsupported ?? `${server.host}:${server.port} · ${protocolLabel(server)}`;

    const latency = document.createElement('button');
    latency.className = `latency ${latencyInfo.cls}`;
    latency.classList.toggle('fastest', Boolean(latencyInfo.fastest));
    latency.textContent = server.unsupported ? 'n/a' : latencyInfo.text;
    const hint = latencyInfo.mode === 'tunnel' ? 'Request through the tunnel. Click to test again' : 'Click to test this server';
    latency.title = latencyInfo.fastest ? `Fastest in this list. ${hint}` : hint;
    latency.disabled = Boolean(server.unsupported) || Boolean(state.pinging) || state.helper?.ok === false;
    latency.dataset.ping = server.id;

    const check = document.createElement('span');
    check.className = 'check';
    check.setAttribute('aria-hidden', 'true');

    row.append(cc, name, latency, check);
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

  $('footer').textContent = `${servers.length} of ${state.servers.length} servers`;
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
    view = 'servers';
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
$('setup-remove').addEventListener('click', async () => {
  await send('removeSubscription').catch(report);
  view = 'servers';
  $('sub-url').value = '';
  await load();
});
for (const button of document.querySelectorAll('.nav')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    render();
  });
}
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
