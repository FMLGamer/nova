#!/usr/bin/env node
/**
 * Everything Nova for Android needs to run the Nova server on the phone itself (run on Linux, in CI):
 *
 *   app/src/main/assets/nova-server.zip    the server (its JavaScript and pure-JavaScript packages) and the web app
 *   app/src/main/assets/nova-server.json   { version } so the app unpacks a new copy after an update
 *   app/src/main/assets/nova-cacert.pem    root certificates for HTTPS
 *   app/src/main/jniLibs/<abi>/            Node.js for Android (Termux's build) as libnovanode.so, and its libraries
 *
 * Android only lets an app run programs and load libraries from its native library folder, and only installs
 * files named lib*.so there. Libraries named like libssl.so.3 are renamed (libssl3.so), and every reference to
 * them is rewritten in place: the new names are shorter, so no ELF layout changes.
 *
 * Usage: node mobile/scripts/bundle-android.mjs [abi ...]     (default: arm64-v8a; also x86_64, armeabi-v7a)
 * Needs: the web app (dist/) and the server (server/dist/) built; npm, zip, ar, tar and readelf on PATH.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const main = path.join(root, 'mobile/android/app/src/main');
const work = path.join(root, 'build/android');
const TERMUX = 'https://packages.termux.dev/apt/termux-main';
const ARCH = { 'arm64-v8a': 'aarch64', x86_64: 'x86_64', 'armeabi-v7a': 'arm' };
/** Libraries every Android has: never bundled. */
const SYSTEM = new Set(['libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so']);
const abis = process.argv.slice(2).length ? process.argv.slice(2) : ['arm64-v8a'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

for (const abi of abis) if (!ARCH[abi]) throw new Error(`Unknown ABI ${abi} (use ${Object.keys(ARCH).join(', ')})`);
for (const need of ['dist/index.html', 'server/dist/index.js']) if (!fs.existsSync(path.join(root, need))) throw new Error(`Build first: ${need} is missing`);

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(main, 'assets'), { recursive: true });

// ---------------------------------------------------------------- the server and the web app

/** node-datachannel is native (WebRTC peers); webtorrent copes without WebRTC, so the phone gets this stand-in. */
const DATACHANNEL_STUB = `// Nova for Android: no WebRTC library on the phone. webtorrent falls back to ordinary peers.
const unavailable = () => {
  throw new Error('WebRTC is not available in Nova for Android');
};
export class PeerConnection { constructor() { unavailable(); } }
export class RtcpReceivingSession { constructor() { unavailable(); } }
export class Video { constructor() { unavailable(); } }
export class Audio { constructor() { unavailable(); } }
export function cleanup() {}
export default { PeerConnection, RtcpReceivingSession, Video, Audio, cleanup };
`;

function removeNative(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'prebuilds' || entry.name === '.bin') fs.rmSync(p, { recursive: true, force: true });
      else removeNative(p);
    } else if (entry.name.endsWith('.node')) fs.rmSync(p, { force: true });
  }
}

function stageServer() {
  const stage = path.join(work, 'stage');
  const server = path.join(stage, 'server');
  fs.mkdirSync(server, { recursive: true });
  fs.cpSync(path.join(root, 'server/dist'), path.join(server, 'dist'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
  // The phone's Node has SQLite built in (node:sqlite); native add-ons can't be loaded there anyway.
  delete pkg.dependencies['better-sqlite3'];
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.copyFileSync(path.join(root, 'server/package-lock.json'), path.join(server, 'package-lock.json'));
  run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server });
  fs.rmSync(path.join(server, 'package-lock.json'));

  const ndc = path.join(server, 'node_modules/node-datachannel');
  fs.rmSync(ndc, { recursive: true, force: true });
  fs.mkdirSync(ndc, { recursive: true });
  fs.writeFileSync(path.join(ndc, 'package.json'), JSON.stringify({ name: 'node-datachannel', version: '0.0.0-nova-android', type: 'module', main: './index.js', exports: { '.': './index.js' } }, null, 2));
  fs.writeFileSync(path.join(ndc, 'index.js'), DATACHANNEL_STUB);
  removeNative(path.join(server, 'node_modules'));

  fs.cpSync(path.join(root, 'dist'), path.join(stage, 'web'), { recursive: true });

  const zip = path.join(main, 'assets/nova-server.zip');
  fs.rmSync(zip, { force: true });
  run('zip', ['-qr9', zip, '.'], { cwd: stage });
  const version = `${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}-${createHash('sha256').update(fs.readFileSync(zip)).digest('hex').slice(0, 12)}`;
  fs.writeFileSync(path.join(main, 'assets/nova-server.json'), JSON.stringify({ version }));
  console.log(`[android] server + web app: ${mb(fs.statSync(zip).size)} (${version})`);
}

// ---------------------------------------------------------------- Node.js for Android

async function packageIndex(arch) {
  const res = await fetch(`${TERMUX}/dists/stable/main/binary-${arch}/Packages`);
  if (!res.ok) throw new Error(`Termux package index: ${res.status}`);
  const index = new Map();
  for (const block of (await res.text()).split('\n\n')) {
    const fields = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(': ');
      if (i > 0 && !line.startsWith(' ')) fields[line.slice(0, i)] = line.slice(i + 2);
    }
    if (fields.Package) index.set(fields.Package, fields);
  }
  return index;
}

function closure(index, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  if (!index.has(name)) throw new Error(`Termux has no package "${name}"`);
  seen.add(name);
  for (const dep of (index.get(name).Depends ?? '').split(',')) {
    const pkg = dep.split('|')[0].trim().replace(/\s*\(.*\)\s*$/, '');
    if (pkg) closure(index, pkg, seen);
  }
  return seen;
}

async function unpack(index, name, into) {
  const meta = index.get(name);
  const res = await fetch(`${TERMUX}/${meta.Filename}`);
  if (!res.ok) throw new Error(`Termux ${name}: ${res.status}`);
  const dir = path.join(work, 'debs', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg.deb'), Buffer.from(await res.arrayBuffer()));
  run('ar', ['x', 'pkg.deb'], { cwd: dir });
  const data = fs.readdirSync(dir).find((f) => f.startsWith('data.tar'));
  run('tar', ['-xf', data, '-C', into], { cwd: dir });
  return meta.Version;
}

const needed = (file) =>
  execFileSync('readelf', ['-dW', file], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /\(NEEDED\)\s+Shared library: \[(.+)\]/.exec(l)?.[1])
    .filter(Boolean);

/** libssl.so.3 -> libssl3.so: an installable name that is never longer than the original. */
const installable = (soname) => (/^lib[\w+-]+\.so$/.test(soname) ? soname : soname.replace(/^(lib[\w+-]+)\.so\.([\d.]+)$/, (_, base, v) => `${base}${v.replace(/\./g, '')}.so`));

/** Rewrites every NUL-delimited occurrence of each old name with its new one, padded with NULs. */
function rename(file, names) {
  const buf = fs.readFileSync(file);
  let changed = false;
  for (const [from, to] of names) {
    if (from === to) continue;
    const needle = Buffer.from(`\0${from}\0`);
    const replacement = Buffer.concat([Buffer.from(`\0${to}`), Buffer.alloc(from.length - to.length + 1)]);
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) {
      replacement.copy(buf, i);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, buf);
}

async function bundleNode(abi) {
  const arch = ARCH[abi];
  const index = await packageIndex(arch);
  const into = path.join(work, `termux-${arch}`);
  fs.mkdirSync(into, { recursive: true });
  const pkgs = closure(index, 'nodejs-lts');
  const versions = {};
  for (const name of pkgs) versions[name] = await unpack(index, name, into);
  const usr = path.join(into, 'data/data/com.termux/files/usr');
  const libDir = path.join(usr, 'lib');

  // Walk the node binary's library needs, then theirs.
  const files = new Map(); // soname -> real file
  const queue = [...needed(path.join(usr, 'bin/node'))];
  while (queue.length) {
    const so = queue.shift();
    if (files.has(so) || SYSTEM.has(so)) continue;
    const candidate = path.join(libDir, so);
    if (!fs.existsSync(candidate)) throw new Error(`${abi}: node needs ${so}, which neither Termux nor Android provides`);
    files.set(so, fs.realpathSync(candidate));
    queue.push(...needed(candidate));
  }
  const names = [...files.keys()].map((so) => [so, installable(so)]);
  for (const [so, to] of names) if (to.length > so.length || !/^lib[\w+-]+\.so$/.test(to)) throw new Error(`${abi}: can't give ${so} an installable name`);

  const out = path.join(main, 'jniLibs', abi);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const nodeOut = path.join(out, 'libnovanode.so');
  fs.copyFileSync(path.join(usr, 'bin/node'), nodeOut);
  rename(nodeOut, names);
  for (const [so, to] of names) {
    const dest = path.join(out, to);
    fs.copyFileSync(files.get(so), dest);
    rename(dest, names);
  }
  for (const f of fs.readdirSync(out)) fs.chmodSync(path.join(out, f), 0o755);
  const size = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  console.log(`[android] ${abi}: Node.js ${versions['nodejs-lts']} + ${names.length} libraries (${names.map(([, to]) => to).join(', ')}): ${mb(size)}`);

  const certs = path.join(usr, 'etc/tls/cert.pem');
  if (fs.existsSync(certs)) fs.copyFileSync(certs, path.join(main, 'assets/nova-cacert.pem'));
}

stageServer();
for (const abi of abis) await bundleNode(abi);
if (!fs.existsSync(path.join(main, 'assets/nova-cacert.pem'))) throw new Error('No root certificates found in Termux ca-certificates');
console.log('[android] ready: build the app with Gradle');
