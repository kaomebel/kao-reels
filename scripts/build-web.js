// Veb-ilova fayllarini www/ papkaga yig'adi — undan sayt, Windows (Electron) va Android (Capacitor) ilovalari quriladi.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const FILES = ['index.html', 'styles.css', 'app.js', 'icons.js', 'backend.js', 'config.js', 'manifest.webmanifest', 'sw.js', 'icons', 'vendor'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of FILES) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });

// Versiya: yig'ilgan vaqt va commit. Har bir yangi versiyada sw.js o'zgaradi —
// shunda o'rnatilgan ilova yangilanish borligini sezadi.
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const version = `${stamp}${process.env.GITHUB_SHA ? '-' + process.env.GITHUB_SHA.slice(0, 7) : ''}`;
fs.writeFileSync(path.join(out, 'version.js'), `window.BT_VERSION = ${JSON.stringify(version)};\n`);
const swPath = path.join(out, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8')
  .replace("const CACHE = 'biznes-tizim-dev';", `const CACHE = 'biznes-tizim-${version}';`)
  .replace("'./app.js',", "'./app.js', './version.js',"));
console.log('www/ tayyor, versiya', version);
