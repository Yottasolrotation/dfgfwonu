#!/usr/bin/env node
// Installs the Polaris VPN helper: downloads a pinned Xray-core build and
// registers host.mjs as a native messaging host for Chromium browsers.
//   node host/install.mjs              install
//   node host/install.mjs --uninstall  remove the registration
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HOST_NAME = 'com.polaris.vpn';
// Fixed by the "key" in manifest.json.
const EXTENSION_ID = 'anhbmmdhphegkmdfdfnmnbnabnoapdhe';
const XRAY_VERSION = 'v26.11.9';
// SHA-256 of each release archive, from the .dgst files published with the release.
const XRAY_ASSETS = {
  'linux-x64': ['Xray-linux-64.zip', 'b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82'],
  'linux-arm64': ['Xray-linux-arm64-v8a.zip', '64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be'],
  'darwin-x64': ['Xray-macos-64.zip', '488963e676e06f5e48547f9dd38116aaca8de4234959b4272ae8f284e658dfd0'],
  'darwin-arm64': ['Xray-macos-arm64-v8a.zip', '233f0c66681cd0726f81a6b2b6ed6a5710869e312047b522e46ed53035bebd26'],
  'win32-x64': ['Xray-windows-64.zip', '1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d'],
  'win32-arm64': ['Xray-windows-arm64-v8a.zip', '9fdd48ff890e54ffdc37f92df9037c940fe4d4f914755b70cc644b97e9678a83'],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, 'bin');
const WINDOWS = process.platform === 'win32';
const XRAY = path.join(BIN, WINDOWS ? 'xray.exe' : 'xray');
const VERSION_FILE = path.join(BIN, 'xray.version');
const HOME = os.homedir();

const UNIX_DIRS = {
  linux: [
    '.config/google-chrome',
    '.config/google-chrome-for-testing',
    '.config/chromium',
    '.config/BraveSoftware/Brave-Browser',
    '.config/microsoft-edge',
  ],
  darwin: [
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Chromium',
    'Library/Application Support/BraveSoftware/Brave-Browser',
    'Library/Application Support/Microsoft Edge',
  ],
};
const WINDOWS_KEYS = [
  'HKCU\\Software\\Google\\Chrome',
  'HKCU\\Software\\Chromium',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser',
  'HKCU\\Software\\Microsoft\\Edge',
].map((key) => `${key}\\NativeMessagingHosts\\${HOST_NAME}`);

// Reads one entry out of a zip archive (stored or deflated).
function unzipEntry(zip, wanted) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip archive');
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  throw new Error(`${wanted} not found in archive`);
}

async function installXray() {
  const marker = `${XRAY_VERSION}\n`;
  if (existsSync(XRAY) && existsSync(VERSION_FILE) && readFileSync(VERSION_FILE, 'utf8') === marker) {
    return console.log(`Xray ${XRAY_VERSION} already installed`);
  }
  const asset = XRAY_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`No Xray build for ${process.platform}-${process.arch}`);
  const [file, sha256] = asset;
  const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${file}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== sha256) throw new Error(`Checksum mismatch for ${file}: got ${actual}`);
  mkdirSync(BIN, { recursive: true });
  writeFileSync(XRAY, unzipEntry(zip, path.basename(XRAY)), { mode: 0o755 });
  writeFileSync(VERSION_FILE, marker);
  console.log(`Installed Xray ${XRAY_VERSION} to ${XRAY}`);
}

// Browsers start the host with a minimal PATH, so the launcher pins this Node binary.
function writeLauncher() {
  const script = path.join(HERE, 'host.mjs');
  if (WINDOWS) {
    const launcher = path.join(HERE, 'host.bat');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
    return launcher;
  }
  const launcher = path.join(HERE, 'host.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

function register() {
  const manifest = JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Polaris VPN helper',
      path: writeLauncher(),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );
  if (WINDOWS) {
    const file = path.join(HERE, `${HOST_NAME}.json`);
    writeFileSync(file, manifest);
    for (const key of WINDOWS_KEYS) execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f']);
    return console.log(`Registered ${HOST_NAME} in the registry`);
  }
  for (const dir of UNIX_DIRS[process.platform] ?? []) {
    const target = path.join(HOME, dir, 'NativeMessagingHosts');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, `${HOST_NAME}.json`), manifest);
  }
  console.log(`Registered ${HOST_NAME} for Chrome, Chromium, Brave and Edge`);
}

function unregister() {
  if (WINDOWS) {
    for (const key of WINDOWS_KEYS) {
      try {
        execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
      } catch {
        // key was never created for this browser
      }
    }
  } else {
    for (const dir of UNIX_DIRS[process.platform] ?? []) {
      rmSync(path.join(HOME, dir, 'NativeMessagingHosts', `${HOST_NAME}.json`), { force: true });
    }
  }
  console.log(`Removed ${HOST_NAME} registration`);
}

if (process.argv.includes('--uninstall')) {
  unregister();
} else {
  await installXray();
  register();
  console.log('Done. Reload the extension and open its popup.');
}
