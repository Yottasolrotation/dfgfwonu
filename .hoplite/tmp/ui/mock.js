// Stand-in for the chrome.* APIs so popup.html can be rendered outside the extension.
(() => {
  const scenario = new URLSearchParams(location.search).get('s') ?? 'connected';
  const mk = (id, name, country, extra = {}) => ({
    id,
    name,
    country,
    protocol: 'vless',
    host: '89.125.99.' + id,
    port: 443,
    transport: 'grpc',
    security: 'tls',
    unsupported: null,
    ...extra,
  });
  const servers = [
    mk(1, '🇰🇷 Южная Корея', 'KR'),
    mk(2, '🇰🇷 Южная Корея #2', 'KR'),
    mk(3, '🇰🇷 Южная Корея #3', 'KR', { host: '66.90.92.53', transport: 'tcp', security: 'reality' }),
    mk(4, '🇰🇷 Южная Корея #4', 'KR', { transport: 'tcp', security: 'reality' }),
    mk(5, '🇰🇷 Южная Корея #5', 'KR'),
    mk(6, '🇰🇷 Южная Корея #6', 'KR'),
    mk(7, '🇰🇷 Южная Корея #7', 'KR'),
    mk(8, '🇰🇷 Южная Корея #8', 'KR'),
    mk(9, '🇩🇪 Германия', 'DE'),
    mk(10, '🇩🇪 Германия Hysteria2', 'DE', { protocol: 'hysteria2', transport: 'udp' }),
    mk(11, '🇵🇱 Польша', 'PL', { unsupported: 'This server cannot be verified: certificate checks are disabled' }),
    mk(12, '🇳🇱 Нидерланды — очень длинное название сервера для проверки обрезки', 'NL'),
    mk(13, '🇫🇮 Финляндия', 'FI'),
    mk(14, '🇺🇸 США Нью-Йорк', 'US'),
    mk(15, '🇯🇵 Япония', 'JP'),
    mk(16, '🇸🇪 Швеция', 'SE'),
  ];
  const ping = (ms, mode = 'tcp') => ({ ms, mode, at: 1 });
  const pings = { 1: ping(182), 2: ping(183), 3: ping(133), 4: ping(269), 5: ping(261), 6: ping(98), 7: ping(412), 8: ping(null), 9: ping(64), 13: ping(88) };
  const meta = {
    title: '🔥 Quattro VPN',
    userinfo: { upload: 1.2 * 2 ** 30, download: 7.5 * 2 ** 30, total: 500 * 2 ** 30, expire: 1795276081 },
    fetchedAt: Date.UTC(2026, 10, 14, 1, 53),
  };
  const base = { servers, meta, selectedId: 3, pings, pingMode: 'tcp', subscriptionUrl: 'https://provider.example/sub/abcdef', helper: { ok: true } };
  const exit = { ip: '109.61.127.146', country: 'KR' };
  const off = { connection: { status: 'disconnected' } };
  const scenarios = {
    connected: { local: base, session: { connection: { status: 'connected', serverId: 3, since: Date.now() - 108000, exit } } },
    off: { local: { ...base, country: 'all', selectedId: 9 }, session: off },
    connecting: { local: base, session: { connection: { status: 'connecting', serverId: 3 } } },
    error: { local: base, session: { connection: { status: 'error', serverId: 3, error: 'The server did not answer within 10 seconds' } } },
    helper: { local: { ...base, helper: { ok: false, reason: 'missing' } }, session: off },
    pinging: { local: { ...base, pingMode: 'tunnel' }, session: { ...off, pinging: { ids: [1, 2, 3, 4, 5, 6, 7, 8], startedAt: 5 } } },
    empty: { local: {}, session: {} },
  };
  const stores = structuredClone(scenarios[scenario]);
  const listeners = [];
  const area = (name) => ({
    get: async () => structuredClone(stores[name]),
    set: async (values) => {
      Object.assign(stores[name], values);
      for (const listener of listeners) listener({}, name);
    },
  });
  window.__sent = [];
  window.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (listener) => listeners.push(listener) } },
    runtime: {
      sendMessage: async (message) => {
        window.__sent.push(message);
        return { ok: true };
      },
    },
    permissions: { request: async () => true },
  };
})();
