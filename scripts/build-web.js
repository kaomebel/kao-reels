// Veb-ilova fayllarini www/ papkaga yig'adi — undan Windows (Electron) va Android (Capacitor) ilovalari quriladi.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const FILES = ['index.html', 'styles.css', 'app.js', 'backend.js', 'config.js', 'manifest.webmanifest', 'sw.js', 'icons', 'vendor'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of FILES) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
console.log('www/ tayyor:', FILES.join(', '));
