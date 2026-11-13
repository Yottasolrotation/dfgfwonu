// Parses a v2rayN-style subscription (base64 or plain list of share links)
// into the server objects used by the rest of the extension.

const SUPPORTED_SCHEMES = new Set(['vless', 'hysteria2', 'hy2']);

function hashId(str) {
  // cyrb53: stable, synchronous, good enough to key a few hundred links.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function decodeBase64Utf8(input) {
  const clean = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ISO 3166 alpha-2 code from the first flag emoji in a server name.
export function countryFromName(name) {
  const match = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (!match) return null;
  return [...match[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
}

function unsupportedReason(server) {
  const p = server.params;
  // Xray removed allowInsecure; a server that needs it has no verifiable identity.
  if ((p.allowInsecure === '1' || p.insecure === '1') && !p.pcs && !p.pinSHA256) {
    return 'server certificate cannot be verified';
  }
  if (server.protocol === 'hysteria2') {
    return server.params.obfs ? 'obfuscated Hysteria2 is not supported' : null;
  }
  if (!['tcp', 'grpc'].includes(server.transport)) return `${server.transport} transport is not supported`;
  if (!['reality', 'tls', 'none'].includes(server.security)) return `${server.security} security is not supported`;
  return null;
}

export function parseLink(link) {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  if (!SUPPORTED_SCHEMES.has(scheme)) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const port = Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || !port) return null;

  const params = Object.fromEntries(url.searchParams);
  const name = safeDecode(url.hash.slice(1)).trim() || `${host}:${port}`;
  const user = safeDecode(url.username);
  const pass = safeDecode(url.password);
  const protocol = scheme === 'vless' ? 'vless' : 'hysteria2';

  const server = {
    id: hashId(link),
    name,
    country: countryFromName(name),
    protocol,
    host,
    port,
    // VLESS user id, or the Hysteria2 auth string (which may be "user:pass").
    secret: protocol === 'hysteria2' && pass ? `${user}:${pass}` : user,
    transport: protocol === 'vless' ? (params.type === 'raw' ? 'tcp' : params.type || 'tcp') : 'udp',
    security: protocol === 'vless' ? params.security || 'none' : 'tls',
    params,
  };
  if (!server.secret) return null;
  server.unsupported = unsupportedReason(server);
  return server;
}

export function parseSubscription(body) {
  let text = body.trim();
  if (!text.includes('://')) {
    try {
      text = decodeBase64Utf8(text);
    } catch {
      return [];
    }
  }
  const seen = new Set();
  const servers = [];
  for (const line of text.split(/\r?\n/)) {
    const server = parseLink(line.trim());
    if (server && !seen.has(server.id)) {
      seen.add(server.id);
      servers.push(server);
    }
  }
  return servers;
}

// "upload=0; download=1; total=2; expire=3" -> { upload, download, total, expire }
export function parseUserinfo(header) {
  if (!header) return null;
  const info = {};
  for (const part of header.split(';')) {
    const [key, value] = part.split('=').map((s) => s.trim());
    if (key && value !== undefined && value !== '' && Number.isFinite(Number(value))) info[key] = Number(value);
  }
  return Object.keys(info).length ? info : null;
}

export function decodeHeaderText(value) {
  if (!value) return null;
  if (!value.startsWith('base64:')) return value;
  try {
    return decodeBase64Utf8(value.slice(7));
  } catch {
    return null;
  }
}
