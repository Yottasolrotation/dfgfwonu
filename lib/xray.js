// Builds Xray-core JSON configs from parsed servers. The helper fills in the
// inbound ports (sent as 0) with free local ports before starting the core.

function list(value) {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

function tlsSettings(p, extra = {}) {
  const tls = { serverName: p.sni || p.peer || undefined, ...extra };
  if (p.fp) tls.fingerprint = p.fp;
  if (p.alpn) tls.alpn = list(p.alpn);
  if (p.pcs) tls.pinnedPeerCertSha256 = p.pcs;
  return tls;
}

function vlessOutbound(server, tag) {
  const p = server.params;
  const stream = { network: server.transport, security: server.security };

  if (server.transport === 'grpc') {
    stream.grpcSettings = { serviceName: p.serviceName || '', multiMode: p.mode === 'multi' };
    if (p.authority) stream.grpcSettings.authority = p.authority;
  }
  if (server.security === 'reality') {
    stream.realitySettings = {
      serverName: p.sni || '',
      fingerprint: p.fp || 'chrome',
      publicKey: p.pbk || '',
      shortId: p.sid || '',
      spiderX: p.spx || '',
    };
    if (p.pqv) stream.realitySettings.mldsa65Verify = p.pqv;
  } else if (server.security === 'tls') {
    stream.tlsSettings = tlsSettings(p);
  }

  const user = { id: server.secret, encryption: p.encryption || 'none' };
  if (p.flow) user.flow = p.flow;
  return {
    tag,
    protocol: 'vless',
    settings: { vnext: [{ address: server.host, port: server.port, users: [user] }] },
    streamSettings: stream,
  };
}

function hysteriaOutbound(server, tag) {
  const p = server.params;
  const tls = tlsSettings({ ...p, alpn: p.alpn || 'h3' });
  if (p.pinSHA256) tls.pinnedPeerCertSha256 = p.pinSHA256;
  return {
    tag,
    protocol: 'hysteria',
    settings: { version: 2, address: server.host, port: server.port },
    streamSettings: {
      network: 'hysteria',
      hysteriaSettings: { version: 2, auth: server.secret },
      security: 'tls',
      tlsSettings: tls,
    },
  };
}

export function buildOutbound(server, tag = 'proxy') {
  if (server.unsupported) throw new Error(server.unsupported);
  return server.protocol === 'hysteria2' ? hysteriaOutbound(server, tag) : vlessOutbound(server, tag);
}

// One SOCKS5 inbound on loopback routed to a single server.
export function buildConnectConfig(server) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'socks', listen: '127.0.0.1', port: 0, protocol: 'socks', settings: { auth: 'noauth', udp: true } },
    ],
    outbounds: [buildOutbound(server)],
  };
}

// One HTTP inbound per server so a single core process can test them all.
export function buildTestConfig(servers) {
  return {
    log: { loglevel: 'none' },
    inbounds: servers.map((_, i) => ({ tag: `in-${i}`, listen: '127.0.0.1', port: 0, protocol: 'http' })),
    outbounds: servers.map((server, i) => buildOutbound(server, `out-${i}`)),
    routing: {
      rules: servers.map((_, i) => ({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` })),
    },
  };
}
