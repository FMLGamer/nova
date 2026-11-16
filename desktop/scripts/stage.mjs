// Stages everything the desktop app runs into desktop/app (shipped as extraResources):
//   web/      the built UI
//   server/   the compiled server + production dependencies (native modules built for runtime/node.exe)
//   runtime/  the Node.js runtime that runs the server (the one running this script)
//   bin/      ffmpeg + ffprobe
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const out = path.join(desktop, 'app');
const require = createRequire(import.meta.url);

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}   (${path.relative(root, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (!process.env.NOVA_SKIP_BUILD) {
  run('npm run build', root);
  run('npm run build', path.join(root, 'server'));
}

copy(path.join(root, 'dist'), path.join(out, 'web'));
fs.copyFileSync(path.join(desktop, 'build', 'icon.png'), path.join(out, 'icon.png'));

const server = path.join(out, 'server');
copy(path.join(root, 'server', 'dist'), path.join(server, 'dist'));
for (const f of ['package.json', 'package-lock.json']) copy(path.join(root, 'server', f), path.join(server, f));
run('npm ci --omit=dev --no-audit --no-fund', server);

fs.mkdirSync(path.join(out, 'runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, 'runtime', 'node.exe'));

fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
fs.copyFileSync(require('ffmpeg-static'), path.join(out, 'bin', 'ffmpeg.exe'));
fs.copyFileSync(require('ffprobe-static').path, path.join(out, 'bin', 'ffprobe.exe'));
fs.writeFileSync(
  path.join(out, 'bin', 'README.txt'),
  'ffmpeg and ffprobe are separate programs from the FFmpeg project (https://ffmpeg.org), distributed under the GPL.\n' +
    'They are bundled unmodified from the ffmpeg-static and ffprobe-static packages; source is available at https://ffmpeg.org/download.html.\n',
);

console.log(`\nStaged ${out} with Node ${process.version}`);
