# Polaris VPN

A Chrome extension that sends this browser's traffic (and only this browser's) through the servers of a
VLESS / Hysteria2 subscription. It lists the servers by country, measures their latency and connects with
one click.

## How it works

Chrome extensions cannot speak VLESS, REALITY or Hysteria2, and cannot open raw sockets. So the extension
comes with a small helper:

- `extension/` – the Chrome extension (Manifest V3): popup, subscription parser, Xray config builder.
- `host/` – a Node.js native messaging helper. It runs [Xray-core](https://github.com/XTLS/Xray-core) with a
  SOCKS5 inbound on `127.0.0.1` and does the latency tests. The extension points Chrome's proxy at that
  port while connected and removes the setting on disconnect.

Server credentials are sent to Xray over stdin and are never written to disk by the helper. The
subscription link and server list live in the extension's local storage; nothing is committed to this
repository.

## Install

Requires Node.js 18+ and Chrome, Chromium, Brave or Edge 116+.

1. Install the helper (downloads a pinned, checksum-verified Xray build into `host/bin/` and registers the
   helper with the browser):

   ```sh
   node host/install.mjs
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the
   `extension/` folder.
3. Open the popup, paste your subscription link and press **Load servers**. Chrome asks for permission to
   read that one site.

Keep the project folder where it is after installing: the browser starts the helper from it. To remove the
registration run `node host/install.mjs --uninstall`.

## Use

- **Country filter and search** narrow the list. South Korea is shown first when the subscription has it.
- **Test all** measures every listed server; clicking a server's latency box tests just that one.
  - *TCP ping* – time of a TCP handshake with the server (best of three).
  - *Tunnel test* – time of a real HTTP request sent through the server, which also proves the server
    works. Hysteria2 servers are UDP-only, so they always use this test.
- Select a server and press the power button. Once connected the popup shows the exit IP and country as
  seen by Cloudflare. Selecting another server while connected switches to it.

While connected, WebRTC is limited to proxied traffic so it cannot reveal the real address. To cover
incognito windows too, allow the extension in incognito on its details page.

## Russian input block

On `https://app.hoplite.sh/` the extension rejects Cyrillic text in every field: typed characters never
appear, and a paste or drop that contains Cyrillic is refused as a whole. A short notice explains why. The
block is independent of the VPN connection; the list of sites is `content_scripts` in
`extension/manifest.json`.

## Limits

- VLESS over TCP (REALITY or TLS) and gRPC, and Hysteria2 without obfuscation, are supported. Other
  transports are listed greyed out.
- Servers that only work with certificate checks turned off are refused; Xray no longer allows that.
- Only browser traffic is tunnelled. Other applications keep using the normal connection.

## Development

```sh
npm test
```
