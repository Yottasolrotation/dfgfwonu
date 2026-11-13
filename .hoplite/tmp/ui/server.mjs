// Serves the extension folder with a chrome.* stand-in injected, for screenshots only.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

http
  .createServer((req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname);
    try {
      let body;
      if (path === '/__mock.js') body = readFileSync(join(here, 'mock.js'));
      else if (path === '/__icon.html') body = readFileSync(join(here, 'icon.html'));
      else body = readFileSync(join(root, path));
      if (path === '/popup.html') {
        body = String(body).replace('<script type="module"', '<script src="/__mock.js"></script>\n    <script type="module"');
      }
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(8455, '127.0.0.1');
