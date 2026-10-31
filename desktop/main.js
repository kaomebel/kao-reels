// Windows uchun ish stoli ilovasi: veb-ilovani alohida oynada ochadi.
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Ilova o'z ichidagi fayllar bilan o'rnatiladi, lekin har ochilganda (va har 30 daqiqada)
// saytdagi versiyani tekshiradi: yangisi bo'lsa yuklab olib, o'shandan ochiladi.
// Hammasi file:// manzilidan ochilgani uchun ma'lumotlar (lokal rejim) joyida qoladi.
const SITE = 'https://kaomebel.github.io/kao-reels/';
const bundled = path.join(__dirname, '..', 'www');
const webRoot = () => path.join(app.getPath('userData'), 'web');

function versionOf(dir) {
  try { return /"([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'version.js'), 'utf8'))[1]; } catch (e) { return ''; }
}

// Versiya "2026.10.31-0332-abc1234" ko'rinishida — matn sifatida solishtirsa ham vaqt tartibida
function currentDir() {
  const dir = path.join(webRoot(), 'current');
  return fs.existsSync(path.join(dir, 'index.html')) && versionOf(dir) > versionOf(bundled) ? dir : bundled;
}

async function download(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchUpdate() {
  const remote = /"([^"]+)"/.exec((await download(`${SITE}version.js?t=${Date.now()}`)).toString())?.[1];
  if (!remote || remote <= versionOf(currentDir())) return null;
  const files = JSON.parse((await download(`${SITE}files.json?v=${remote}`)).toString());
  const tmp = path.join(webRoot(), 'new');
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    if (typeof f !== 'string' || f.includes('..') || path.isAbsolute(f)) continue;
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await download(`${SITE}${encodeURI(f)}?v=${remote}`));
  }
  // Sayt yuklab olish paytida yangilangan bo'lsa — keyingi safar qayta urinamiz
  if (versionOf(tmp) !== remote || !fs.existsSync(path.join(tmp, 'index.html'))) throw new Error('Versiya mos kelmadi');
  const cur = path.join(webRoot(), 'current');
  fs.rmSync(cur, { recursive: true, force: true });
  fs.renameSync(tmp, cur);
  return cur;
}

let updating = false;
let loadedVersion = '';

function openApp(dir) {
  loadedVersion = versionOf(dir);
  win.loadFile(path.join(dir, 'index.html'));
}

async function checkUpdate() {
  if (updating || !win) return;
  updating = true;
  try {
    await fetchUpdate();
  } catch (e) {
    console.warn('Yangilanish:', e.message);
  }
  updating = false;
  const dir = currentDir();
  if (!win || versionOf(dir) === loadedVersion) return;
  // Ochiq oyna (hujjat yozilayotgan bo'lsa) — yopilguncha kutamiz, keyingi tekshiruvda ochiladi
  const busy = await win.webContents.executeJavaScript("!!document.querySelector('#modal')?.open").catch(() => false);
  if (!busy) openApp(dir);
}

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Biznes Tizim',
    icon: path.join(__dirname, '..', 'www', 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  openApp(currentDir());
  win.webContents.once('did-finish-load', checkUpdate);

  // Chop etish oynasi (bo'sh sahifa) ilova ichida ochiladi, tashqi havolalar — brauzerda
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Ikkinchi marta ochilsa — mavjud oynani oldinga chiqaramiz
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  setInterval(checkUpdate, 30 * 60e3);
  app.on('browser-window-focus', () => checkUpdate());
});

app.on('window-all-closed', () => app.quit());
