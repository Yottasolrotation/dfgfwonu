import assert from 'node:assert/strict';
import test from 'node:test';

import { countryFromName, parseSubscription, parseUserinfo, decodeHeaderText } from '../extension/lib/subscription.js';
import { buildConnectConfig, buildTestConfig } from '../extension/lib/xray.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const KR = encodeURIComponent('🇰🇷 Южная Корея #3');
const REALITY = `vless://${UUID}@192.0.2.10:443?encryption=none&flow=xtls-rprx-vision&type=tcp&headerType=none&security=reality&fp=edge&pbk=PUBKEY&sid=abcd&sni=cdn.example.net#${KR}`;
const GRPC = `vless://${UUID}@192.0.2.11:8443?encryption=none&type=grpc&serviceName=svc&mode=gun&security=tls&fp=edge&sni=g.example.net&pcs=AA%3ABB#${encodeURIComponent('🇩🇪 Германия')}`;
const HY2 = `hysteria2://${UUID}@192.0.2.12:30443?sni=hy.example.net&alpn=h3&insecure=0#${encodeURIComponent('🇩🇪 Hysteria2')}`;
const INSECURE = `vless://${UUID}@192.0.2.13:443?type=grpc&security=tls&sni=x.example.net&allowInsecure=1#${encodeURIComponent('🇵🇱 Польша')}`;
const LINKS = [REALITY, GRPC, HY2, INSECURE, 'vmess://ignored', ''].join('\n');

test('parses a base64 subscription and skips unknown schemes', () => {
  const servers = parseSubscription(Buffer.from(LINKS).toString('base64'));
  assert.equal(servers.length, 4);
  const [reality, grpc, hy2, insecure] = servers;
  assert.deepEqual(
    [reality.name, reality.country, reality.protocol, reality.host, reality.port, reality.transport, reality.security],
    ['🇰🇷 Южная Корея #3', 'KR', 'vless', '192.0.2.10', 443, 'tcp', 'reality'],
  );
  assert.equal(reality.secret, UUID);
  assert.equal(grpc.transport, 'grpc');
  assert.deepEqual([hy2.protocol, hy2.transport, hy2.unsupported], ['hysteria2', 'udp', null]);
  assert.match(insecure.unsupported, /cannot be verified/);
  assert.equal(new Set(servers.map((s) => s.id)).size, 4);
});

test('accepts a plain-text list and drops duplicates', () => {
  assert.equal(parseSubscription(`${REALITY}\r\n${REALITY}\n`).length, 1);
  assert.deepEqual(parseSubscription('not a subscription'), []);
});

test('reads country codes and subscription headers', () => {
  assert.equal(countryFromName('🇰🇷 Хабаровск - Южная Корея'), 'KR');
  assert.equal(countryFromName('no flag'), null);
  assert.deepEqual(parseUserinfo('upload=0; download=5; total=10; expire=1795276081'), {
    upload: 0,
    download: 5,
    total: 10,
    expire: 1795276081,
  });
  assert.equal(parseUserinfo(null), null);
  assert.equal(decodeHeaderText(`base64:${Buffer.from('🔥 VPN').toString('base64')}`), '🔥 VPN');
});

test('builds a loopback SOCKS config for a REALITY server', () => {
  const [server] = parseSubscription(REALITY);
  const config = buildConnectConfig(server);
  assert.deepEqual(config.inbounds.map((i) => [i.protocol, i.listen]), [['socks', '127.0.0.1']]);
  const [outbound] = config.outbounds;
  assert.deepEqual(outbound.settings.vnext[0], {
    address: '192.0.2.10',
    port: 443,
    users: [{ id: UUID, encryption: 'none', flow: 'xtls-rprx-vision' }],
  });
  assert.deepEqual(outbound.streamSettings, {
    network: 'tcp',
    security: 'reality',
    realitySettings: { serverName: 'cdn.example.net', fingerprint: 'edge', publicKey: 'PUBKEY', shortId: 'abcd', spiderX: '' },
  });
});

test('builds one routed inbound per server for tunnel tests', () => {
  const servers = parseSubscription(LINKS).filter((s) => !s.unsupported);
  const config = buildTestConfig(servers);
  assert.equal(config.inbounds.length, 3);
  assert.deepEqual(config.routing.rules[2], { type: 'field', inboundTag: ['in-2'], outboundTag: 'out-2' });
  assert.deepEqual(config.outbounds[1].streamSettings.tlsSettings, {
    serverName: 'g.example.net',
    fingerprint: 'edge',
    pinnedPeerCertSha256: 'AA:BB',
  });
  assert.deepEqual(config.outbounds[1].streamSettings.grpcSettings, { serviceName: 'svc', multiMode: false });
  const hy2 = config.outbounds[2];
  assert.deepEqual(hy2.settings, { version: 2, address: '192.0.2.12', port: 30443 });
  assert.deepEqual(hy2.streamSettings.hysteriaSettings, { version: 2, auth: UUID });
  assert.deepEqual(hy2.streamSettings.tlsSettings, { serverName: 'hy.example.net', alpn: ['h3'] });
});

test('refuses to build a config for an unsupported server', () => {
  const [server] = parseSubscription(INSECURE);
  assert.throws(() => buildConnectConfig(server), /cannot be verified/);
});
