// macOS builds have no Developer ID: sign them ad hoc, because Apple Silicon refuses to run unsigned code.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function machO(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) machO(p, out);
    else if (e.name.endsWith('.node') || /[/\\]bin[/\\](ffmpeg|ffprobe)$/.test(p)) out.push(p);
  }
  return out;
}

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const sign = (p) => execFileSync('codesign', ['--force', '--sign', '-', p], { stdio: 'inherit' });
  // Native modules and ffmpeg live in Resources, where --deep doesn't look; Node's own binary keeps its signature.
  for (const p of machO(path.join(app, 'Contents', 'Resources', 'app'))) sign(p);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
