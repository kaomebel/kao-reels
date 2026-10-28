'use strict';

/*
 * Biznes Tizim — mebel do'koni uchun ombor va savdo hisobi.
 * Hisob hujjatlarga asoslangan: tovar qoldig'i va kontragent qarzlari
 * saqlanmaydi, balki hujjatlar (qabul qilish, jo'natish, qaytarish...)
 * va to'lovlardan har safar hisoblab chiqiladi.
 */

// ---------- Ma'lumotnomalar ----------

const ORDER_STATUSES = { new: 'Yangi', confirmed: 'Tasdiqlandi', making: 'Tayyorlanmoqda', shipped: "Jo'natildi", cancel: 'Bekor qilindi' };
const PO_STATUSES = { new: 'Yangi', sent: 'Yuborildi', received: 'Qabul qilindi', cancel: 'Bekor qilindi' };
const DELIVERY_STATUSES = { pending: 'Yetkazilishi kerak', onway: "Yo'lda", delivered: 'Yetkazildi' };

// stock: ombor qoldig'iga ta'siri; money: kontragent bizga qarzi qanday o'zgaradi;
// pay: hujjat bo'yicha to'lov yo'nalishi; next: shu hujjat asosida yaratiladigan hujjat.
const DOC_TYPES = {
  purchaseOrder: { fx: true, list: "Ta'minotchiga buyurtmalar", one: "Ta'minotchiga buyurtma", prefix: 'TB', party: 'supplier', price: 'buy', stock: 0, money: 0, statuses: PO_STATUSES, pay: 'out', next: 'receipt' },
  receipt: { fx: true, tgAsk: true, list: 'Qabul qilish', one: 'Qabul qilish', prefix: 'QQ', party: 'supplier', price: 'buy', stock: 1, money: -1, pay: 'out', next: 'purchaseReturn' },
  purchaseReturn: { fx: true, list: "Ta'minotchiga qaytarish", one: "Ta'minotchiga qaytarish", prefix: 'TQ', party: 'supplier', price: 'buy', stock: -1, money: 1, pay: 'in' },
  order: { list: 'Mijoz buyurtmalari', one: 'Mijoz buyurtmasi', prefix: 'MB', party: 'customer', price: 'sale', stock: 0, money: 0, statuses: ORDER_STATUSES, pay: 'in', delivery: true, next: 'sale' },
  sale: { list: "Jo'natish (sotuv)", one: "Jo'natish", prefix: 'S', party: 'customer', price: 'sale', stock: -1, money: 1, statuses: DELIVERY_STATUSES, pay: 'in', delivery: true, next: 'salesReturn' },
  salesReturn: { list: 'Mijozdan qaytarish', one: 'Mijozdan qaytarish', prefix: 'MQ', party: 'customer', price: 'sale', stock: 1, money: -1, pay: 'out' },
  enter: { fx: true, tgAsk: true, list: 'Kirim qilish', one: 'Kirim qilish', prefix: 'K', price: 'buy', stock: 1, money: 0 },
  writeoff: { list: 'Hisobdan chiqarish', one: 'Hisobdan chiqarish', prefix: 'HC', price: 'buy', stock: -1, money: 0 },
  move: { list: "Ko'chirish", one: "Ko'chirish", prefix: 'KO', price: 'buy', stock: 0, money: 0, move: true },
  inventory: { list: 'Inventarizatsiya', one: 'Inventarizatsiya', prefix: 'INV', price: 'buy', stock: 0, money: 0 },
};

// Rezervga olinadigan (hali jo'natilmagan) buyurtma holatlari
const RESERVING = ['new', 'confirmed', 'making'];

const PAY_METHODS = { cash: 'Naqd (kassa)', card: 'Karta', bank: 'Hisob raqam' };
const PAY_PURPOSES_IN = ["Mijozdan to'lov", "Ta'minotchidan qaytim", 'Boshqa kirim'];
const PAY_PURPOSES_OUT = ["Ta'minotchiga to'lov", 'Mijozga qaytarish', 'Ijara', 'Ish haqi', 'Kommunal', 'Transport / yetkazish', 'Soliq', 'Reklama', 'Boshqa xarajat'];
// Kontragentga bog'liq bo'lmagan chiqimlar foyda hisobotida xarajat sifatida olinadi
const EXPENSE_PURPOSES = PAY_PURPOSES_OUT.slice(2);

const DEFAULT_CATEGORIES = ['Yotoqxona', 'Mehmonxona', 'Oshxona', 'Divan va kreslo', 'Stol va stul', 'Shkaf', 'Bolalar mebeli', 'Ofis mebeli', 'Matras'];

// Har bir kategoriyaning turlari (Sozlamalarda o'zgartiriladi)
const DEFAULT_CATEGORY_TYPES = {
  Yotoqxona: ['Yotoqxona to\'plami', 'Karavot', 'Kiyim shkafi', 'Tumbochka', 'Komod', 'Trelyaj'],
  Mehmonxona: ['Mehmonxona to\'plami', 'TV tumba', 'Jurnal stoli', 'Vitrina', 'Kitob javoni', 'Komod'],
  Oshxona: ['Oshxona garnituri', 'Oshxona stoli', 'Oshxona stuli', 'Oshxona burchak divani', 'Bar stuli'],
  'Divan va kreslo': ['To\'g\'ri divan', 'Burchak divan', 'Divan-karavot', 'Kreslo', 'Kreslo-karavot', 'Puf'],
  'Stol va stul': ['Ovqat stoli', 'Stul', 'Stol-stul to\'plami', 'Jurnal stoli', 'Yozuv stoli'],
  Shkaf: ['Shkaf-kupe', 'Kiyim shkafi', 'Kitob shkafi', 'Dahliz shkafi', 'Burchak shkaf'],
  'Bolalar mebeli': ['Bolalar karavoti', 'Ikki qavatli karavot', 'Bolalar shkafi', 'Bolalar yozuv stoli', 'Beshik', 'Bolalar to\'plami'],
  'Ofis mebeli': ['Rahbar stoli', 'Xodim stoli', 'Kompyuter stoli', 'Majlislar stoli', 'Telefon tumba', 'Ofis kreslo', 'Rahbar kreslosi', 'Stul', 'Hujjat shkafi', 'Seyf', 'Resepshn'],
  Matras: ['Ortopedik matras', 'Prujinali matras', 'Prujinasiz matras', 'Bolalar matrasi', 'Topper'],
};

const DEFAULT_COLORS = ['Dub beliy', 'Belaya korona', 'Oq gladkiy', 'Dub votan', 'Dub sonoma', 'Dub kraft', "Yong'oq", 'Venge', 'Kulrang', 'Antratsit', 'Qora', 'Bej', 'Kapuchino', 'Oltin'];

const DEFAULT_MATERIALS = ['LDSP', 'MDF', 'DSP', 'Massiv (yog\'och)', 'Faner', 'Metall', 'Shisha', 'Oyna', 'Velyur', 'Ekokoja', 'Charm', 'Mato', 'Rattan', 'Plastik'];

// ---------- Ma'lumotlar ombori ----------

function emptyDb() {
  return {
    products: [],
    counterparties: [{ id: 'retail', name: 'Chakana xaridor', kind: 'customer', phone: '', address: '', inn: '', note: '' }],
    warehouses: [{ id: 'main', name: 'Asosiy ombor', address: '' }],
    docs: [],
    payments: [],
    categories: DEFAULT_CATEGORIES.slice(),
    categoryTypes: JSON.parse(JSON.stringify(DEFAULT_CATEGORY_TYPES)),
    materials: DEFAULT_MATERIALS.slice(),
    colors: DEFAULT_COLORS.slice(),
    currency: { rate: 0, date: '', source: '', updatedAt: '', manual: false },
    company: { name: 'KAO Mebel', phone: '', address: '' },
    telegram: { token: '', chatId: '', onReceipt: true, onNewProduct: true, showQty: true, log: [] },
    legacyUsers: {},
    users: [],
  };
}

// Saqlangan ma'lumotni joriy tuzilishga keltiramiz (yangi maydonlar standart qiymat oladi)
function normalizeDb(data) {
  const base = emptyDb();
  const out = Object.assign(base, data);
  out.telegram = Object.assign(emptyDb().telegram, data.telegram);
  out.company = Object.assign(emptyDb().company, data.company);
  return out;
}

let backend = null;
let db = emptyDb();
let syncState = { offline: false, message: '' };

// O'zgarishlar navbat bilan yuboriladi. Internet uzilsa — keyinroq qayta urinadi.
let commitQueue = Promise.resolve();
let retryTimer = null;

function commit() {
  commitQueue = commitQueue.then(async () => {
    try {
      await backend.commit(db);
      setSyncState(false);
      if (stockFromServer()) await refreshServerStock();
    } catch (e) {
      console.error(e);
      if (backend.kind === 'local') {
        alert("Saqlab bo'lmadi: " + e.message);
      } else if (e.fatal) {
        alert("Saqlanmadi: " + e.message + "\n\nMa'lumotlar serverdan qayta yuklanadi.");
        await loadData();
      } else {
        setSyncState(true, e.message);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(commit, 15000);
      }
    }
    render();
  });
  return commitQueue;
}

function save() {
  render();
  return commit();
}

function setSyncState(offline, message = '') {
  syncState = { offline, message };
  const el = $('#syncBanner');
  if (!el) return;
  el.hidden = !offline;
  el.textContent = offline ? "⚠️ Internet yo'q — o'zgarishlar hali serverga yuborilmadi. Ulanish tiklanganda avtomatik yuboriladi. Sahifani yopmang." : '';
}

window.addEventListener('online', () => { if (syncState.offline) commit(); });
window.addEventListener('beforeunload', (e) => {
  if (syncState.offline) { e.preventDefault(); e.returnValue = ''; }
});

// Sotuvchi xarid hujjatlarini ko'rmaydi — unga qoldiq serverda hisoblab beriladi
let serverStock = null;
const stockFromServer = () => backend?.kind === 'supabase' && !isAdmin();

async function refreshServerStock() {
  if (!stockFromServer()) { serverStock = null; return; }
  try {
    serverStock = await backend.stockLevels();
  } catch (e) {
    console.warn(e);
  }
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => {
    if (stockFromServer()) await refreshServerStock();
    render();
  }, 300);
}

async function loadData() {
  showLoading(true);
  try {
    db = normalizeDb(await backend.load(emptyDb()));
    await refreshServerStock();
    backend.subscribe(db, scheduleRender);
    if (isAdmin()) refreshStorageUsage();
    refreshRate();
  } finally {
    showLoading(false);
  }
}

function showLoading(on, text = 'Yuklanmoqda...') {
  $('#loading').hidden = !on;
  $('#loadingText').textContent = text;
}

// ---------- Foydalanuvchilar va kirish ----------

const ROLES = { admin: 'Administrator', seller: 'Sotuvchi' };

let me = null;
const isAdmin = () => me?.role === 'admin';

let authNeedsSetup = false;
let authMessage = '';

function renderAuth() {
  const setup = authNeedsSetup;
  const loginLabel = backend.loginLabel;
  const isEmail = backend.kind === 'supabase';
  $('#authSubtitle').textContent = setup ? 'Birinchi ishga tushirish: administrator hisobini yarating.' : 'Tizimga kirish';
  $('#authForm').innerHTML = `
    ${setup ? '<label>Ismingiz<input name="name" required autocomplete="name"></label>' : ''}
    <label>${loginLabel}<input name="login" required autocomplete="username" autocapitalize="none" ${isEmail ? 'type="email" inputmode="email"' : ''}></label>
    <label>Parol<input name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    ${setup ? '<label>Parolni takrorlang<input name="password2" type="password" required autocomplete="new-password"></label>' : ''}
    <div class="auth-error" id="authError">${esc(authMessage)}</div>
    <button class="primary" type="submit">${setup ? 'Yaratish va kirish' : 'Kirish'}</button>
    <div class="auth-server muted small">${esc(backend.label)} · <a href="#" id="serverLink">${backend.kind === 'local' ? 'Serverga ulanish' : "O'zgartirish"}</a></div>`;
  $('#serverLink').addEventListener('click', (e) => { e.preventDefault(); openServerSettings(); });
  (setup ? $('#authForm [name=name]') : $('#authForm [name=login]')).focus();
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  const err = (t) => { authMessage = t; $('#authError').textContent = t; };
  const login = (d.login || '').trim().toLowerCase();
  if (!login || !d.password) return err(`${backend.loginLabel} va parolni kiriting.`);
  const btn = $('#authForm button[type=submit]');
  btn.disabled = true;
  try {
    if (authNeedsSetup) {
      if (!d.name.trim()) return err('Ismingizni kiriting.');
      if (d.password.length < 6) return err("Parol kamida 6 belgidan iborat bo'lsin.");
      if (d.password !== d.password2) return err('Parollar mos emas.');
      me = await backend.createFirstAdmin({ name: d.name.trim(), login, password: d.password });
    } else {
      me = await backend.signIn(login, d.password);
    }
    authMessage = '';
    location.hash = '#dashboard';
    await loadData();
    render();
  } catch (ex) {
    err(ex.message);
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await backend.signOut();
  me = null;
  db = emptyDb();
  serverStock = null;
  authNeedsSetup = !(await backend.hasUsers().catch(() => true));
  render();
}

// Server (Supabase) ulanish oynasi — kirish oynasidan ham, Sozlamalardan ham ochiladi
function openServerSettings() {
  const cfg = serverConfig();
  openModal({
    title: 'Serverga ulanish',
    body: `<p class="muted">Supabase loyihangiz manzili va ochiq (anon / publishable) kaliti. Ularni Supabase panelida <b>Project Settings → API</b> bo'limidan nusxalang.</p>
      <div class="form-grid">
        ${field('Project URL', 'url', cfg.url, 'placeholder="https://xxxxxxxx.supabase.co" autocomplete="off"', 'full')}
        ${field('Anon / publishable key', 'key', cfg.key, 'autocomplete="off"', 'full')}
      </div>
      <p class="muted small">Bo'sh qoldirib saqlasangiz, dastur lokal rejimga (faqat shu qurilmada saqlash) qaytadi.</p>`,
    submitText: 'Tekshirish va saqlash',
    onSubmit: async (d) => {
      const next = { url: d.url.trim().replace(/\/+$/, ''), key: d.key.trim() };
      if (!next.url && !next.key) {
        saveServerConfig(null);
        location.reload();
        return;
      }
      try {
        await testServerConfig(next);
      } catch (e) {
        alert('Ulanib bo\'lmadi: ' + e.message);
        return false;
      }
      saveServerConfig(next);
      location.reload();
    },
  });
}

// ---------- Yordamchi funksiyalar ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// Mahalliy sana (toISOString UTC beradi — Toshkentda ertalab 5 gacha kechagi sana chiqib qoladi)
const localDate = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => localDate(new Date());
const num = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')) || 0;
const fmt = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const money = (v) => fmt(v) + " so'm";
// ---------- Valyuta ----------
// Narxlar so'mda yoki dollarda kiritiladi; dollardagi narx joriy kurs bo'yicha so'mga o'girib ko'rsatiladi.
const CUR_SIGN = { UZS: "so'm", USD: '$' };
const usdRate = () => num(db.currency?.rate);
const toUZS = (amount, cur, rate = usdRate()) => (cur === 'USD' ? amount * rate : amount);
// Etiketka narxi 1 000 so'mgacha yaxlitlanadi
const roundSom = (v) => Math.round(v / 1000) * 1000;
const priceUZS = (p, field) => (p.priceCurrency === 'USD' ? roundSom((p[field] || 0) * usdRate()) : p[field] || 0);
const salePriceUZS = (p) => priceUZS(p, 'salePrice');
const minPriceUZS = (p) => priceUZS(p, 'minPrice');
const fmtUsd = (v) => '$' + (Math.round(v * 100) / 100).toFixed(Number.isInteger(Math.round(v * 100) / 100) ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtRate = (v) => String(Math.round(v * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtIn = (v, cur) => (v === '' || v == null ? '' : cur === 'USD' ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : fmt(v));
// Dollar narxni so'mdagi ko'rinishi; kurs noma'lum bo'lsa — faqat dollar
const priceLabel = (p, field = 'salePrice') => (p.priceCurrency === 'USD'
  ? (usdRate() ? money(priceUZS(p, field)) : fmtUsd(p[field] || 0))
  : money(p[field] || 0));

// Kurs manbalari: avval O'zbekiston Markaziy banki, ishlamasa — ochiq valyuta API
async function fetchUsdRate() {
  try {
    const r = await fetch('https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/');
    const x = (await r.json())[0];
    if (num(x?.Rate) > 0) {
      const [dd, mm, yy] = String(x.Date || '').split('.');
      return { rate: num(x.Rate), date: yy ? `${yy}-${mm}-${dd}` : today(), source: "O'zbekiston Markaziy banki" };
    }
  } catch (e) { console.warn('CBU kursi:', e); }
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if (num(j?.rates?.UZS) > 0) return { rate: num(j.rates.UZS), date: today(), source: 'open.er-api.com' };
  } catch (e) { console.warn('Zaxira kurs:', e); }
  return null;
}

let rateBusy = false;
async function refreshRate(force = false) {
  const c = db.currency || {};
  if (rateBusy || (c.manual && !force)) return;
  if (!force && c.updatedAt && Date.now() - Date.parse(c.updatedAt) < 3 * 3600e3) return;
  rateBusy = true;
  try {
    const r = await fetchUsdRate();
    if (!r) {
      if (force) alert("Kursni olib bo'lmadi (internet yoki manba ishlamayapti). Kursni qo'lda kiritishingiz mumkin.");
      return;
    }
    db.currency = Object.assign({}, r, { updatedAt: new Date().toISOString(), manual: false });
    // Kurs umumiy sozlama — uni administrator saqlaydi, sotuvchida faqat ko'rinadi
    if (isAdmin()) await save(); else render();
  } finally {
    rateBusy = false;
  }
}
setInterval(() => { if (me) refreshRate(); }, 30 * 60e3);

// O'zbekistonda odatiy sana ko'rinishi: 27.10.2026
const fmtDate = (iso) => (iso ? `<span class="dt">${esc(String(iso).split('-').reverse().join('.'))}</span>` : '');
const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const UZ_DAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const longDate = (d) => `${d.getDate()}-${UZ_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${UZ_DAYS[d.getDay()]}`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const product = (id) => db.products.find((p) => p.id === id);
const party = (id) => db.counterparties.find((c) => c.id === id);
const warehouse = (id) => db.warehouses.find((w) => w.id === id);
const doc = (id) => db.docs.find((d) => d.id === id);

const PAY_PREFIX = { payIn: 'PK', payOut: 'PC' };

// Raqam serverda beriladi — bir vaqtda ishlayotgan sotuvchilarda takrorlanmaydi
function nextNo(type) {
  return backend.nextNo(type, DOC_TYPES[type]?.prefix || PAY_PREFIX[type] || 'P');
}

function linesSum(d) {
  return d.items.reduce((s, it) => s + it.qty * it.price, 0);
}
// Hujjat valyutasidagi summa (dollarda kiritilgan kirim uchun — dollarda)
function docTotalCur(d) {
  return Math.max(0, linesSum(d) - (d.discount || 0));
}
// Hisob-kitoblar so'mda: dollardagi hujjat o'z kunidagi kurs bo'yicha o'giriladi
function docTotal(d) {
  return d.currency === 'USD' ? docTotalCur(d) * (d.rate || 0) : docTotalCur(d);
}

function docPaid(d) {
  // Buyurtma bo'yicha oldindan to'lov uning asosidagi jo'natishga ham tegishli
  const ids = new Set([d.id]);
  if (d.orderId) ids.add(d.orderId);
  db.docs.forEach((x) => { if (x.orderId === d.id) ids.add(x.id); });
  return db.payments.filter((p) => ids.has(p.docId)).reduce((s, p) => s + p.amount, 0);
}

function emptyRow(cols, text) {
  return `<tr class="empty"><td colspan="${cols}">${text}</td></tr>`;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toCsv(rows) {
  // BOM — Excel o'zbek harflarini to'g'ri ochishi uchun
  return '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
}

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

// ---------- Hisob-kitoblar ----------

// excludeId — tahrirlanayotgan hujjatni hisobga olmaslik uchun
function applyDocStock(st, d, sign) {
  const t = DOC_TYPES[d.type];
  const add = (pid, wh, q) => {
    st[pid] = st[pid] || {};
    st[pid][wh] = (st[pid][wh] || 0) + sign * q;
  };
  if (t.move) {
    d.items.forEach((it) => { add(it.productId, d.warehouseId, -it.qty); add(it.productId, d.toWarehouseId, it.qty); });
  } else if (t.stock) {
    d.items.forEach((it) => add(it.productId, d.warehouseId, t.stock * it.qty));
  }
}

// excludeId — tahrirlanayotgan hujjatni hisobga olmaslik uchun
function computeStock(excludeId) {
  if (serverStock) {
    // Sotuvchi: serverdan kelgan qoldiq, tahrirlanayotgan hujjat ta'siri olib tashlanadi
    const st = JSON.parse(JSON.stringify(serverStock));
    const ex = excludeId && doc(excludeId);
    if (ex) applyDocStock(st, ex, -1);
    return st;
  }
  const st = {};
  db.docs.forEach((d) => { if (d.id !== excludeId) applyDocStock(st, d, 1); });
  return st;
}

function computeReserve() {
  const rs = {};
  db.docs.filter((d) => d.type === 'order' && RESERVING.includes(d.status)).forEach((d) => {
    d.items.forEach((it) => {
      rs[it.productId] = rs[it.productId] || {};
      rs[it.productId][d.warehouseId] = (rs[it.productId][d.warehouseId] || 0) + it.qty;
    });
  });
  return rs;
}

function qtyIn(map, pid, wh) {
  const m = map[pid] || {};
  if (wh) return m[wh] || 0;
  return Object.values(m).reduce((s, q) => s + q, 0);
}

// O'rtacha tannarx — qabul qilish va kirim hujjatlari bo'yicha o'rtacha tortilgan narx
function computeCost() {
  const acc = {};
  db.docs.filter((d) => d.type === 'receipt' || d.type === 'enter').forEach((d) => {
    d.items.forEach((it) => {
      if (!it.price) return;
      const a = (acc[it.productId] = acc[it.productId] || { q: 0, s: 0 });
      a.q += it.qty;
      a.s += it.qty * (d.currency === 'USD' ? it.price * (d.rate || 0) : it.price);
    });
  });
  const cost = {};
  db.products.forEach((p) => {
    const a = acc[p.id];
    cost[p.id] = a && a.q ? a.s / a.q : toUZS(p.buyPrice || 0, p.priceCurrency);
  });
  return cost;
}

// Musbat — kontragent bizga qarzdor, manfiy — biz qarzdormiz
function partyBalance(id) {
  let b = 0;
  db.docs.forEach((d) => {
    const t = DOC_TYPES[d.type];
    if (d.counterpartyId === id && t.money) b += t.money * docTotal(d);
  });
  db.payments.forEach((p) => {
    if (p.counterpartyId === id) b += p.dir === 'in' ? -p.amount : p.amount;
  });
  return b;
}

function cashBalances() {
  const b = { cash: 0, card: 0, bank: 0 };
  db.payments.forEach((p) => { b[p.method] = (b[p.method] || 0) + (p.dir === 'in' ? p.amount : -p.amount); });
  return b;
}

let ctx = {};
function refreshCtx() {
  ctx = { stock: computeStock(), reserve: computeReserve(), cost: computeCost() };
}

// ---------- Modal oyna ----------

let modalState = null;

function openModal({ title, body, onSubmit, onOpen, extra = [], wide = false, submitText = 'Saqlash' }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modal').classList.toggle('wide', wide);
  $('#modalSubmit').textContent = submitText;
  $('#modalSubmit').hidden = !onSubmit;
  $('#modalExtra').innerHTML = extra.map((b, i) => `<button type="button" class="${b.cls || ''}" data-extra="${i}">${esc(b.label)}</button>`).join('');
  modalState = { onSubmit, extra };
  if (!$('#modal').open) $('#modal').showModal();
  $('#modalBody').scrollTop = 0;
  if (onOpen) onOpen();
  hydratePhotos($('#modalBody'));
}

function closeModal() {
  $('#modal').close();
}

$('#modalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const bad = $$('[required]', form).find((el) => !el.value.trim());
  if (bad) {
    bad.focus();
    bad.classList.add('invalid');
    return;
  }
  const data = Object.fromEntries(new FormData(form).entries());
  // Ikki marta bosilib, hujjat ikki marta yaratilmasligi uchun
  if (modalState.busy) return;
  modalState.busy = true;
  $('#modalSubmit').disabled = true;
  let result;
  try {
    // onSubmit false qaytarsa oyna yopilmaydi
    result = modalState.onSubmit ? await modalState.onSubmit(data) : undefined;
  } catch (ex) {
    console.error(ex);
    alert(ex.message);
    result = false;
  } finally {
    modalState.busy = false;
    $('#modalSubmit').disabled = false;
  }
  if (result !== false) closeModal();
});
$('#modalCancel').addEventListener('click', closeModal);
$('#modalExtra').addEventListener('click', (e) => {
  const b = e.target.closest('[data-extra]');
  if (b) modalState.extra[b.dataset.extra].onClick();
});

function field(label, name, value = '', attrs = '', cls = '') {
  return `<label class="${cls}">${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
}

function selectField(label, name, options, value, cls = '', attrs = '') {
  const opts = options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('');
  return `<label class="${cls}">${label}<select name="${name}" ${attrs}>${opts}</select></label>`;
}

function textArea(label, name, value = '', cls = 'full') {
  return `<label class="${cls}">${label}<textarea name="${name}" rows="2">${esc(value)}</textarea></label>`;
}

// Narx katagi: yozish paytida 3 xonadan probel qo'yiladi, yonida valyuta belgisi turadi
function moneyField(label, name, value, cur = 'UZS', attrs = '', cls = '') {
  return `<label class="${cls}">${label}<span class="money-wrap"><input name="${name}" class="money" data-cur="${cur}" inputmode="decimal" autocomplete="off" value="${esc(fmtIn(value, cur))}" ${attrs}><span class="cur">${CUR_SIGN[cur]}</span></span></label>`;
}

function formatMoneyInput(el) {
  const dec = el.dataset.cur === 'USD';
  const keep = dec ? /[^\d.]/g : /\D/g;
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret).replace(',', '.').replace(keep, '').length;
  let raw = el.value.replace(',', '.').replace(keep, '');
  if (dec && raw.includes('.')) {
    const [i, ...rest] = raw.split('.');
    raw = i + '.' + rest.join('').slice(0, 2);
  }
  const [ip, dp] = raw.split('.');
  const out = ip.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (dp !== undefined ? '.' + dp : '');
  if (out === el.value) return;
  el.value = out;
  let i = 0;
  for (let n = 0; i < out.length && n < before; i++) if (out[i] !== ' ') n++;
  el.setSelectionRange(i, i);
}

function setMoneyCurrency(el, cur) {
  el.dataset.cur = cur;
  const sign = el.parentElement.querySelector('.cur');
  if (sign) sign.textContent = CUR_SIGN[cur];
  formatMoneyInput(el);
}

document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('money')) formatMoneyInput(e.target);
}, true);

// Majburiy savol: Telegram guruhga yuborilsinmi? Javobsiz saqlab bo'lmaydi
function tgQuestion() {
  return `<div class="field full tg-ask" id="tgAsk">
    <span class="field-label">${icon('send')} Telegram guruhga yuborilsinmi? <b class="debt">*</b></span>
    <div class="seg" role="radiogroup">
      <label><input type="radio" name="tgPost" value="yes"><span>${icon('check')}Ha, yuborilsin</span></label>
      <label><input type="radio" name="tgPost" value="no"><span>Yo'q, yuborilmasin</span></label>
    </div>
    <span class="tg-ask-hint debt small">Iltimos, tanlang: yuborilsinmi yoki yo'qmi.</span>
  </div>`;
}

function tgAnswered(d) {
  if (d.tgPost) return true;
  const el = $('#tgAsk');
  el.classList.add('invalid');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('input', el).focus();
  return false;
}

document.addEventListener('change', (e) => {
  if (e.target.name === 'tgPost') $('#tgAsk')?.classList.remove('invalid');
});

const whOptions = () => db.warehouses.map((w) => [w.id, w.name]);

// ---------- Mahsulotlar ----------

const MAX_PHOTOS = 5;

function productForm(p = {}, readonly = false) {
  const cats = [['', '—'], ...db.categories.map((c) => [c, c])];
  return `<div class="product-form">
    <div class="photo-box">
      <div class="photo-list" id="photoList"></div>
      ${readonly ? '' : `<label class="filebtn">${icon('camera')}Rasm qo'shish<input type="file" id="photoInput" accept="image/*" multiple hidden></label>
      <div class="muted small">${MAX_PHOTOS} tagacha. Birinchisi — asosiy (Telegram va ro'yxatda). Asosiy qilish uchun rasm ustiga bosing.</div>`}
    </div>
    <div class="form-grid">
      ${field('Nomi *', 'name', p.name, 'required', 'full')}
      ${sizeField(p.size)}
      ${field('Kod / artikul', 'code', p.code)}
      ${selectField('Kategoriya', 'category', cats, p.category || '', '', 'id="catSel"')}
      <label>Turi<select name="type" id="typeSel">${typeOptions(p.category, p.type)}</select>
        <input name="typeNew" id="typeNew" placeholder="Yangi tur nomi" hidden></label>
      <label>Ishlab chiqaruvchi / ta'minotchi<select name="makerId" id="makerSel">${makerOptions(p)}</select>
        <input name="makerNew" id="makerNew" placeholder="Fabrika yoki ta'minotchi nomi" hidden></label>
      <div class="field full"><span class="field-label">Rangi</span>${chipPicker('colorChips', db.colors, p.color, '+ Yangi rang')}
        <input type="hidden" name="color" value="${esc(p.color || '')}"></div>
      ${field('Ishlab chiqarilgan joyi', 'origin', p.origin, 'placeholder="O\'zbekiston, Toshkent / Turkiya..."')}
      ${field("O'lchov birligi", 'unit', p.unit || 'dona')}
      ${field('Minimal qoldiq', 'minQty', p.minQty ?? 1, 'type="number" min="0"')}
      <div class="field full price-block">
        <span class="field-label">Narxlar valyutasi</span>
        <div class="seg seg-sm" role="radiogroup">
          <label><input type="radio" name="priceCurrency" value="UZS" ${p.priceCurrency !== 'USD' ? 'checked' : ''}><span>So'm</span></label>
          <label><input type="radio" name="priceCurrency" value="USD" ${p.priceCurrency === 'USD' ? 'checked' : ''}><span>Dollar ($)</span></label>
        </div>
        <div class="price-grid">
          ${isAdmin() ? moneyField('Kelish narxi', 'buyPrice', p.buyPrice ?? '', p.priceCurrency || 'UZS') : ''}
          ${moneyField('Sotish narxi (etiketka) *', 'salePrice', p.salePrice ?? '', p.priceCurrency || 'UZS', 'required')}
          ${moneyField('Eng kam narx (savdolashish chegarasi)', 'minPrice', p.minPrice ?? '', p.priceCurrency || 'UZS')}
        </div>
        <div class="price-preview muted small" id="pricePreview"></div>
      </div>
      ${p.id ? '' : field("Boshlang'ich qoldiq", 'initQty', 0, 'type="number" min="0"')}
      ${p.id ? '' : selectField('Ombor', 'initWh', whOptions(), db.warehouses[0]?.id)}
      ${textArea('Tavsif', 'note', p.note)}
      ${!p.id && !readonly ? tgQuestion() : ''}
    </div>
  </div>`;
}

// Ishlab chiqaruvchi — ta'minotchilar ro'yxatidan (Kontragentlar) tanlanadi yoki shu yerda qo'shiladi
function makerOptions(p) {
  const list = db.counterparties.filter((c) => c.kind === 'supplier' || c.kind === 'both').map((c) => [c.id, c.name]);
  const known = list.some(([id]) => id === p.supplierId);
  if (p.maker && !known) list.push([p.supplierId || '__keep', p.maker]);
  const cur = known ? p.supplierId : p.maker ? p.supplierId || '__keep' : '';
  return [['', '—'], ...list, ...(isAdmin() ? [['__new', "+ Yangi ishlab chiqaruvchi..."]] : [])]
    .map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function bindPriceBlock() {
  const radios = $$('#modalBody [name=priceCurrency]');
  const inputs = ['buyPrice', 'salePrice', 'minPrice'].map((n) => $(`#modalBody [name=${n}]`)).filter(Boolean);
  const preview = () => {
    const cur = radios.find((r) => r.checked)?.value || 'UZS';
    const sale = num($('#modalBody [name=salePrice]').value);
    const min = num($('#modalBody [name=minPrice]').value);
    const box = $('#pricePreview');
    if (cur !== 'USD') { box.textContent = ''; return; }
    box.innerHTML = usdRate()
      ? `Joriy kurs: 1 $ = ${fmtRate(usdRate())} so'm → etiketka: <b>${money(roundSom(sale * usdRate()))}</b>${min ? ` · eng kam: <b>${money(roundSom(min * usdRate()))}</b>` : ''}. So'mdagi narx kurs o'zgarishi bilan avtomatik yangilanadi.`
      : "Dollar kursi hali olinmagan — Sozlamalar → Valyuta kursi.";
  };
  radios.forEach((r) => r.addEventListener('change', () => { inputs.forEach((i) => setMoneyCurrency(i, r.value)); preview(); }));
  inputs.forEach((i) => i.addEventListener('input', preview));
  preview();
}

// Kartochkadagi rasmlar: saqlanganlari ({path, thumb}) va hali yuklanmagan yangilari ({file, url})
let photoEdit = null;

function renderPhotoList(readonly) {
  const box = $('#photoList');
  if (!box) return;
  box.innerHTML = photoEdit.items.length ? photoEdit.items.map((ph, i) => `<div class="ph ${i === 0 ? 'main' : ''}">
      <img ${ph.file ? `src="${ph.url}"` : `data-photo="${esc(ph.thumb)}"`} data-i="${i}" alt="">
      ${i === 0 ? '<span class="ph-main">Asosiy</span>' : ''}
      ${readonly ? '' : `<button type="button" class="ph-del" data-i="${i}" title="Olib tashlash">×</button>`}
    </div>`).join('') : `<div class="photo-empty">${icon('camera')}<span>Rasm yo'q</span></div>`;
  hydratePhotos(box);
}

// O'lcham uch katakda: raqamdan keyin probel (yoki x, *, vergul, Enter) — keyingi katakka o'tadi
const DIM_NAMES = ['Uzunlik', 'Kenglik', 'Balandlik'];

function sizeField(size) {
  const parts = String(size || '').split(/[x×х*,\s]+/i).filter(Boolean);
  return `<label class="wide2">O'lchami (sm): uzunlik × kenglik × balandlik
    <div class="dims">
      ${DIM_NAMES.map((n, i) => `${i ? '<span class="dim-x">×</span>' : ''}<input class="dim" inputmode="decimal" enterkeyhint="${i < 2 ? 'next' : 'done'}" placeholder="${n}" aria-label="${n}" value="${esc(parts[i] === '?' ? '' : parts[i] || '')}">`).join('')}
    </div>
    <input type="hidden" name="size" value="${esc(size || '')}">
  </label>`;
}

function bindSizeField() {
  const dims = $$('#modalBody .dim');
  const hidden = $('#modalBody input[name=size]');
  if (!dims.length) return;
  const sync = () => {
    const vals = dims.map((d) => d.value.trim());
    hidden.value = vals.some(Boolean) ? vals.map((v) => v || '?').join(' × ') : '';
  };
  dims.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if ([' ', 'x', 'X', 'х', 'Х', '*', ',', 'Enter'].includes(e.key)) {
        e.preventDefault();
        if (dims[i + 1]) dims[i + 1].focus();
        else if (e.key === 'Enter') input.blur();
      } else if (e.key === 'Backspace' && !input.value && dims[i - 1]) {
        e.preventDefault();
        dims[i - 1].focus();
      }
    });
    input.addEventListener('input', () => {
      // "200x160x45" nusxalab joylansa — kataklarga taqsimlaymiz
      const parts = input.value.split(/[x×х*,\s]+/i).filter(Boolean);
      if (parts.length > 1) {
        parts.slice(0, dims.length - i).forEach((v, k) => { dims[i + k].value = v; });
        dims[Math.min(i + parts.length, dims.length) - 1].focus();
      }
      input.value = input.value.replace(/[^\d.]/g, '');
      sync();
    });
  });
}

// Turi — tanlangan kategoriyaning o'z turlari
function typeOptions(cat, value) {
  const types = (db.categoryTypes[cat] || []).slice();
  if (value && !types.includes(value)) types.push(value);
  return [['', '—'], ...types.map((t) => [t, t]), ...(isAdmin() ? [['__new', '+ Yangi tur...']] : [])]
    .map(([v, t]) => `<option value="${esc(v)}" ${v === (value || '') ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function bindTypeField() {
  const cat = $('#catSel');
  const type = $('#typeSel');
  const fresh = $('#typeNew');
  const toggle = () => {
    fresh.hidden = type.value !== '__new';
    if (!fresh.hidden) fresh.focus();
  };
  cat.addEventListener('change', () => { type.innerHTML = typeOptions(cat.value, ''); toggle(); });
  type.addEventListener('change', toggle);
}

// Tanlash tugmachalari (rang): bir nechtasini belgilash mumkin, "Dub beliy, Oq gladkiy" ko'rinishida saqlanadi
const splitList = (str) => String(str || '').split(',').map((x) => x.trim()).filter(Boolean);

function chipPicker(id, options, value, addLabel) {
  const selected = splitList(value);
  const all = [...options, ...selected.filter((m) => !options.includes(m))];
  return `<div class="chips chips-pick" id="${id}">
    ${all.map((m) => `<button type="button" class="chip ${selected.includes(m) ? 'on' : ''}" data-act="chipToggle" data-v="${esc(m)}">${esc(m)}</button>`).join('')}
    ${isAdmin() ? `<input class="chip-add" placeholder="${addLabel}" enterkeyhint="done">` : ''}
  </div>`;
}

function syncChips(box) {
  const hidden = box?.closest('.field')?.querySelector('input[type=hidden]');
  if (hidden) hidden.value = $$('.chip.on', box).map((c) => c.dataset.v).join(', ');
}

function bindProductForm(p, readonly = false) {
  photoEdit = { items: (p.photos || []).slice(), removed: [] };
  renderPhotoList(readonly);
  if (readonly) return;
  bindSizeField();
  bindTypeField();
  bindPriceBlock();
  const maker = $('#makerSel');
  maker.addEventListener('change', () => {
    $('#makerNew').hidden = maker.value !== '__new';
    if (maker.value === '__new') $('#makerNew').focus();
  });
  $('#photoInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files).slice(0, MAX_PHOTOS - photoEdit.items.length);
    if (e.target.files.length > files.length) alert(`Ko'pi bilan ${MAX_PHOTOS} ta rasm.`);
    files.forEach((file) => photoEdit.items.push({ file, url: URL.createObjectURL(file) }));
    e.target.value = '';
    renderPhotoList();
  });
  $('#photoList').addEventListener('click', (e) => {
    const del = e.target.closest('.ph-del');
    const img = e.target.closest('img[data-i]');
    if (del) {
      const [ph] = photoEdit.items.splice(+del.dataset.i, 1);
      if (ph.file) URL.revokeObjectURL(ph.url);
      else photoEdit.removed.push(ph.path, ph.thumb);
    } else if (img && +img.dataset.i > 0) {
      const [ph] = photoEdit.items.splice(+img.dataset.i, 1);
      photoEdit.items.unshift(ph);
    } else return;
    renderPhotoList();
  });
}

// Yangi rasmlarni yuklaydi va mahsulotga yoziladigan ro'yxatni qaytaradi
async function uploadPendingPhotos() {
  const btn = $('#modalSubmit');
  const out = [];
  const pending = photoEdit.items.filter((ph) => ph.file).length;
  let done = 0;
  for (const ph of photoEdit.items) {
    if (!ph.file) { out.push({ path: ph.path, thumb: ph.thumb }); continue; }
    btn.textContent = `Rasm yuklanmoqda ${++done}/${pending}...`;
    out.push(await backend.uploadPhoto(ph.file));
    URL.revokeObjectURL(ph.url);
  }
  return out;
}

async function hydratePhotos(root = document) {
  for (const img of $$('img[data-photo]', root)) {
    const path = img.dataset.photo;
    img.removeAttribute('data-photo');
    backend.photoUrl(path).then((u) => { if (u) img.src = u; }).catch(() => {});
  }
}

function readProduct(d, p) {
  const type = d.type === '__new' ? d.typeNew.trim() : d.type;
  // Yangi tur va materiallar keyingi safar ro'yxatda tursin
  if (type && d.category) {
    const list = (db.categoryTypes[d.category] = db.categoryTypes[d.category] || []);
    if (!list.includes(type)) list.push(type);
  }
  splitList(d.color).forEach((c) => { if (!db.colors.includes(c)) db.colors.push(c); });
  // Ishlab chiqaruvchi: ro'yxatdan, yangi (ta'minotchi sifatida qo'shiladi) yoki eski yozuv
  let supplierId = d.makerId;
  let maker = '';
  if (d.makerId === '__new' && d.makerNew.trim()) {
    const c = { id: uid(), name: d.makerNew.trim(), kind: 'supplier', phone: '', address: '', inn: '', note: '', created: today() };
    db.counterparties.push(c);
    supplierId = c.id;
    maker = c.name;
  } else if (d.makerId === '__keep' || d.makerId === '__new') {
    supplierId = p.supplierId || '';
    maker = p.maker || '';
  } else {
    maker = party(d.makerId)?.name || '';
  }
  return Object.assign(p, {
    name: d.name.trim(),
    code: d.code.trim(),
    category: d.category,
    type,
    size: d.size.trim(),
    color: d.color.trim(),
    origin: d.origin.trim(),
    supplierId: supplierId || '',
    maker,
    unit: d.unit.trim() || 'dona',
    priceCurrency: d.priceCurrency === 'USD' ? 'USD' : 'UZS',
    // Sotuvchi kelish narxini ko'rmaydi — uning formasida bu maydon yo'q
    buyPrice: d.buyPrice !== undefined ? num(d.buyPrice) : p.buyPrice || 0,
    salePrice: num(d.salePrice),
    minPrice: num(d.minPrice),
    minQty: num(d.minQty),
    note: d.note.trim(),
  });
}

async function withPhotos(fn) {
  const btn = $('#modalSubmit');
  btn.disabled = true;
  try {
    const photos = await uploadPendingPhotos();
    await fn(photos);
    if (photoEdit.removed.length) backend.deletePhotos(photoEdit.removed);
  } catch (e) {
    alert(e.message);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Saqlash';
  }
}

function newProduct() {
  openModal({
    title: 'Yangi mahsulot',
    body: productForm(),
    wide: true,
    onOpen: () => bindProductForm({}),
    onSubmit: (d) => (!tgAnswered(d) ? false : withPhotos(async (photos) => {
      const p = readProduct(d, { id: uid(), created: today(), photos });
      db.products.push(p);
      const qty = num(d.initQty);
      let entry = null;
      if (qty > 0) {
        entry = {
          id: uid(), type: 'enter', no: await nextNo('enter'), date: today(), warehouseId: d.initWh, userId: me.id,
          items: [{ productId: p.id, qty, price: p.buyPrice }], note: "Boshlang'ich qoldiq",
          currency: p.priceCurrency, rate: p.priceCurrency === 'USD' ? usdRate() : undefined,
        };
        db.docs.push(entry);
      }
      await save();
      if (d.tgPost === 'yes') telegramPostProducts([p.id], true);
    })),
  });
}

function editProduct(id) {
  const p = product(id);
  if (!isAdmin()) {
    // Sotuvchi kartochkani faqat ko'radi
    openModal({ title: p.name, body: `<fieldset disabled>${productForm(p, true)}</fieldset>`, wide: true, onOpen: () => bindProductForm(p, true) });
    return;
  }
  openModal({
    title: 'Mahsulot kartochkasi',
    body: productForm(p),
    wide: true,
    onOpen: () => bindProductForm(p),
    extra: [
      { label: 'Telegramga yuborish', onClick: () => telegramPostProducts([id], true) },
      { label: 'Harakatlar tarixi', onClick: () => productHistory(id) },
    ],
    onSubmit: (d) => withPhotos(async (photos) => {
      readProduct(d, p);
      p.photos = photos;
      await save();
    }),
  });
}

function deleteProduct(id) {
  const p = product(id);
  if (db.docs.some((d) => d.items.some((it) => it.productId === id))) {
    if (confirm(`"${p.name}" hujjatlarda ishlatilgan, uni o'chirib bo'lmaydi. Arxivga o'tkazilsinmi?`)) {
      p.archived = true;
      save();
    }
    return;
  }
  if (!confirm(`"${p.name}" o'chirilsinmi?`)) return;
  db.products = db.products.filter((x) => x.id !== id);
  save().then(() => backend.deletePhotos((p.photos || []).flatMap((ph) => [ph.path, ph.thumb])));
}

function productHistory(id) {
  const p = product(id);
  const rows = [];
  db.docs.forEach((d) => {
    const t = DOC_TYPES[d.type];
    d.items.filter((it) => it.productId === id).forEach((it) => {
      let delta = t.stock * it.qty;
      let wh = warehouse(d.warehouseId)?.name;
      if (t.move) { delta = 0; wh += ' → ' + (warehouse(d.toWarehouseId)?.name || ''); }
      rows.push({ d, t, it, delta, wh });
    });
  });
  rows.sort((a, b) => a.d.date.localeCompare(b.d.date));
  openModal({
    title: `Harakatlar: ${p.name}`,
    wide: true,
    body: `<table><thead><tr><th>Sana</th><th>Hujjat</th><th>Ombor</th><th class="num">Soni</th><th class="num">Narx</th><th class="num">Qoldiqqa ta'siri</th></tr></thead><tbody>
      ${rows.length ? rows.map(({ d, t, it, delta, wh }) => `<tr><td>${fmtDate(d.date)}</td><td>${esc(t.one)} ${esc(d.no)}</td><td>${esc(wh)}</td>
        <td class="num">${it.qty}</td><td class="num">${money(it.price)}</td><td class="num">${delta > 0 ? '+' : ''}${delta || '—'}</td></tr>`).join('') : emptyRow(6, "Harakat yo'q")}
      </tbody></table>`,
  });
}

// ---------- Kontragentlar ----------

const KINDS = { customer: 'Mijoz', supplier: "Ta'minotchi", both: "Mijoz va ta'minotchi" };

function partyForm(c = {}) {
  return `<div class="form-grid">
    ${field('Nomi / F.I.O. *', 'name', c.name, 'required', 'full')}
    ${selectField('Turi', 'kind', isAdmin() ? Object.entries(KINDS) : [['customer', KINDS.customer]], c.kind || 'customer')}
    ${field('Telefon', 'phone', c.phone, 'placeholder="+998 90 123 45 67"')}
    ${field('STIR (INN)', 'inn', c.inn)}
    ${field('Manzil', 'address', c.address, '', 'full')}
    ${textArea('Izoh', 'note', c.note)}
  </div>`;
}

function readParty(d, c) {
  return Object.assign(c, { name: d.name.trim(), kind: d.kind, phone: d.phone.trim(), inn: d.inn.trim(), address: d.address.trim(), note: d.note.trim() });
}

function newParty(kind) {
  openModal({
    title: 'Yangi kontragent',
    body: partyForm({ kind }),
    onSubmit: (d) => {
      db.counterparties.push(readParty(d, { id: uid(), created: today() }));
      save();
    },
  });
}

function editParty(id) {
  const c = party(id);
  openModal({
    title: 'Kontragent',
    body: partyForm(c),
    extra: [{ label: "O'zaro hisob-kitob", onClick: () => partyStatement(id) }],
    onSubmit: (d) => {
      readParty(d, c);
      save();
    },
  });
}

function deleteParty(id) {
  if (id === 'retail' || db.docs.some((d) => d.counterpartyId === id) || db.payments.some((p) => p.counterpartyId === id)) {
    alert("Bu kontragent bo'yicha hujjat yoki to'lovlar bor, uni o'chirib bo'lmaydi.");
    return;
  }
  if (!confirm("Kontragent o'chirilsinmi?")) return;
  db.counterparties = db.counterparties.filter((c) => c.id !== id);
  save();
}

function partyStatement(id) {
  const c = party(id);
  const rows = [];
  db.docs.forEach((d) => {
    const t = DOC_TYPES[d.type];
    if (d.counterpartyId === id && t.money) rows.push({ date: d.date, title: `${t.one} ${d.no}`, delta: t.money * docTotal(d) });
  });
  db.payments.forEach((p) => {
    if (p.counterpartyId === id) rows.push({ date: p.date, title: `${p.dir === 'in' ? "Kirim to'lovi" : "Chiqim to'lovi"} ${p.no} (${PAY_METHODS[p.method]})`, delta: p.dir === 'in' ? -p.amount : p.amount });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let bal = 0;
  const body = rows.map((r) => {
    bal += r.delta;
    return `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.title)}</td><td class="num">${r.delta > 0 ? money(r.delta) : ''}</td><td class="num">${r.delta < 0 ? money(-r.delta) : ''}</td><td class="num">${money(bal)}</td></tr>`;
  }).join('');
  openModal({
    title: `O'zaro hisob-kitob: ${c.name}`,
    wide: true,
    body: `<p class="muted">Debet — kontragent qarzini oshiradi (sotuv, ta'minotchiga qaytarish, bizning to'lov). Kredit — kamaytiradi.</p>
      <table><thead><tr><th>Sana</th><th>Hujjat</th><th class="num">Debet</th><th class="num">Kredit</th><th class="num">Qoldiq</th></tr></thead>
      <tbody>${body || emptyRow(5, "Operatsiya yo'q")}</tbody></table>
      <p class="total-line">${balanceText(bal)}</p>`,
    extra: [{ label: 'Chop etish', onClick: () => window.print() }],
  });
}

function balanceText(b) {
  if (b > 0) return `Bizga qarzi: <b class="debt">${money(b)}</b>`;
  if (b < 0) return `Bizning qarzimiz: <b class="warn">${money(-b)}</b>`;
  return 'Qarz yo\'q';
}

// ---------- Hujjatlar ----------

function partyOptions(kind) {
  const list = db.counterparties.filter((c) => !kind || c.kind === kind || c.kind === 'both');
  return [['', '— tanlang —'], ...list.map((c) => [c.id, c.name + (c.phone ? ` (${c.phone})` : '')])];
}

function itemRowHtml(t, it = {}, cur = 'UZS') {
  const opts = db.products.filter((p) => !p.archived || p.id === it.productId).map((p) =>
    `<option value="${p.id}" ${p.id === it.productId ? 'selected' : ''}>${esc(p.name)}${p.code ? ' · ' + esc(p.code) : ''}</option>`).join('');
  return `<tr>
    <td><select class="it-product"><option value="">— mahsulot —</option>${opts}</select></td>
    <td class="it-avail muted num"></td>
    <td><input class="it-qty" type="number" min="1" step="1" value="${it.qty || 1}"></td>
    <td><span class="money-wrap"><input class="it-price money" data-cur="${cur}" inputmode="decimal" value="${esc(fmtIn(it.price ?? '', cur))}"><span class="cur">${CUR_SIGN[cur]}</span></span>
      <div class="it-min muted small"></div></td>
    <td class="it-sum num"></td>
    <td><button type="button" class="small danger it-remove" title="O'chirish">×</button></td>
  </tr>`;
}

function docForm(type, d) {
  const t = DOC_TYPES[type];
  let head = field('Sana', 'date', d.date, 'type="date" required');
  if (t.party) {
    head += selectField(t.party === 'supplier' ? "Ta'minotchi *" : 'Mijoz *', 'counterpartyId', partyOptions(t.party), d.counterpartyId || (t.party === 'customer' ? 'retail' : ''));
    head += field(`yoki yangi ${t.party === 'supplier' ? "ta'minotchi" : 'mijoz'}`, 'newPartyName', '', 'placeholder="Nomi"');
    head += field('Telefoni', 'newPartyPhone', '');
  }
  head += selectField(t.move ? 'Qaysi ombordan' : 'Ombor', 'warehouseId', whOptions(), d.warehouseId || db.warehouses[0].id);
  if (t.move) head += selectField('Qaysi omborga', 'toWarehouseId', whOptions(), d.toWarehouseId || (db.warehouses[1] || db.warehouses[0]).id);
  if (t.statuses) head += selectField('Holati', 'status', Object.entries(t.statuses), d.status || Object.keys(t.statuses)[0]);
  const cur = t.fx && d.currency === 'USD' ? 'USD' : 'UZS';
  if (t.fx) {
    head += `<div class="field"><span class="field-label">Valyuta</span><div class="seg seg-sm" role="radiogroup">
        <label><input type="radio" name="currency" value="UZS" ${cur === 'UZS' ? 'checked' : ''}><span>So'm</span></label>
        <label><input type="radio" name="currency" value="USD" ${cur === 'USD' ? 'checked' : ''}><span>Dollar ($)</span></label></div></div>
      <label id="rateField" ${cur === 'USD' ? '' : 'hidden'}>Kurs: 1 $ =<span class="money-wrap"><input name="rate" class="money" data-cur="USD" inputmode="decimal" value="${esc(fmtIn(d.rate || usdRate() || '', 'USD'))}"><span class="cur">so'm</span></span></label>`;
  }
  if (t.delivery) {
    head += field('Yetkazish sanasi', 'deliveryDate', d.deliveryDate, 'type="date"');
    head += field('Yetkazish manzili', 'address', d.address, '', 'wide2');
  }

  let foot = '';
  if (t.money || type === 'order' || type === 'purchaseOrder') foot += moneyField('Chegirma', 'discount', d.discount || '', cur, 'placeholder="0"');
  if (!d.id && t.pay) {
    foot += moneyField(t.pay === 'in' ? "Hozir to'landi" : "Hozir to'ladik", 'payNow', d.payNow ?? '', 'UZS', 'placeholder="0"');
    foot += selectField("To'lov usuli", 'payMethod', Object.entries(PAY_METHODS), 'cash');
  }
  foot += textArea('Izoh', 'note', d.note);
  if (!d.id && t.tgAsk) foot += tgQuestion();

  const items = (d.items && d.items.length ? d.items : [{}]).map((it) => itemRowHtml(t, it, cur)).join('');
  return `<div class="form-grid">${head}</div>
    <h4>Mahsulotlar</h4>
    <div class="table-wrap"><table class="items-table">
      <thead><tr><th>Mahsulot</th><th class="num">Omborda</th><th>Soni</th><th>Narxi</th><th class="num">Summa</th><th></th></tr></thead>
      <tbody id="itemRows">${items}</tbody>
    </table></div>
    <button type="button" class="small" id="addItemRow">${icon('plus')}Qator qo'shish</button>
    <div class="form-grid" style="margin-top:12px">${foot}</div>
    <div class="total-line">Jami: <b id="docTotal">0</b></div>`;
}

function bindDocForm(type, editingId) {
  const t = DOC_TYPES[type];
  const stock = computeStock(editingId);
  const body = $('#itemRows');
  const whSel = $('#modalForm [name=warehouseId]');
  const discount = $('#modalForm [name=discount]');
  const curRadios = $$('#modalBody [name=currency]');
  const rateInput = $('#modalBody [name=rate]');
  const curOf = () => curRadios.find((r) => r.checked)?.value || 'UZS';
  const rateOf = () => num(rateInput?.value) || usdRate();
  const round2 = (v) => Math.round(v * 100) / 100;

  // Mahsulot tanlanganda narxni hujjat valyutasida qo'yamiz
  const defaultPrice = (p) => {
    if (t.price === 'sale') return salePriceUZS(p);
    const cur = curOf();
    if (cur === 'USD' && p.priceCurrency === 'USD' && p.buyPrice) return p.buyPrice;
    const som = ctx.cost[p.id] || toUZS(p.buyPrice || 0, p.priceCurrency);
    return cur === 'USD' ? (rateOf() ? round2(som / rateOf()) : 0) : Math.round(som);
  };

  const recalc = () => {
    let sum = 0;
    $$('tr', body).forEach((tr) => {
      const p = product($('.it-product', tr).value);
      const priceEl = $('.it-price', tr);
      const line = num($('.it-qty', tr).value) * num(priceEl.value);
      sum += line;
      $('.it-sum', tr).textContent = p ? fmtIn(round2(line), curOf()) : '';
      $('.it-avail', tr).textContent = p ? qtyIn(stock, p.id, whSel.value) : '';
      // Savdoda: sotuvchi eng kam narxni ko'radi, undan pastga tushsa ogohlantiriladi
      const min = p && t.price === 'sale' && type !== 'salesReturn' ? minPriceUZS(p) : 0;
      $('.it-min', tr).textContent = min ? `eng kami: ${fmt(min)}` : '';
      priceEl.classList.toggle('below-min', !!min && num(priceEl.value) < min);
    });
    const total = Math.max(0, sum - num(discount?.value));
    $('#docTotal').innerHTML = curOf() === 'USD'
      ? `${fmtUsd(total)} <span class="muted">≈ ${money(total * rateOf())}</span>`
      : money(total);
  };

  body.addEventListener('change', (e) => {
    if (e.target.classList.contains('it-product')) {
      const p = product(e.target.value);
      const price = $('.it-price', e.target.closest('tr'));
      if (p) { price.value = defaultPrice(p); formatMoneyInput(price); }
    }
    recalc();
  });
  body.addEventListener('input', recalc);
  body.addEventListener('click', (e) => {
    if (!e.target.classList.contains('it-remove')) return;
    if ($$('tr', body).length > 1) e.target.closest('tr').remove();
    else $('.it-product', e.target.closest('tr')).value = '';
    recalc();
  });
  $('#addItemRow').addEventListener('click', () => body.insertAdjacentHTML('beforeend', itemRowHtml(t, {}, curOf())));
  // Valyuta almashtirilsa — narxlar joriy kurs bo'yicha qayta hisoblanadi
  curRadios.forEach((r) => r.addEventListener('change', () => {
    const cur = curOf();
    const rate = rateOf();
    $('#rateField').hidden = cur !== 'USD';
    [...$$('.it-price', body), discount].filter(Boolean).forEach((el) => {
      const v = num(el.value);
      if (v && rate) el.value = cur === 'USD' ? round2(v / rate) : Math.round(v * rate);
      setMoneyCurrency(el, cur);
    });
    recalc();
  }));
  rateInput?.addEventListener('input', recalc);
  whSel.addEventListener('change', recalc);
  if (discount) discount.addEventListener('input', recalc);
  recalc();
  return stock;
}

function readItems() {
  const items = [];
  $$('#itemRows tr').forEach((tr) => {
    const productId = $('.it-product', tr).value;
    if (!productId) return;
    items.push({ productId, qty: Math.max(1, num($('.it-qty', tr).value)), price: num($('.it-price', tr).value) });
  });
  return items;
}

function openDoc(type, existing, preset = {}) {
  const t = DOC_TYPES[type];
  if (type === 'inventory') return openInventory(existing);
  if (!db.products.length) {
    alert("Avval mahsulot qo'shing (Tovarlar → Mahsulotlar).");
    return;
  }
  const d = existing || Object.assign({ date: today() }, preset);
  // Sotuvchi faqat savdo hujjatlari bilan ishlaydi va boshqalarnikini o'zgartira olmaydi
  if (!canUseDoc(type)) return alert("Bu hujjat turi uchun ruxsatingiz yo'q.");
  const editable = !existing || canEditDoc(existing);
  let stock;
  const extra = [];
  if (existing) {
    extra.push({ label: 'Chop etish', onClick: () => printDoc(existing.id) });
    if (t.pay && (isAdmin() || t.pay === 'in')) extra.push({ label: "To'lov", onClick: () => newPayment(t.pay, { counterpartyId: existing.counterpartyId, docId: existing.id }) });
    if (t.next && canUseDoc(t.next)) extra.push({ label: `→ ${DOC_TYPES[t.next].one}`, onClick: () => createFrom(existing.id) });
    if (isAdmin()) extra.push({ label: "O'chirish", cls: 'danger', onClick: () => deleteDoc(existing.id) });
  }
  const author = existing?.userId && db.users.find((u) => u.id === existing.userId);
  openModal({
    title: (existing ? `${t.one} ${existing.no}` : `${t.one} (yangi)`) + (author ? ` · ${author.name}` : ''),
    body: editable ? docForm(type, d) : `<fieldset disabled>${docForm(type, d)}</fieldset>`,
    wide: true,
    extra,
    onOpen: () => {
      stock = bindDocForm(type, existing?.id);
      if (!editable) $('#addItemRow').hidden = true;
    },
    onSubmit: editable ? (data) => saveDoc(type, existing, preset, data, stock) : null,
  });
}

const SELLER_DOCS = ['order', 'sale', 'salesReturn'];
const canUseDoc = (type) => isAdmin() || SELLER_DOCS.includes(type);
const canEditDoc = (d) => isAdmin() || (canUseDoc(d.type) && d.userId === me?.id);

async function saveDoc(type, existing, preset, data, stock) {
  const t = DOC_TYPES[type];
  const items = readItems();
  if (!items.length) {
    alert('Kamida bitta mahsulot tanlang.');
    return false;
  }
  const currency = t.fx && data.currency === 'USD' ? 'USD' : 'UZS';
  if (currency === 'USD' && !(num(data.rate) > 0)) {
    alert('Dollar kursini kiriting.');
    return false;
  }
  if (!existing && t.tgAsk && !tgAnswered(data)) return false;

  // Eng kam narxdan arzon sotish: sotuvchiga ruxsat yo'q, administrator tasdiqlaydi
  if (t.price === 'sale' && type !== 'salesReturn') {
    const low = items.map((it) => ({ it, p: product(it.productId) }))
      .filter(({ it, p }) => p && minPriceUZS(p) && it.price < minPriceUZS(p))
      .map(({ it, p }) => `${p.name}: ${fmt(it.price)} < eng kami ${fmt(minPriceUZS(p))} so'm`);
    if (low.length) {
      if (!isAdmin()) {
        alert("Narx eng kam narxdan past:\n" + low.join('\n') + "\n\nNarxni oshiring yoki administratorga murojaat qiling.");
        return false;
      }
      if (!confirm("Narx eng kam narxdan past:\n" + low.join('\n') + "\n\nBaribir saqlansinmi?")) return false;
    }
  }
  if (t.move && data.warehouseId === data.toWarehouseId) {
    alert('Omborlar har xil bo\'lishi kerak.');
    return false;
  }

  let counterpartyId = data.counterpartyId || null;
  if (t.party) {
    if (data.newPartyName.trim()) {
      const c = { id: uid(), name: data.newPartyName.trim(), kind: t.party, phone: data.newPartyPhone.trim(), address: data.address?.trim() || '', inn: '', note: '', created: today() };
      db.counterparties.push(c);
      counterpartyId = c.id;
    }
    if (!counterpartyId) {
      alert(t.party === 'supplier' ? "Ta'minotchini tanlang." : 'Mijozni tanlang.');
      return false;
    }
  }

  // Ombordan chiqarishda yetarli qoldiq borligini tekshiramiz
  if (t.stock < 0 || t.move) {
    const need = {};
    items.forEach((it) => { need[it.productId] = (need[it.productId] || 0) + it.qty; });
    const short = Object.entries(need)
      .filter(([pid, q]) => qtyIn(stock, pid, data.warehouseId) < q)
      .map(([pid, q]) => `${product(pid).name}: kerak ${q}, bor ${qtyIn(stock, pid, data.warehouseId)}`);
    if (short.length && !confirm("Omborda yetarli emas:\n" + short.join('\n') + "\n\nBaribir saqlansinmi? (qoldiq manfiy bo'ladi)")) return false;
  }

  const d = existing || Object.assign({ id: uid(), type, no: await nextNo(type), created: new Date().toISOString(), userId: me?.id }, preset.orderId ? { orderId: preset.orderId } : {}, preset.baseId ? { baseId: preset.baseId } : {});
  Object.assign(d, {
    date: data.date,
    counterpartyId,
    warehouseId: data.warehouseId,
    toWarehouseId: t.move ? data.toWarehouseId : undefined,
    status: t.statuses ? data.status : undefined,
    deliveryDate: t.delivery ? data.deliveryDate : undefined,
    address: t.delivery ? data.address.trim() : undefined,
    discount: num(data.discount),
    note: data.note.trim(),
    items,
    currency: t.fx ? currency : undefined,
    rate: currency === 'USD' ? num(data.rate) : undefined,
  });

  if (!existing) {
    db.docs.push(d);
    const pay = num(data.payNow);
    if (pay > 0) {
      db.payments.push({
        id: uid(), no: await nextNo(t.pay === 'in' ? 'payIn' : 'payOut'), dir: t.pay, date: d.date, counterpartyId, docId: d.id,
        amount: pay, method: data.payMethod, purpose: t.pay === 'in' ? PAY_PURPOSES_IN[0] : PAY_PURPOSES_OUT[0], note: '', userId: me?.id,
      });
    }
    // Asos hujjat holatini yangilaymiz
    const base = preset.baseId && doc(preset.baseId);
    if (base?.type === 'order') base.status = 'shipped';
    if (base?.type === 'purchaseOrder') base.status = 'received';
  }
  save();
  if (!existing && t.tgAsk && data.tgPost === 'yes') telegramOnStockIn(d);
}

function createFrom(id) {
  const base = doc(id);
  const t = DOC_TYPES[base.type];
  const preset = {
    date: today(),
    counterpartyId: base.counterpartyId,
    warehouseId: base.warehouseId,
    address: base.address,
    deliveryDate: base.deliveryDate,
    discount: base.discount,
    currency: base.currency,
    rate: base.rate,
    items: base.items.map((it) => ({ ...it })),
    baseId: base.id,
    orderId: base.type === 'order' ? base.id : undefined,
    note: `${t.one} ${base.no} asosida`,
  };
  openDoc(t.next, null, preset);
}

function deleteDoc(id) {
  const d = doc(id);
  const t = DOC_TYPES[d.type];
  const pays = db.payments.filter((p) => p.docId === id);
  let msg = `${t.one} ${d.no} o'chirilsinmi?`;
  if (pays.length) msg += `\nUnga bog'langan ${pays.length} ta to'lov hujjatdan ajratiladi (o'chirilmaydi).`;
  if (!confirm(msg)) return;
  pays.forEach((p) => { p.docId = null; });
  db.docs = db.docs.filter((x) => x.id !== id);
  closeModal();
  save();
}

function printDoc(id) {
  const d = doc(id);
  const t = DOC_TYPES[d.type];
  const c = party(d.counterpartyId) || {};
  const rows = d.items.map((it, i) => {
    const p = product(it.productId) || {};
    return `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}<br><small>${esc([p.size, p.color].filter(Boolean).join(', '))}</small></td><td>${it.qty} ${esc(p.unit || '')}</td><td>${fmtIn(it.price, d.currency)}</td><td>${fmtIn(Math.round(it.qty * it.price * 100) / 100, d.currency)}</td></tr>`;
  }).join('');
  const paid = t.pay ? docPaid(d) : 0;
  const w = window.open('', '_blank');
  if (!w) {
    alert("Brauzer yangi oynani blokladi. Ushbu sayt uchun qalqib chiquvchi oynalarga ruxsat bering.");
    return;
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.one)} ${esc(d.no)}</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#000}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #888;padding:6px;text-align:left;vertical-align:top}h2{margin:0 0 4px}.r{text-align:right}</style>
    </head><body>
    <div><b>${esc(db.company.name)}</b> ${esc(db.company.phone)} ${esc(db.company.address)}</div>
    <h2>${esc(t.one)} № ${esc(d.no)} — ${fmtDate(d.date)}</h2>
    ${t.party ? `<div>${t.party === 'supplier' ? "Ta'minotchi" : 'Mijoz'}: <b>${esc(c.name)}</b> ${esc(c.phone)}</div>` : ''}
    <div>Ombor: ${esc(warehouse(d.warehouseId)?.name)}${t.move ? ' → ' + esc(warehouse(d.toWarehouseId)?.name) : ''}</div>
    ${d.address ? `<div>Yetkazish: ${esc(d.address)} ${esc(d.deliveryDate || '')}</div>` : ''}
    <table><tr><th>№</th><th>Mahsulot</th><th>Soni</th><th>Narxi</th><th>Summa</th></tr>${rows}</table>
    <div class="r">${d.discount ? `Chegirma: ${fmtIn(d.discount, d.currency)}<br>` : ''}${d.currency === 'USD' ? `Jami: ${fmtUsd(docTotalCur(d))} (kurs ${fmtRate(d.rate)})<br>` : ''}<b>Jami: ${money(docTotal(d))}</b>
    ${t.pay ? `<br>To'langan: ${money(paid)}<br>Qoldiq: ${money(Math.max(0, docTotal(d) - paid))}` : ''}</div>
    ${d.note ? `<p>${esc(d.note)}</p>` : ''}
    <p style="margin-top:48px">Topshirdi: ______________ &nbsp;&nbsp;&nbsp; Qabul qildi: ______________</p>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// ---------- Inventarizatsiya ----------

function openInventory(existing) {
  if (existing) {
    openModal({
      title: `Inventarizatsiya ${existing.no}`,
      wide: true,
      body: `<p>Sana: ${fmtDate(existing.date)} · Ombor: ${esc(warehouse(existing.warehouseId)?.name)}</p>
        <table><thead><tr><th>Mahsulot</th><th class="num">Hisobda</th><th class="num">Haqiqatda</th><th class="num">Farq</th></tr></thead><tbody>
        ${existing.items.map((it) => `<tr><td>${esc(product(it.productId)?.name)}</td><td class="num">${it.expected}</td><td class="num">${it.qty}</td>
          <td class="num ${it.qty - it.expected < 0 ? 'debt' : ''}">${it.qty - it.expected}</td></tr>`).join('')}</tbody></table>
        <p class="muted">${esc(existing.note)}</p>`,
      extra: [{ label: "O'chirish", cls: 'danger', onClick: () => deleteDoc(existing.id) }],
    });
    return;
  }
  const whId = db.warehouses[0].id;
  const rowsHtml = (wh) => {
    const st = computeStock();
    return db.products.filter((p) => !p.archived).map((p) => {
      const q = qtyIn(st, p.id, wh);
      return `<tr data-pid="${p.id}" data-exp="${q}"><td>${esc(p.name)} <span class="muted">${esc(p.code)}</span></td><td class="num">${q}</td>
        <td><input class="inv-fact" type="number" min="0" value="${q}"></td><td class="num inv-diff">0</td></tr>`;
    }).join('') || emptyRow(4, "Mahsulot yo'q");
  };
  openModal({
    title: 'Inventarizatsiya (yangi)',
    wide: true,
    submitText: "Yakunlash",
    body: `<div class="form-grid">${field('Sana', 'date', today(), 'type="date" required')}${selectField('Ombor', 'warehouseId', whOptions(), whId)}</div>
      <p class="muted">Har bir mahsulotning haqiqiy sonini kiriting. Yakunlanganda kamomad uchun "Hisobdan chiqarish", ortiqcha uchun "Kirim qilish" hujjatlari avtomatik yaratiladi.</p>
      <div class="table-wrap"><table class="items-table"><thead><tr><th>Mahsulot</th><th class="num">Hisobda</th><th>Haqiqatda</th><th class="num">Farq</th></tr></thead>
      <tbody id="invRows">${rowsHtml(whId)}</tbody></table></div>`,
    onOpen: () => {
      $('#modalForm [name=warehouseId]').addEventListener('change', (e) => { $('#invRows').innerHTML = rowsHtml(e.target.value); });
      $('#invRows').addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        const diff = num(e.target.value) - num(tr.dataset.exp);
        $('.inv-diff', tr).textContent = diff;
        $('.inv-diff', tr).classList.toggle('debt', diff < 0);
      });
    },
    onSubmit: async (data) => {
      const items = $$('#invRows tr[data-pid]').map((tr) => ({ productId: tr.dataset.pid, expected: num(tr.dataset.exp), qty: num($('.inv-fact', tr).value), price: ctx.cost[tr.dataset.pid] || 0 }));
      const inv = { id: uid(), type: 'inventory', no: await nextNo('inventory'), userId: me.id, date: data.date, warehouseId: data.warehouseId, items, note: '' };
      const plus = items.filter((it) => it.qty > it.expected).map((it) => ({ productId: it.productId, qty: it.qty - it.expected, price: it.price }));
      const minus = items.filter((it) => it.qty < it.expected).map((it) => ({ productId: it.productId, qty: it.expected - it.qty, price: it.price }));
      const created = [];
      if (plus.length) {
        const e = { id: uid(), type: 'enter', no: await nextNo('enter'), userId: me.id, date: data.date, warehouseId: data.warehouseId, items: plus, note: `Inventarizatsiya ${inv.no} — ortiqcha`, baseId: inv.id };
        db.docs.push(e);
        created.push(`Kirim qilish ${e.no}`);
      }
      if (minus.length) {
        const w = { id: uid(), type: 'writeoff', no: await nextNo('writeoff'), userId: me.id, date: data.date, warehouseId: data.warehouseId, items: minus, note: `Inventarizatsiya ${inv.no} — kamomad`, baseId: inv.id };
        db.docs.push(w);
        created.push(`Hisobdan chiqarish ${w.no}`);
      }
      inv.note = created.length ? 'Yaratildi: ' + created.join(', ') : 'Farq aniqlanmadi';
      db.docs.push(inv);
      save();
    },
  });
}

// ---------- To'lovlar ----------

function newPayment(dir, preset = {}) {
  if (dir === 'out' && !isAdmin()) return alert("Chiqim to'lovlari faqat administrator uchun.");
  const purposes = dir === 'in' ? PAY_PURPOSES_IN : PAY_PURPOSES_OUT;
  const linked = preset.docId && doc(preset.docId);
  const rest = linked ? Math.max(0, docTotal(linked) - docPaid(linked)) : '';
  let purpose = purposes[0];
  if (linked?.type === 'salesReturn') purpose = 'Mijozga qaytarish';
  if (linked?.type === 'purchaseReturn') purpose = "Ta'minotchidan qaytim";
  openModal({
    title: dir === 'in' ? "Kirim to'lovi" : "Chiqim to'lovi",
    body: `${linked ? `<p>Hujjat: <b>${esc(DOC_TYPES[linked.type].one)} ${esc(linked.no)}</b> · Jami ${money(docTotal(linked))} · To'langan ${money(docPaid(linked))}</p>` : ''}
      <div class="form-grid">
        ${field('Sana', 'date', today(), 'type="date" required')}
        ${field("Summa (so'm) *", 'amount', rest || '', 'inputmode="numeric" required')}
        ${selectField("To'lov usuli", 'method', Object.entries(PAY_METHODS), 'cash')}
        ${selectField('Moddasi', 'purpose', purposes.map((p) => [p, p]), purpose)}
        ${selectField('Kontragent', 'counterpartyId', [['', "— yo'q (xarajat) —"], ...partyOptions().slice(1)], preset.counterpartyId || '', 'full')}
        ${textArea('Izoh', 'note', '')}
      </div>`,
    onSubmit: async (d) => {
      const amount = num(d.amount);
      if (amount <= 0) {
        alert("Summani kiriting.");
        return false;
      }
      db.payments.push({
        id: uid(), no: await nextNo(dir === 'in' ? 'payIn' : 'payOut'), dir, date: d.date, amount, method: d.method,
        purpose: d.purpose, counterpartyId: d.counterpartyId || null, docId: preset.docId || null, note: d.note.trim(), userId: me?.id,
      });
      save();
    },
  });
}

function deletePayment(id) {
  if (!confirm("To'lov o'chirilsinmi?")) return;
  db.payments = db.payments.filter((p) => p.id !== id);
  save();
}

// ---------- Telegram ----------

function stockLine(p) {
  const total = qtyIn(computeStock(), p.id);
  if (total > 0) return db.telegram.showQty ? `✅ Omborda bor (${total} ${p.unit || 'dona'})` : '✅ Omborda bor';
  return "❌ Omborda yo'q (buyurtma asosida)";
}

function telegramCaption(p) {
  const lines = [`🛋 <b>${esc(p.name)}</b>`];
  if (p.type) lines.push(`🪑 Turi: ${esc(p.type)}`);
  if (p.code) lines.push(`🔖 Kod: ${esc(p.code)}`);
  lines.push(`💰 Narxi: <b>${priceLabel(p)}</b>`);
  if (p.size) lines.push(`📐 O'lchami: ${esc(p.size)} sm`);
  if (p.color) lines.push(`🎨 Rangi: ${esc(p.color)}`);
  if (p.origin || p.maker) lines.push(`🏭 Ishlab chiqarilgan: ${esc([p.origin, p.maker].filter(Boolean).join(', '))}`);
  lines.push(`📦 ${stockLine(p)}`);
  if (p.note) lines.push('', esc(p.note));
  if (db.company.phone) lines.push('', `📞 ${esc(db.company.phone)}`);
  const tag = (t) => '#' + t.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  if (p.category || p.type) lines.push([p.category, p.type].filter(Boolean).map(tag).join(' '));
  return lines.join('\n');
}

async function telegramCall(method, body) {
  const api = `https://api.telegram.org/bot${db.telegram.token}/${method}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(api, body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (json.ok) return json;
    // Telegram tezlikni cheklasa, aytgan vaqtcha kutib qayta urinamiz
    const wait = json.parameters?.retry_after;
    if (res.status === 429 && wait && attempt < 2) {
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    throw new Error(json.description || `HTTP ${res.status}`);
  }
}

async function telegramSend(p) {
  const chatId = db.telegram.chatId;
  const caption = telegramCaption(p);
  const fits = caption.length <= 1024; // rasm izohi chegarasi
  const blobs = [];
  for (const ph of (p.photos || []).slice(0, 10)) {
    const b = await backend.photoBlob(ph.path).catch(() => null);
    if (b) blobs.push(await toJpeg(b));
  }
  if (!blobs.length) {
    await telegramCall('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
    return;
  }
  const fd = new FormData();
  fd.append('chat_id', chatId);
  if (blobs.length === 1) {
    fd.append('photo', blobs[0], 'photo.jpg');
    if (fits) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    await telegramCall('sendPhoto', fd);
  } else {
    fd.append('media', JSON.stringify(blobs.map((b, i) => Object.assign(
      { type: 'photo', media: `attach://p${i}` },
      i === 0 && fits ? { caption, parse_mode: 'HTML' } : {},
    ))));
    blobs.forEach((b, i) => fd.append(`p${i}`, b, `p${i}.jpg`));
    await telegramCall('sendMediaGroup', fd);
  }
  if (!fits) await telegramCall('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
}

function telegramLog(text, ok) {
  db.telegram.log.unshift({ at: new Date().toLocaleString('uz-UZ'), text, ok });
  db.telegram.log = db.telegram.log.slice(0, 50);
}

// manual=true — foydalanuvchi o'zi tugmani bosgan, natijani ko'rsatamiz
async function telegramPostProducts(ids, manual = false) {
  const tg = db.telegram;
  if (!tg.token || !tg.chatId) {
    if (manual) alert("Avval Sozlamalar → Telegram bo'limida bot tokeni va guruh ID sini kiriting.");
    return;
  }
  const errors = [];
  const list = [...new Set(ids)];
  for (const [i, id] of list.entries()) {
    const p = product(id);
    if (!p) continue;
    // Guruhga daqiqasiga ~20 xabardan ko'p yuborib bo'lmaydi
    if (i > 0) await new Promise((r) => setTimeout(r, 3500));
    try {
      await telegramSend(p);
      telegramLog(`Yuborildi: ${p.name}`, true);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      telegramLog(`Xato: ${p.name} — ${e.message}`, false);
    }
  }
  commit();
  if (errors.length) alert("Telegramga yuborilmadi:\n" + errors.join('\n'));
  else if (manual) alert('Telegramga yuborildi.');
}

function telegramOnStockIn(d) {
  telegramPostProducts(d.items.map((it) => it.productId), true);
}

// ---------- Ko'rinishlar (sahifalar) ----------

// Uchinchi element 'A' — faqat administrator ko'radi
const SECTIONS = [
  { id: 'dashboard', icon: 'dashboard', title: "Ko'rsatkichlar" },
  { id: 'purchases', icon: 'truck', title: 'Xaridlar', admin: true, views: [['purchaseOrder'], ['receipt'], ['purchaseReturn']] },
  { id: 'sales', icon: 'bag', title: 'Savdo', views: [['order'], ['sale'], ['salesReturn']] },
  { id: 'goods', icon: 'sofa', title: 'Tovarlar', views: [['products', 'Mahsulotlar'], ['stock', 'Qoldiqlar'], ['enter', '', 'A'], ['writeoff', '', 'A'], ['move', '', 'A'], ['inventory', '', 'A']] },
  { id: 'parties', icon: 'users', title: 'Kontragentlar', views: [['parties', 'Kontragentlar'], ['debts', 'Qarzlar', 'A']] },
  { id: 'money', icon: 'wallet', title: 'Pul', views: [['payments', "To'lovlar"], ['cash', 'Kassa va hisoblar', 'A']] },
  { id: 'reports', icon: 'chart', title: 'Hisobotlar', admin: true, views: [['profit', 'Foyda va zarar'], ['top', 'Savdo tahlili']] },
  { id: 'settings', icon: 'settings', title: 'Sozlamalar', admin: true, views: [['users', 'Foydalanuvchilar'], ['currency', 'Valyuta kursi'], ['server', 'Server'], ['telegram', 'Telegram'], ['company', 'Kompaniya'], ['warehouses', 'Omborlar'], ['categories', 'Kategoriya va ranglar'], ['backup', 'Zaxira nusxa']] },
];

function viewTitle(v) {
  return v[1] || DOC_TYPES[v[0]].list;
}

const visibleSections = () => SECTIONS.filter((s) => isAdmin() || !s.admin);
const visibleViews = (s) => s.views && s.views.filter((v) => isAdmin() || v[2] !== 'A');

function currentRoute() {
  const [sec, view] = location.hash.slice(1).split('/');
  const sections = visibleSections();
  const section = sections.find((s) => s.id === sec) || sections[0];
  const views = visibleViews(section);
  const v = views && (views.find((x) => x[0] === view) || views[0]);
  return { section, view: v ? v[0] : section.id };
}

const userName = (id) => db.users.find((u) => u.id === id)?.name || db.legacyUsers?.[id] || '';

// Filtrlar qayta chizishda yo'qolmasligi uchun
const filters = {};
function filterVal(key, def = '') {
  return filters[key] ?? def;
}

function toolbar(view, { search = true, buttons = '', extra = '' } = {}) {
  return `<div class="toolbar">
    ${search ? `<input data-filter="${view}.q" placeholder="Qidirish..." value="${esc(filterVal(view + '.q'))}">` : ''}
    ${extra}
    ${buttons}
  </div>`;
}

function periodInputs(view) {
  const now = today();
  return `<label class="inline">dan <input type="date" data-filter="${view}.from" value="${esc(filterVal(view + '.from', now.slice(0, 8) + '01'))}"></label>
    <label class="inline">gacha <input type="date" data-filter="${view}.to" value="${esc(filterVal(view + '.to', now))}"></label>`;
}

function inPeriod(view, date) {
  const now = today();
  return date >= filterVal(view + '.from', now.slice(0, 8) + '01') && date <= filterVal(view + '.to', now);
}

// --- Bosh sahifa ---

function viewDashboard() {
  const t = today();
  const month = t.slice(0, 7);
  const sales = db.docs.filter((d) => d.type === 'sale');
  const returns = db.docs.filter((d) => d.type === 'salesReturn');
  const sumOf = (list) => list.reduce((s, d) => s + docTotal(d), 0);
  const daySales = sumOf(sales.filter((d) => d.date === t)) - sumOf(returns.filter((d) => d.date === t));
  const monthSales = sales.filter((d) => d.date.startsWith(month));
  const monthTotal = sumOf(monthSales) - sumOf(returns.filter((d) => d.date.startsWith(month)));
  const gross = profitRows((d) => d.startsWith(month)).reduce((s, r) => s + r.profit, 0);
  const cash = cashBalances();
  let receivable = 0;
  let payable = 0;
  db.counterparties.forEach((c) => {
    const b = partyBalance(c.id);
    if (b > 0) receivable += b; else payable -= b;
  });
  const stockValue = db.products.reduce((s, p) => s + Math.max(0, qtyIn(ctx.stock, p.id)) * ctx.cost[p.id], 0);
  const activeOrders = db.docs.filter((d) => d.type === 'order' && RESERVING.includes(d.status));

  const mySales = sales.filter((d) => d.date.startsWith(month) && d.userId === me.id);
  const cards = isAdmin() ? [
    ['Bugungi savdo', money(daySales), `${sales.filter((d) => d.date === t).length} ta jo'natish`],
    ['Shu oy savdosi', money(monthTotal), `${monthSales.length} ta jo'natish`],
    ['Shu oy yalpi foydasi', money(gross), 'savdo − tannarx'],
    ['Pul qoldig\'i', money(cash.cash + cash.card + cash.bank), `kassa ${fmt(cash.cash)} · karta ${fmt(cash.card)} · hisob ${fmt(cash.bank)}`],
    ['Bizga qarzlar', money(receivable), 'debitorlik', 'debt'],
    ['Bizning qarzlar', money(payable), 'kreditorlik', 'warn'],
    ['Ombordagi tovar', money(stockValue), `${db.products.length} xil mahsulot`],
    ['Faol buyurtmalar', activeOrders.length, `${money(sumOf(activeOrders))}`],
  ] : [
    ['Bugungi savdo', money(daySales), `${sales.filter((d) => d.date === t).length} ta jo'natish`],
    ['Mening savdom (shu oy)', money(sumOf(mySales)), `${mySales.length} ta jo'natish`],
    ['Faol buyurtmalar', activeOrders.length, `${money(sumOf(activeOrders))}`],
    ['Mijozlar qarzi', money(receivable), 'undirilishi kerak', 'debt'],
  ];
  const quick = [
    ['sale', 'Sotuv', 'bag', 'primary'], ['order', 'Buyurtma', 'receipt'],
    ...(isAdmin() ? [['receipt', 'Qabul qilish', 'truck']] : []),
  ].map(([type, label, ic, cls]) => `<button class="${cls || ''}" data-act="newDoc" data-type="${type}">${icon(ic)}${label}</button>`).join('') +
    (isAdmin() ? `<button data-act="newProduct">${icon('sofa')}Mahsulot</button>` : '') +
    `<button data-act="newPayment" data-dir="in">${icon('arrowIn')}Kirim to'lovi</button>` +
    (isAdmin() ? `<button data-act="newPayment" data-dir="out">${icon('arrowOut')}Xarajat</button>` : '');

  const low = db.products.filter((p) => !p.archived && qtyIn(ctx.stock, p.id) - qtyIn(ctx.reserve, p.id) <= (p.minQty || 0));
  const deliveries = db.docs
    .filter((d) => (d.type === 'order' && RESERVING.includes(d.status)) || (d.type === 'sale' && d.status !== 'delivered'))
    .filter((d) => d.deliveryDate)
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
    .slice(0, 10);
  const recent = db.docs.filter((d) => canUseDoc(d.type))
    .sort((a, b) => (b.created || b.date).localeCompare(a.created || a.date)).slice(0, 8);

  const usagePct = isAdmin() && storageUsage?.limit ? (storageUsage.used / storageUsage.limit) * 100 : 0;
  const usageWarn = usagePct >= 80
    ? `<div class="card warn-card">${icon('alert')} Rasmlar xotirasining ${usagePct.toFixed(0)}% band. <a href="#settings/server">Batafsil</a></div>` : '';

  const cardIcon = {
    'Bugungi savdo': 'cash', 'Shu oy savdosi': 'calendar', 'Shu oy yalpi foydasi': 'trend', "Pul qoldig'i": 'wallet',
    'Bizga qarzlar': 'arrowIn', 'Bizning qarzlar': 'arrowOut', 'Ombordagi tovar': 'box', 'Faol buyurtmalar': 'bag',
    'Mening savdom (shu oy)': 'user', 'Mijozlar qarzi': 'arrowIn',
  };
  return usageWarn + `<div class="stats">${cards.map(([l, v, h, cls]) => `<div class="stat">
      <div class="stat-ic ${cls || ''}">${icon(cardIcon[l] || 'chart')}</div>
      <div class="label">${l}</div><div class="value ${cls || ''}">${v}</div><div class="muted small">${h}</div></div>`).join('')}</div>
    <div class="quick">${quick}</div>
    <div class="grid2">
      <div class="card"><h3>${icon('truck')}Yaqin yetkazishlar</h3><table><thead><tr><th>Sana</th><th>Hujjat</th><th>Mijoz</th><th>Manzil</th></tr></thead><tbody>
        ${deliveries.length ? deliveries.map((d) => `<tr class="click" data-act="openDoc" data-id="${d.id}"><td class="${d.deliveryDate < t ? 'debt' : ''}">${fmtDate(d.deliveryDate)}</td><td>${esc(d.no)}</td>
          <td>${esc(party(d.counterpartyId)?.name)}</td><td>${esc(d.address)}</td></tr>`).join('') : emptyRow(4, "Rejalashtirilgan yetkazish yo'q")}
      </tbody></table></div>
      <div class="card"><h3>${icon('alert')}Kam qolgan mahsulotlar</h3><table><thead><tr><th>Mahsulot</th><th class="num">Mavjud</th><th class="num">Min.</th></tr></thead><tbody>
        ${low.length ? low.map((p) => `<tr class="click" data-act="editProduct" data-id="${p.id}"><td>${esc(p.name)}</td><td class="num debt">${qtyIn(ctx.stock, p.id) - qtyIn(ctx.reserve, p.id)}</td><td class="num">${p.minQty}</td></tr>`).join('') : emptyRow(3, 'Hammasi yetarli')}
      </tbody></table></div>
    </div>
    <div class="card"><h3>${icon('clock')}Oxirgi hujjatlar</h3><table><thead><tr><th>Sana</th><th>Hujjat</th><th>Kontragent</th><th class="num">Summa</th></tr></thead><tbody>
      ${recent.length ? recent.map((d) => `<tr class="click" data-act="openDoc" data-id="${d.id}"><td>${fmtDate(d.date)}</td><td>${esc(DOC_TYPES[d.type].one)} ${esc(d.no)}</td>
        <td>${esc(party(d.counterpartyId)?.name || warehouse(d.warehouseId)?.name)}</td><td class="num">${d.type === 'inventory' ? '' : money(docTotal(d))}</td></tr>`).join('') : emptyRow(4, "Hali hujjat yo'q. Boshlash uchun mahsulot qo'shing.")}
    </tbody></table></div>`;
}

// --- Hujjatlar ro'yxati ---

function viewDocs(type) {
  const t = DOC_TYPES[type];
  const q = filterVal(type + '.q').toLowerCase();
  const st = filterVal(type + '.status');
  const list = db.docs.filter((d) => d.type === type)
    .filter((d) => inPeriod(type, d.date))
    .filter((d) => !st || d.status === st)
    .filter((d) => !q || [d.no, party(d.counterpartyId)?.name, party(d.counterpartyId)?.phone, d.note, ...d.items.map((it) => product(it.productId)?.name)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no));

  const statusFilter = t.statuses
    ? `<select data-filter="${type}.status"><option value="">Barcha holatlar</option>${Object.entries(t.statuses).map(([k, v]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${v}</option>`).join('')}</select>`
    : '';
  const cols = ['№', 'Sana', t.party ? 'Kontragent' : 'Ombor', 'Mahsulotlar', 'Summa'];
  if (t.pay) cols.push("To'langan");
  if (t.statuses) cols.push('Holati');
  const total = list.reduce((s, d) => s + (type === 'inventory' ? 0 : docTotal(d)), 0);

  const rows = list.map((d) => {
    const paid = t.pay ? docPaid(d) : 0;
    const where = t.party ? esc(party(d.counterpartyId)?.name) : esc(warehouse(d.warehouseId)?.name) + (t.move ? ' → ' + esc(warehouse(d.toWarehouseId)?.name) : '');
    return `<tr class="click" data-act="openDoc" data-id="${d.id}">
      <td>${esc(d.no)}</td><td>${fmtDate(d.date)}${d.userId ? `<div class="muted small">${esc(userName(d.userId))}</div>` : ''}</td><td>${where}</td>
      <td class="items-cell">${d.items.slice(0, 3).map((it) => `${esc(product(it.productId)?.name)} × ${it.qty}`).join('<br>')}${d.items.length > 3 ? `<br><span class="muted">yana ${d.items.length - 3} ta</span>` : ''}</td>
      <td class="num">${type === 'inventory' ? '' : money(docTotal(d))}${d.currency === 'USD' ? `<div class="muted small">${fmtUsd(docTotalCur(d))} · ${fmtRate(d.rate)}</div>` : ''}</td>
      ${t.pay ? `<td class="num">${paid >= docTotal(d) && paid > 0 ? badge("To'langan", 'done') : paid > 0 ? fmt(paid) : badge("To'lanmagan", 'cancel')}</td>` : ''}
      ${t.statuses ? `<td>${badge(t.statuses[d.status] || '', d.status)}</td>` : ''}
    </tr>`;
  }).join('');

  return toolbar(type, {
    extra: periodInputs(type) + statusFilter,
    buttons: `<button class="primary" data-act="newDoc" data-type="${type}">${icon('plus')}${esc(t.one)}</button>${isAdmin() ? `<button data-act="exportDocs" data-type="${type}">${icon('download')}CSV</button>` : ''}`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th class="${i === 4 || i === 5 ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
    <tbody>${rows || emptyRow(cols.length, "Tanlangan davrda hujjat yo'q")}</tbody>
    ${list.length && type !== 'inventory' ? `<tfoot><tr><td colspan="4">Jami: ${list.length} ta</td><td class="num">${money(total)}</td><td colspan="${cols.length - 5}"></td></tr></tfoot>` : ''}
    </table></div></div>`;
}

function exportDocs(type) {
  const t = DOC_TYPES[type];
  const rows = [['№', 'Sana', 'Kontragent', 'Ombor', 'Mahsulot', 'Soni', 'Narxi', 'Summa', 'Holati']];
  db.docs.filter((d) => d.type === type).forEach((d) => d.items.forEach((it) => rows.push([
    d.no, d.date, party(d.counterpartyId)?.name, warehouse(d.warehouseId)?.name, product(it.productId)?.name, it.qty, it.price, it.qty * it.price, t.statuses ? t.statuses[d.status] : '',
  ])));
  download(`${type}-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

// --- Mahsulotlar ---

function viewProducts() {
  const q = filterVal('products.q').toLowerCase();
  // Kategoriya o'chirilgan yoki nomi o'zgargan bo'lsa, eski filtr ro'yxatni bo'sh qilib qo'ymasin
  const cat = db.categories.includes(filterVal('products.cat')) ? filterVal('products.cat') : '';
  const ptype = cat ? filterVal('products.type') : '';
  const arch = filterVal('products.arch') === '1';
  const list = db.products
    .filter((p) => !!p.archived === arch)
    .filter((p) => !cat || p.category === cat)
    .filter((p) => !ptype || p.type === ptype)
    .filter((p) => !q || [p.name, p.code, p.type, p.material, p.color, p.origin, p.maker, p.size].join(' ').toLowerCase().includes(q));

  const admin = isAdmin();
  const rows = list.map((p) => {
    const st = qtyIn(ctx.stock, p.id);
    const rs = qtyIn(ctx.reserve, p.id);
    return `<tr>
      <td class="thumb">${p.photos?.length ? `<img data-photo="${esc(p.photos[0].thumb)}" alt="" loading="lazy">` : ''}${p.photos?.length > 1 ? `<span class="ph-count">${p.photos.length}</span>` : ''}</td>
      <td class="click" data-act="editProduct" data-id="${p.id}"><b>${esc(p.name)}</b><div class="muted small">${esc([p.code, p.category, p.type].filter(Boolean).join(' · '))}</div></td>
      <td class="dt">${esc(p.size)}</td>
      <td>${esc(p.color)}</td>
      <td>${esc([p.origin, p.maker].filter(Boolean).join(', '))}</td>
      ${admin ? `<td class="num">${money(ctx.cost[p.id])}</td>` : ''}
      <td class="num">${priceLabel(p)}${p.priceCurrency === 'USD' ? `<div class="muted small">${fmtUsd(p.salePrice)}</div>` : ''}${p.minPrice ? `<div class="muted small">eng kami: ${priceLabel(p, 'minPrice')}</div>` : ''}</td>
      <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}${rs ? `<div class="muted small">rezerv ${rs}</div>` : ''}</td>
      <td class="actions">${admin ? `
        <button class="small icon-only" data-act="tgProduct" data-id="${p.id}" title="Telegram guruhga yuborish">${icon('send')}</button>
        ${p.archived ? `<button class="small" data-act="unarchive" data-id="${p.id}">Tiklash</button>` : `<button class="small danger icon-only" data-act="deleteProduct" data-id="${p.id}" title="O'chirish">${icon('trash')}</button>`}` : ''}
      </td>
    </tr>`;
  }).join('');

  return toolbar('products', {
    extra: `<select data-filter="products.cat"><option value="">Barcha kategoriyalar</option>${db.categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      ${cat ? `<select data-filter="products.type"><option value="">Barcha turlar</option>${(db.categoryTypes[cat] || []).map((t) => `<option ${t === ptype ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
      <select data-filter="products.arch"><option value="">Faol</option><option value="1" ${arch ? 'selected' : ''}>Arxiv</option></select>`,
    buttons: admin ? `<button class="primary" data-act="newProduct">${icon('plus')}Mahsulot</button><button data-act="exportProducts">${icon('download')}CSV</button>` : '',
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th></th><th>Nomi</th><th>O'lchami</th><th>Rangi</th><th>Ishlab chiqarilgan</th>
    ${admin ? '<th class="num">Tannarx</th>' : ''}<th class="num">Sotish narxi</th><th class="num">Qoldiq</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(9, "Mahsulot yo'q")}</tbody></table></div></div>`;
}

function exportProducts() {
  const rows = [['Kod', 'Nomi', 'Kategoriya', 'Turi', "O'lchami", 'Rangi', 'Ishlab chiqarilgan', 'Ishlab chiqaruvchi', "Tannarx (so'm)", 'Narx valyutasi', 'Sotish narxi', 'Eng kam narx', "Sotish narxi (so'm)", "Eng kam narx (so'm)", 'Qoldiq', 'Rezerv']];
  db.products.forEach((p) => rows.push([p.code, p.name, p.category, p.type, p.size, p.color, p.origin, p.maker, Math.round(ctx.cost[p.id]),
    p.priceCurrency === 'USD' ? 'USD' : "so'm", p.salePrice, p.minPrice || '', salePriceUZS(p), minPriceUZS(p) || '', qtyIn(ctx.stock, p.id), qtyIn(ctx.reserve, p.id)]));
  download(`mahsulotlar-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

// --- Qoldiqlar ---

function viewStock() {
  const wh = filterVal('stock.wh');
  const cat = filterVal('stock.cat');
  const q = filterVal('stock.q').toLowerCase();
  const onlyPos = filterVal('stock.pos') === '1';
  const admin = isAdmin();
  let tq = 0, tc = 0, ts = 0;
  const rows = db.products
    .filter((p) => !p.archived && (!cat || p.category === cat))
    .filter((p) => !q || [p.name, p.code].join(' ').toLowerCase().includes(q))
    .map((p) => ({ p, st: qtyIn(ctx.stock, p.id, wh), rs: qtyIn(ctx.reserve, p.id, wh) }))
    .filter((r) => !onlyPos || r.st > 0)
    .map(({ p, st, rs }) => {
      const cost = ctx.cost[p.id];
      const sale = salePriceUZS(p);
      tq += st; tc += st * cost; ts += st * sale;
      return `<tr class="click" data-act="productHistory" data-id="${p.id}"><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td>
        <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}</td><td class="num">${rs || ''}</td><td class="num">${st - rs}</td>
        ${admin ? `<td class="num">${fmt(cost)}</td><td class="num">${fmt(st * cost)}</td>` : ''}<td class="num">${fmt(sale)}</td><td class="num">${fmt(st * sale)}</td></tr>`;
    }).join('');
  return toolbar('stock', {
    extra: `<select data-filter="stock.wh"><option value="">Barcha omborlar</option>${db.warehouses.map((w) => `<option value="${w.id}" ${w.id === wh ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-filter="stock.cat"><option value="">Barcha kategoriyalar</option>${db.categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-filter="stock.pos"><option value="">Hammasi</option><option value="1" ${onlyPos ? 'selected' : ''}>Faqat bor</option></select>`,
    buttons: `<button data-act="print">${icon('print')}Chop etish</button>`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th>Kod</th><th>Nomi</th><th>Kategoriya</th><th class="num">Qoldiq</th><th class="num">Rezerv</th><th class="num">Mavjud</th>
    ${admin ? '<th class="num">Tannarx</th><th class="num">Tannarx summa</th>' : ''}<th class="num">Sotish narxi</th><th class="num">Sotish summa</th></tr></thead>
    <tbody>${rows || emptyRow(10, "Ma'lumot yo'q")}</tbody>
    <tfoot><tr><td colspan="3">Jami</td><td class="num">${tq}</td><td colspan="2"></td>${admin ? `<td></td><td class="num">${fmt(tc)}</td>` : ''}<td></td><td class="num">${fmt(ts)}</td></tr></tfoot></table></div></div>`;
}

// --- Kontragentlar ---

function viewParties() {
  const q = filterVal('parties.q').toLowerCase();
  const kind = isAdmin() ? filterVal('parties.kind') : 'customer';
  const list = db.counterparties
    .filter((c) => !kind || c.kind === kind || c.kind === 'both')
    .filter((c) => !q || [c.name, c.phone, c.address, c.inn].join(' ').toLowerCase().includes(q));
  const rows = list.map((c) => {
    const b = partyBalance(c.id);
    return `<tr class="click" data-act="editParty" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td><td>${esc(KINDS[c.kind])}</td>
      <td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td class="num ${b > 0 ? 'debt' : b < 0 ? 'warn' : ''}">${b ? money(b) : '—'}</td>
      <td class="actions"><button class="small" data-act="statement" data-id="${c.id}">${icon('receipt')}Hisob-kitob</button>${isAdmin() ? `<button class="small danger icon-only" data-act="deleteParty" data-id="${c.id}" title="O'chirish">${icon('trash')}</button>` : ''}</td></tr>`;
  }).join('');
  return toolbar('parties', {
    extra: !isAdmin() ? '' : `<select data-filter="parties.kind"><option value="">Hammasi</option><option value="customer" ${kind === 'customer' ? 'selected' : ''}>Mijozlar</option><option value="supplier" ${kind === 'supplier' ? 'selected' : ''}>Ta'minotchilar</option></select>`,
    buttons: `<button class="primary" data-act="newParty">${icon('plus')}Kontragent</button>`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th>Nomi</th><th>Turi</th><th>Telefon</th><th>Manzil</th><th class="num">Balans</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(6, "Kontragent yo'q")}</tbody></table></div>
    <p class="muted small">Balans: qizil — kontragent bizga qarzdor, sariq — biz qarzdormiz.</p></div>`;
}

function viewDebts() {
  const rows = db.counterparties.map((c) => ({ c, b: partyBalance(c.id) })).filter((x) => x.b);
  const recv = rows.filter((x) => x.b > 0).sort((a, b) => b.b - a.b);
  const pay = rows.filter((x) => x.b < 0).sort((a, b) => a.b - b.b);
  const table = (list, cls) => list.length ? list.map(({ c, b }) => `<tr class="click" data-act="statement" data-id="${c.id}"><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td class="num ${cls}">${money(Math.abs(b))}</td></tr>`).join('') : emptyRow(3, "Qarz yo'q");
  const sum = (list) => list.reduce((s, x) => s + Math.abs(x.b), 0);
  return `<div class="grid2">
    <div class="card"><h3>Bizga qarzdorlar — ${money(sum(recv))}</h3><table><thead><tr><th>Kontragent</th><th>Telefon</th><th class="num">Qarz</th></tr></thead><tbody>${table(recv, 'debt')}</tbody></table></div>
    <div class="card"><h3>Bizning qarzlarimiz — ${money(sum(pay))}</h3><table><thead><tr><th>Kontragent</th><th>Telefon</th><th class="num">Qarz</th></tr></thead><tbody>${table(pay, 'warn')}</tbody></table></div>
  </div>`;
}

// --- Pul ---

function viewPayments() {
  const q = filterVal('payments.q').toLowerCase();
  const admin = isAdmin();
  const dir = admin ? filterVal('payments.dir') : 'in';
  const list = db.payments
    .filter((p) => inPeriod('payments', p.date) && (!dir || p.dir === dir))
    .filter((p) => !q || [p.no, p.purpose, p.note, party(p.counterpartyId)?.name].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));
  let tin = 0, tout = 0;
  const rows = list.map((p) => {
    if (p.dir === 'in') tin += p.amount; else tout += p.amount;
    const d = p.docId && doc(p.docId);
    return `<tr><td>${esc(p.no)}</td><td>${fmtDate(p.date)}</td><td>${p.dir === 'in' ? badge('Kirim', 'done') : badge('Chiqim', 'cancel')}</td>
      <td>${esc(p.purpose)}</td><td>${esc(party(p.counterpartyId)?.name || '—')}</td>
      <td>${d ? `<a href="javascript:void 0" data-act="openDoc" data-id="${d.id}">${esc(d.no)}</a>` : ''}</td>
      <td>${esc(PAY_METHODS[p.method])}</td><td class="num">${money(p.amount)}</td><td>${esc(p.note)}</td>
      <td class="actions">${admin ? `<button class="small danger" data-act="deletePayment" data-id="${p.id}">×</button>` : ''}</td></tr>`;
  }).join('');
  return toolbar('payments', {
    extra: periodInputs('payments') + (!admin ? '' : `<select data-filter="payments.dir"><option value="">Hammasi</option><option value="in" ${dir === 'in' ? 'selected' : ''}>Kirim</option><option value="out" ${dir === 'out' ? 'selected' : ''}>Chiqim</option></select>`),
    buttons: `<button class="primary" data-act="newPayment" data-dir="in">${icon('arrowIn')}Kirim</button>${admin ? `<button data-act="newPayment" data-dir="out">${icon('arrowOut')}Chiqim</button>` : ''}`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th>№</th><th>Sana</th><th>Turi</th><th>Moddasi</th><th>Kontragent</th><th>Hujjat</th><th>Usul</th><th class="num">Summa</th><th>Izoh</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(10, "To'lov yo'q")}</tbody>
    <tfoot><tr><td colspan="7">Kirim: ${money(tin)} · Chiqim: ${money(tout)}</td><td class="num">${money(tin - tout)}</td><td colspan="2"></td></tr></tfoot></table></div></div>`;
}

function viewCash() {
  const b = cashBalances();
  return `<div class="stats">${Object.entries(PAY_METHODS).map(([k, v]) => `<div class="stat"><div class="label">${v}</div><div class="value">${money(b[k] || 0)}</div></div>`).join('')}
    <div class="stat"><div class="label">Jami</div><div class="value">${money(b.cash + b.card + b.bank)}</div></div></div>
    <div class="card"><p class="muted">Qoldiqlar barcha kirim va chiqim to'lovlaridan hisoblanadi. Boshlang'ich qoldiqni kiritish uchun "Boshqa kirim" moddasi bilan kirim to'lovi yarating.</p>
    <button data-act="newPayment" data-dir="in">${icon('arrowIn')}Kirim</button> <button data-act="newPayment" data-dir="out">${icon('arrowOut')}Chiqim</button></div>`;
}

// --- Hisobotlar ---

function profitRows(dateFilter) {
  const acc = {};
  db.docs.filter((d) => (d.type === 'sale' || d.type === 'salesReturn') && dateFilter(d.date)).forEach((d) => {
    const sign = d.type === 'sale' ? 1 : -1;
    const ls = linesSum(d);
    const k = ls ? docTotal(d) / ls : 1; // chegirmani qatorlarga taqsimlaymiz
    d.items.forEach((it) => {
      const a = (acc[it.productId] = acc[it.productId] || { qty: 0, revenue: 0, cost: 0 });
      a.qty += sign * it.qty;
      a.revenue += sign * it.qty * it.price * k;
      a.cost += sign * it.qty * (ctx.cost[it.productId] || 0);
    });
  });
  return Object.entries(acc).map(([pid, a]) => ({ p: product(pid) || { name: "(o'chirilgan)" }, ...a, profit: a.revenue - a.cost }));
}

function viewProfit() {
  const rows = profitRows((d) => inPeriod('profit', d)).sort((a, b) => b.profit - a.profit);
  const tot = rows.reduce((s, r) => ({ qty: s.qty + r.qty, revenue: s.revenue + r.revenue, cost: s.cost + r.cost, profit: s.profit + r.profit }), { qty: 0, revenue: 0, cost: 0, profit: 0 });
  const exp = {};
  db.payments.filter((p) => p.dir === 'out' && EXPENSE_PURPOSES.includes(p.purpose) && inPeriod('profit', p.date)).forEach((p) => { exp[p.purpose] = (exp[p.purpose] || 0) + p.amount; });
  const expTotal = Object.values(exp).reduce((s, v) => s + v, 0);
  const writeoffs = db.docs.filter((d) => d.type === 'writeoff' && inPeriod('profit', d.date))
    .reduce((s, d) => s + d.items.reduce((x, it) => x + it.qty * (ctx.cost[it.productId] || 0), 0), 0);
  const net = tot.profit - expTotal - writeoffs;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

  return toolbar('profit', { search: false, extra: periodInputs('profit') }) + `
    <div class="stats">
      <div class="stat"><div class="label">Savdo tushumi</div><div class="value">${money(tot.revenue)}</div></div>
      <div class="stat"><div class="label">Tannarx</div><div class="value">${money(tot.cost)}</div></div>
      <div class="stat"><div class="label">Yalpi foyda</div><div class="value">${money(tot.profit)}</div><div class="muted small">rentabellik ${pct(tot.profit, tot.revenue)}</div></div>
      <div class="stat"><div class="label">Xarajatlar + hisobdan chiqarish</div><div class="value">${money(expTotal + writeoffs)}</div></div>
      <div class="stat"><div class="label">Sof foyda</div><div class="value ${net < 0 ? 'debt' : 'ok'}">${money(net)}</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Mahsulotlar bo'yicha</h3><div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Soni</th><th class="num">Tushum</th><th class="num">Tannarx</th><th class="num">Foyda</th><th class="num">%</th></tr></thead><tbody>
        ${rows.length ? rows.map((r) => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.qty}</td><td class="num">${fmt(r.revenue)}</td><td class="num">${fmt(r.cost)}</td><td class="num ${r.profit < 0 ? 'debt' : ''}">${fmt(r.profit)}</td><td class="num">${pct(r.profit, r.revenue)}</td></tr>`).join('') : emptyRow(6, "Davrda savdo yo'q")}
      </tbody></table></div></div>
      <div class="card"><h3>Xarajatlar</h3><table><tbody>
        ${Object.entries(exp).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('')}
        <tr><td>Hisobdan chiqarilgan tovar (tannarx)</td><td class="num">${money(writeoffs)}</td></tr>
        <tr><td><b>Jami</b></td><td class="num"><b>${money(expTotal + writeoffs)}</b></td></tr>
      </tbody></table></div>
    </div>`;
}

function viewTop() {
  const rows = profitRows((d) => inPeriod('top', d));
  const byCat = {};
  rows.forEach((r) => {
    const c = r.p.category || 'Kategoriyasiz';
    byCat[c] = byCat[c] || { qty: 0, revenue: 0, profit: 0 };
    byCat[c].qty += r.qty;
    byCat[c].revenue += r.revenue;
    byCat[c].profit += r.profit;
  });
  const top = rows.slice().sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  const max = top[0]?.revenue || 1;
  const custs = {};
  db.docs.filter((d) => d.type === 'sale' && inPeriod('top', d.date)).forEach((d) => { custs[d.counterpartyId] = (custs[d.counterpartyId] || 0) + docTotal(d); });
  const topC = Object.entries(custs).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const sellers = {};
  db.docs.filter((d) => (d.type === 'sale' || d.type === 'salesReturn') && inPeriod('top', d.date)).forEach((d) => {
    const s = (sellers[d.userId || ''] = sellers[d.userId || ''] || { count: 0, sum: 0 });
    if (d.type === 'sale') s.count++;
    s.sum += (d.type === 'sale' ? 1 : -1) * docTotal(d);
  });
  return toolbar('top', { search: false, extra: periodInputs('top') }) + `
    <div class="card"><h3>Sotuvchilar bo'yicha</h3><table><thead><tr><th>Sotuvchi</th><th class="num">Jo'natishlar</th><th class="num">Savdo summasi</th></tr></thead><tbody>
      ${Object.entries(sellers).sort((a, b) => b[1].sum - a[1].sum).map(([id, s]) => `<tr><td>${esc(userName(id) || "Noma'lum")}</td><td class="num">${s.count}</td><td class="num">${money(s.sum)}</td></tr>`).join('') || emptyRow(3, "Davrda savdo yo'q")}
    </tbody></table></div>
    <div class="card"><h3>Eng ko'p sotilgan mahsulotlar</h3><table><thead><tr><th>Mahsulot</th><th class="num">Soni</th><th class="num">Tushum</th><th style="width:40%"></th></tr></thead><tbody>
      ${top.length ? top.map((r) => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.qty}</td><td class="num">${fmt(r.revenue)}</td><td><div class="bar" style="width:${Math.max(2, (r.revenue / max) * 100)}%"></div></td></tr>`).join('') : emptyRow(4, "Davrda savdo yo'q")}
    </tbody></table></div>
    <div class="grid2">
      <div class="card"><h3>Kategoriyalar bo'yicha</h3><table><thead><tr><th>Kategoriya</th><th class="num">Soni</th><th class="num">Tushum</th><th class="num">Foyda</th></tr></thead><tbody>
        ${Object.entries(byCat).sort((a, b) => b[1].revenue - a[1].revenue).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${v.qty}</td><td class="num">${fmt(v.revenue)}</td><td class="num">${fmt(v.profit)}</td></tr>`).join('') || emptyRow(4, "—")}
      </tbody></table></div>
      <div class="card"><h3>Eng yaxshi mijozlar</h3><table><thead><tr><th>Mijoz</th><th class="num">Xarid summasi</th></tr></thead><tbody>
        ${topC.map(([id, s]) => `<tr><td>${esc(party(id)?.name)}</td><td class="num">${money(s)}</td></tr>`).join('') || emptyRow(2, '—')}
      </tbody></table></div>
    </div>`;
}

// --- Sozlamalar ---

function viewCurrency() {
  const c = db.currency || {};
  const usdProducts = db.products.filter((p) => p.priceCurrency === 'USD' && !p.archived);
  return `<div class="card narrow"><h3>${icon('cash')}Dollar kursi</h3>
      <div class="rate-big">1 $ = <b>${usdRate() ? fmtRate(usdRate()) : '—'}</b> so'm</div>
      <p class="muted">${c.manual ? "Kurs qo'lda belgilangan." : c.source ? `Manba: ${esc(c.source)}${c.date ? `, ${fmtDate(c.date)} kursi` : ''}.` : "Kurs hali olinmagan."}
        ${c.updatedAt ? `Yangilangan: ${esc(new Date(c.updatedAt).toLocaleString('ru-RU'))}.` : ''}</p>
      <p class="muted small">Dastur kursni har 3 soatda O'zbekiston Markaziy bankidan (ishlamasa — zaxira manbadan) o'zi oladi. Dollardagi mahsulotlarning so'mdagi etiketka va eng kam narxi shu kurs bo'yicha avtomatik hisoblanadi va 1 000 so'mgacha yaxlitlanadi.</p>
      <div class="toolbar"><button class="primary" data-act="rateRefresh">${icon('download')}Hozir yangilash</button></div>
    </div>
    <div class="card narrow"><h3>${icon('edit')}Kursni qo'lda belgilash</h3>
      <p class="muted">Masalan, bozor kursi bilan ishlasangiz. Qo'lda belgilangan kurs avtomatik yangilanmaydi, toki "Avtomatikka qaytarish" bosilmaguncha.</p>
      <div class="form-grid"><label>1 $ = (so'm)<span class="money-wrap"><input id="rateManual" class="money" data-cur="USD" inputmode="decimal" value="${esc(fmtIn(usdRate() || '', 'USD'))}"><span class="cur">so'm</span></span></label></div>
      <div class="toolbar" style="margin-top:12px"><button data-act="rateManual">${icon('check')}Qo'lda belgilash</button>${c.manual ? `<button data-act="rateAuto">Avtomatikka qaytarish</button>` : ''}</div>
    </div>
    <div class="card narrow"><h3>${icon('tag')}Dollardagi mahsulotlar — ${usdProducts.length} ta</h3>
      <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Narx ($)</th><th class="num">Etiketka (so'm)</th><th class="num">Eng kami (so'm)</th></tr></thead><tbody>
      ${usdProducts.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtUsd(p.salePrice)}</td><td class="num">${fmt(salePriceUZS(p))}</td><td class="num">${p.minPrice ? fmt(minPriceUZS(p)) : '—'}</td></tr>`).join('') || emptyRow(4, "Dollarda narxlangan mahsulot yo'q")}
      </tbody></table></div>
    </div>`;
}

function viewUsers() {
  return `<div class="card narrow"><h3>Foydalanuvchilar</h3>
    <p class="muted"><b>Administrator</b> — hamma bo'limlar. <b>Sotuvchi</b> — faqat savdo (buyurtma, jo'natish, qaytarish), mijozlar, kirim to'lovlari va qoldiqlarni ko'rish; tannarx, foyda, xaridlar va sozlamalar unga ko'rinmaydi, o'zgalar hujjatlarini o'zgartira olmaydi va hech narsani o'chira olmaydi.</p>
    <table><thead><tr><th>Ism</th><th>Login</th><th>Roli</th><th>Holati</th><th></th></tr></thead><tbody>
    ${db.users.map((u) => `<tr><td>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(siz)</span>' : ''}</td><td>${esc(u.login)}</td>
      <td>${badge(ROLES[u.role], u.role === 'admin' ? 'admin' : '')}</td><td>${u.active === false ? badge('Bloklangan', 'cancel') : badge('Faol', 'done')}</td>
      <td class="actions"><button class="small" data-act="editUser" data-id="${u.id}">${icon('edit')}Tahrirlash</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:12px"><button class="primary" data-act="editUser">${icon('plus')}Foydalanuvchi</button></div></div>`;
}

function editUser(id) {
  const u = id ? db.users.find((x) => x.id === id) : { role: 'seller', active: true };
  const self = u.id === me.id;
  const server = backend.kind === 'supabase';
  // Supabase'da boshqa foydalanuvchi parolini faqat uning o'zi o'zgartiradi
  const canSetPassword = !id || self || backend.canSetOthersPassword;
  openModal({
    title: id ? 'Foydalanuvchi' : 'Yangi foydalanuvchi',
    body: `<div class="form-grid">
      ${field('Ism *', 'name', u.name, 'required')}
      ${field(server ? 'Email (login) *' : 'Login *', 'login', u.login, `required autocapitalize="none" autocomplete="off" ${server ? 'type="email"' : ''} ${server && id ? 'disabled' : ''}`)}
      ${selectField('Roli', 'role', Object.entries(ROLES), u.role, '', self ? 'disabled' : '')}
      ${selectField('Holati', 'active', [['1', 'Faol'], ['0', 'Bloklangan']], u.active === false ? '0' : '1', '', self ? 'disabled' : '')}
      ${canSetPassword
        ? field(id ? "Yangi parol (o'zgartirmaslik uchun bo'sh qoldiring)" : 'Parol * (kamida 6 belgi)', 'password', '', `type="password" autocomplete="new-password" ${id ? '' : 'required'}`, 'full')
        : '<p class="muted small full">Parolni foydalanuvchining o\'zi o\'zgartiradi (yuqoridagi ismi ustiga bosib). Unutgan bo\'lsa — uni bloklab, yangi email bilan qayta qo\'shing.</p>'}
    </div>`,
    onSubmit: async (d) => {
      const password = d.password || '';
      if (password && password.length < 6) {
        alert("Parol kamida 6 belgidan iborat bo'lsin.");
        return false;
      }
      const next = {
        id: u.id,
        name: d.name.trim(),
        login: server && id ? u.login : d.login.trim().toLowerCase(),
        role: self ? u.role : d.role,
        active: self ? true : d.active === '1',
      };
      try {
        if (self && password && server) await backend.changeOwnPassword(me, password);
        await backend.saveUser(next, self && server ? '' : password, !id);
      } catch (e) {
        alert(e.message);
        return false;
      }
      db.users = await backend.listUsers();
      if (self) Object.assign(me, { name: next.name });
      render();
      if (!id && server) alert(`Foydalanuvchi qo'shildi. U ${next.login} va siz bergan parol bilan kiradi.`);
    },
  });
}

function viewTelegram() {
  const tg = db.telegram;
  const sample = db.products.find((p) => p.photos?.length) || db.products[0];
  return `<div class="card narrow">
    <h3>Telegram guruhga e'lon</h3>
    <p class="muted">Yangi mahsulot qo'shishda va omborga kirim (Qabul qilish, Kirim qilish) qilishda dastur har safar "Telegram guruhga yuborilsinmi?" deb so'raydi — "Ha" yoki "Yo'q" tanlamaguncha saqlamaydi. "Ha" tanlansa, mahsulot rasmi va ma'lumotlari guruhga yuboriladi.</p>
    <ol class="muted small">
      <li>Telegramda <b>@BotFather</b> ga yozing → <code>/newbot</code> → bot nomini kiriting → u bergan <b>token</b> ni pastga joylang.</li>
      <li>Botni guruhingizga qo'shing va uni <b>administrator</b> qiling (xabar yuborish huquqi bilan).</li>
      <li>Guruhga istalgan xabar yozing, so'ng "Guruh ID sini aniqlash" tugmasini bosing. Ochiq kanal/guruh uchun <code>@guruh_nomi</code> ham yozish mumkin.</li>
    </ol>
    <div class="form-grid">
      <label class="full">Bot tokeni<input id="tgToken" value="${esc(tg.token)}" placeholder="123456789:AA..." autocomplete="off"></label>
      <label class="full">Guruh / kanal ID<input id="tgChat" value="${esc(tg.chatId)}" placeholder="-1001234567890 yoki @guruh_nomi"></label>
      <label class="check full"><input type="checkbox" id="tgShowQty" ${tg.showQty ? 'checked' : ''}> Ombordagi sonini ko'rsatish (aks holda faqat "bor / yo'q")</label>
    </div>
    <div class="toolbar" style="margin-top:12px">
      <button class="primary" data-act="tgSave">Saqlash</button>
      <button data-act="tgDetect">Guruh ID sini aniqlash</button>
      <button data-act="tgTest">Sinov xabari</button>
      <button data-act="tgAll">Barcha mavjud mahsulotlarni yuborish</button>
    </div>
    <p class="muted small">Diqqat: token shu brauzerda saqlanadi. Kompyuterga begona odamlar kirmasligiga ishonch hosil qiling.</p>
  </div>
  ${sample ? `<div class="card narrow"><h3>Namuna xabar</h3><div class="tg-preview">${sample.photos?.length ? `<img data-photo="${esc(sample.photos[0].path)}" alt="">` : ''}<div>${telegramCaption(sample).replace(/\n/g, '<br>')}</div></div></div>` : ''}
  <div class="card narrow"><h3>Yuborish jurnali</h3><table><tbody>
    ${tg.log.length ? tg.log.map((l) => `<tr><td class="muted small">${esc(l.at)}</td><td class="${l.ok ? '' : 'debt'}">${esc(l.text)}</td></tr>`).join('') : emptyRow(2, "Hali yuborilmagan")}
  </tbody></table></div>`;
}

function tgReadForm() {
  Object.assign(db.telegram, {
    token: $('#tgToken').value.trim(),
    chatId: $('#tgChat').value.trim(),
    showQty: $('#tgShowQty').checked,
  });
}

async function tgDetect() {
  tgReadForm();
  if (!db.telegram.token) return alert('Avval bot tokenini kiriting.');
  try {
    const res = await fetch(`https://api.telegram.org/bot${db.telegram.token}/getUpdates`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.description);
    const chats = new Map();
    json.result.forEach((u) => {
      const c = (u.message || u.my_chat_member || u.channel_post || {}).chat;
      if (c && c.type !== 'private') chats.set(c.id, c.title);
    });
    if (!chats.size) return alert("Guruh topilmadi. Bot guruhga qo'shilganini tekshiring va guruhga yangi xabar yozib, qayta urinib ko'ring.");
    const [id, title] = [...chats.entries()].pop();
    $('#tgChat').value = id;
    tgReadForm();
    save();
    alert(`Topildi: ${title} (${id}). Saqlandi.`);
  } catch (e) {
    alert('Xato: ' + e.message);
  }
}

async function tgTest() {
  tgReadForm();
  commit();
  const { token, chatId } = db.telegram;
  if (!token || !chatId) return alert('Token va guruh ID sini kiriting.');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `✅ ${db.company.name}: Biznes Tizim Telegram bilan ulandi.` }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.description);
    alert('Sinov xabari yuborildi.');
  } catch (e) {
    alert('Xato: ' + e.message);
  }
}

function viewCompany() {
  const c = db.company;
  return `<div class="card narrow"><h3>Kompaniya ma'lumotlari</h3><p class="muted">Chop etiladigan hujjatlarda va Telegram xabarlarida ko'rsatiladi.</p>
    <div class="form-grid">
      <label class="full">Nomi<input id="coName" value="${esc(c.name)}"></label>
      <label>Telefon<input id="coPhone" value="${esc(c.phone)}"></label>
      <label>Manzil<input id="coAddress" value="${esc(c.address)}"></label>
    </div><div class="toolbar" style="margin-top:12px"><button class="primary" data-act="coSave">Saqlash</button></div></div>`;
}

function viewWarehouses() {
  return `<div class="card narrow"><h3>Omborlar va do'konlar</h3><table><thead><tr><th>Nomi</th><th>Manzil</th><th class="num">Tovar soni</th><th></th></tr></thead><tbody>
    ${db.warehouses.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.address)}</td><td class="num">${db.products.reduce((s, p) => s + qtyIn(ctx.stock, p.id, w.id), 0)}</td>
      <td class="actions"><button class="small" data-act="editWh" data-id="${w.id}">${icon('edit')}Tahrirlash</button><button class="small danger icon-only" data-act="deleteWh" data-id="${w.id}" title="O'chirish">${icon('trash')}</button></td></tr>`).join('')}
    </tbody></table><div class="toolbar" style="margin-top:12px"><button class="primary" data-act="editWh">${icon('plus')}Ombor</button></div></div>`;
}

function editWarehouse(id) {
  const w = id ? warehouse(id) : {};
  openModal({
    title: id ? 'Ombor' : 'Yangi ombor',
    body: `<div class="form-grid">${field('Nomi *', 'name', w.name, 'required', 'full')}${field('Manzil', 'address', w.address, '', 'full')}</div>`,
    onSubmit: (d) => {
      if (id) Object.assign(w, { name: d.name.trim(), address: d.address.trim() });
      else db.warehouses.push({ id: uid(), name: d.name.trim(), address: d.address.trim() });
      save();
    },
  });
}

function deleteWarehouse(id) {
  if (db.warehouses.length === 1) return alert("Kamida bitta ombor bo'lishi kerak.");
  if (db.docs.some((d) => d.warehouseId === id || d.toWarehouseId === id)) return alert("Bu omborda hujjatlar bor, uni o'chirib bo'lmaydi.");
  if (!confirm("Ombor o'chirilsinmi?")) return;
  db.warehouses = db.warehouses.filter((w) => w.id !== id);
  save();
}

function editChip(v) {
  return `<span class="chip on" data-v="${esc(v)}">${esc(v)}<button type="button" class="chip-x" data-act="chipRemove" title="Olib tashlash" aria-label="${esc(v)} — olib tashlash">×</button></span>`;
}

function chipEditor(values, placeholder) {
  return `<div class="chips chips-edit">${values.map(editChip).join('')}<input class="chip-add" placeholder="${placeholder}" enterkeyhint="done"></div>`;
}

function catRow(name, types) {
  return `<div class="cat-row" data-orig="${esc(name)}">
    <div class="cat-head"><input class="cat-name" value="${esc(name)}" placeholder="Kategoriya nomi">
      <button type="button" class="small danger icon-only" data-act="catDel" title="Kategoriyani olib tashlash">${icon('trash')}</button></div>
    ${chipEditor(types, '+ Tur qo\'shish (Enter)')}
  </div>`;
}

function viewCategories() {
  return `<div class="card narrow"><h3>${icon('tag')}Kategoriyalar va turlar</h3>
      <p class="muted">Har bir kategoriyaning turlari mahsulot kartochkasida kategoriya tanlanganda chiqadi. Tur qo'shish uchun nomini yozib Enter bosing.</p>
      <div id="catRows">${db.categories.map((c) => catRow(c, db.categoryTypes[c] || [])).join('')}</div>
      <button type="button" data-act="catAdd">${icon('plus')}Kategoriya qo'shish</button>
    </div>
    <div class="card narrow"><h3>${icon('tag')}Ranglar</h3>
      <p class="muted">Mahsulot kartochkasida tanlanadigan ranglar (masalan, Dub beliy, Belaya korona, Oq gladkiy).</p>
      <div id="colorEditor">${chipEditor(db.colors, "+ Rang qo'shish (Enter)")}</div>
    </div>
    <div class="toolbar"><button class="primary" data-act="catSave">${icon('check')}Saqlash</button></div>`;
}

function viewBackup() {
  const server = backend.kind === 'supabase';
  return `<div class="card narrow"><h3>Zaxira nusxa</h3>
    <p class="muted">${server
      ? "Ma'lumotlar serverda saqlanadi. Shunga qaramay, haftada bir marta zaxira nusxa olib qo'ying. Rasmlar serverdagi xotirada qoladi, faylga faqat ularning manzili yoziladi."
      : "Ma'lumotlar shu brauzerda saqlanadi. Ularni yo'qotmaslik uchun har kuni zaxira nusxa oling. Fayl rasmlarni ham o'z ichiga oladi va undan serverga ko'chirishda ham foydalanish mumkin."}</p>
    <div class="toolbar">
      <button class="primary" data-act="backup">Zaxira nusxani yuklab olish (.json)</button>
      <label class="filebtn">Zaxiradan tiklash<input type="file" id="restoreInput" accept=".json,application/json" hidden></label>
    </div>
    <p class="muted small">Tiklashda joriy ma'lumotlar fayldagisi bilan to'liq almashtiriladi.</p></div>
    <div class="card narrow"><h3>Namuna ma'lumotlar</h3><p class="muted">Dasturni sinab ko'rish uchun bir nechta mahsulot, kontragent va hujjat qo'shadi.</p>
      <button data-act="demo">Namuna ma'lumotlarni yuklash</button></div>
    <div class="card narrow"><h3>Tozalash</h3><button class="danger" data-act="reset">Barcha ma'lumotlarni o'chirish</button></div>`;
}

let storageUsage = null;
async function refreshStorageUsage() {
  storageUsage = await backend.storageUsage().catch(() => null);
  if (['server', 'dashboard'].includes(currentRoute().view)) render();
}

function usageBar() {
  if (!storageUsage || !storageUsage.limit) return '<p class="muted">Ma\'lumot yo\'q</p>';
  const pct = Math.min(100, (storageUsage.used / storageUsage.limit) * 100);
  const mb = (b) => (b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB');
  return `<div class="usage"><div class="usage-bar ${pct >= 80 ? 'over' : ''}" style="width:${Math.max(1, pct)}%"></div></div>
    <p>${mb(storageUsage.used)} / ${mb(storageUsage.limit)} (${pct.toFixed(1)}%)
    ${pct >= 80 ? '<br><b class="debt">Joy tugab bormoqda.</b> Arxivdagi mahsulotlar rasmlarini o\'chiring yoki Supabase Pro tarifiga o\'ting.' : ''}</p>`;
}

function localDataSummary() {
  try {
    const d = JSON.parse(localStorage.getItem(LOCAL_DATA_KEY) || 'null');
    if (!d || !(d.products?.length || d.docs?.length)) return null;
    return { products: d.products?.length || 0, docs: d.docs?.length || 0, payments: d.payments?.length || 0 };
  } catch (e) {
    return null;
  }
}

function viewServer() {
  const server = backend.kind === 'supabase';
  const local = server && localDataSummary();
  return `<div class="card narrow"><h3>Server</h3>
    <p><b>${esc(backend.label)}</b></p>
    <p class="muted">${server
      ? "Barcha qurilmalar shu bitta bazada ishlaydi. Bir qurilmadagi o'zgarish boshqalarida bir necha soniyada ko'rinadi."
      : "Ma'lumotlar faqat shu qurilmada. Sotuvchilar telefondan ishlashi uchun Supabase serveriga ulaning (README → \"Supabase'ni sozlash\")."}</p>
    <button class="primary" data-act="serverSettings">${server ? 'Ulanish sozlamalari' : 'Serverga ulanish'}</button></div>
    <div class="card narrow"><h3>${server ? 'Rasmlar xotirasi (bepul tarif — 1 GB)' : 'Brauzer xotirasi'}</h3>${usageBar()}
      <button class="small" data-act="refreshUsage">Yangilash</button></div>
    ${local ? `<div class="card narrow"><h3>Lokal ma'lumotlarni serverga ko'chirish</h3>
      <p class="muted">Shu brauzerda serverga ulanishdan oldin kiritilgan ma'lumotlar topildi: ${local.products} ta mahsulot, ${local.docs} ta hujjat, ${local.payments} ta to'lov. Ular rasmlari bilan birga serverdagi ma'lumotlarga qo'shiladi.</p>
      <button class="primary" data-act="migrateLocal">Serverga ko'chirish</button></div>` : ''}`;
}

// Hujjat raqamlaridagi eng katta sonni topamiz — tiklangandan keyin raqamlar takrorlanmasligi uchun
function countersFromData(data) {
  const seq = Object.assign({}, data.seq);
  const bump = (kind, no) => {
    const n = parseInt(String(no || '').split('-').pop(), 10);
    if (n) seq[kind] = Math.max(seq[kind] || 0, n);
  };
  (data.docs || []).forEach((d) => bump(d.type, d.no));
  (data.payments || []).forEach((p) => bump(p.dir === 'in' ? 'payIn' : 'payOut', p.no));
  return seq;
}

// merge=true — mavjud ma'lumotlarga qo'shadi; false — to'liq almashtiradi
async function importData(data, merge, progress = () => {}) {
  if (!Array.isArray(data.products) || !Array.isArray(data.docs)) throw new Error('Bu Biznes Tizim zaxira fayli emas');
  const incoming = normalizeDb(JSON.parse(JSON.stringify(data)));
  const total = incoming.products.reduce((s, p) => s + (p.photo?.startsWith('data:') ? 1 : 0) + (p.photos || []).filter((ph) => ph.data).length, 0);
  let done = 0;
  for (const p of incoming.products) {
    const sources = [];
    if (p.photo?.startsWith('data:')) sources.push(p.photo);
    delete p.photo;
    const photos = [];
    for (const ph of p.photos || []) {
      if (ph.data) sources.push(ph.data); else if (ph.path) photos.push({ path: ph.path, thumb: ph.thumb });
    }
    for (const src of sources) {
      progress(++done, total);
      photos.push(await backend.uploadPhoto(await dataUrlToBlob(src)));
    }
    p.photos = photos;
  }
  // Boshqa tizimdagi foydalanuvchilar nomlari hisobotlarda saqlanib qolsin
  const known = new Set(db.users.map((u) => u.id));
  const legacy = Object.assign({}, db.legacyUsers, incoming.legacyUsers);
  (data.users || []).forEach((u) => { if (!known.has(u.id)) legacy[u.id] = u.name; });

  if (merge) {
    ['warehouses', 'counterparties', 'products', 'docs', 'payments'].forEach((t) => {
      const byId = new Map(db[t].map((x) => [x.id, x]));
      incoming[t].forEach((x) => byId.set(x.id, x));
      db[t] = [...byId.values()];
    });
    db.categories = [...new Set([...db.categories, ...incoming.categories])];
  } else {
    incoming.users = db.users;
    db = incoming;
  }
  db.legacyUsers = legacy;
  await backend.setCounters(countersFromData(data));
  await save();
}

async function runImport(data, merge) {
  showLoading(true, "Ma'lumotlar yuklanmoqda...");
  try {
    await importData(data, merge, (n, total) => showLoading(true, `Rasmlar yuklanmoqda: ${n} / ${total}`));
    alert(merge ? "Ma'lumotlar serverga ko'chirildi." : 'Tiklandi.');
  } catch (e) {
    alert("Xato: " + e.message);
  } finally {
    showLoading(false);
  }
}

async function backupData() {
  let data;
  if (backend.kind === 'local') {
    showLoading(true, 'Zaxira tayyorlanmoqda...');
    try { data = await backend.exportWithPhotos(); } finally { showLoading(false); }
  } else {
    data = JSON.parse(JSON.stringify(db));
    data.seq = countersFromData(data);
  }
  data.users = db.users.map(({ id, name, login, role }) => ({ id, name, login, role }));
  data.exportedAt = new Date().toISOString();
  download(`biznes-tizim-zaxira-${today()}.json`, JSON.stringify(data), 'application/json');
}

async function migrateLocal() {
  if (!confirm("Lokal ma'lumotlar (rasmlari bilan) serverga qo'shilsinmi?")) return;
  showLoading(true, "Lokal ma'lumotlar o'qilmoqda...");
  let data;
  try {
    const local = new LocalBackend();
    await local.init();
    data = await local.exportWithPhotos();
  } catch (e) {
    showLoading(false);
    alert('Xato: ' + e.message);
    return;
  }
  await runImport(data, true);
  if (confirm("Ko'chirish tugadi. Lokal nusxa shu brauzerdan o'chirilsinmi? (Serverdagi ma'lumotlarga ta'sir qilmaydi)")) {
    localStorage.removeItem(LOCAL_DATA_KEY);
    render();
  }
}

async function loadDemo() {
  if (db.products.length && !confirm("Namuna ma'lumotlar mavjud ma'lumotlarga qo'shiladi. Davom etilsinmi?")) return;
  const sup = { id: uid(), name: '"Mebel Lux" MChJ', kind: 'supplier', phone: '+998 71 200 00 00', address: 'Toshkent, Chilonzor', inn: '301234567', note: '' };
  const cus = { id: uid(), name: 'Aliyev Jamshid', kind: 'customer', phone: '+998 90 111 22 33', address: "Toshkent, Yunusobod 4-kvartal", inn: '', note: '' };
  db.counterparties.push(sup, cus);
  const mk = (name, category, size, color, material, origin, buyPrice, salePrice) =>
    ({ id: uid(), name, code: 'A' + String(db.products.length + 101), category, size, color, material, origin, maker: '', unit: 'dona', buyPrice, salePrice, minQty: 1, note: '', photos: [] });
  const ps = [];
  for (const args of [
    ['Yotoqxona to\'plami "Milano"', 'Yotoqxona', '200 × 180 × 110', 'Oq / oltin', 'MDF, LDSP', 'Turkiya, Istanbul', 18000000, 24500000],
    ['Burchak divan "Oskar"', 'Divan va kreslo', '280 × 180 × 90', 'Kulrang', 'Velyur, yog\'och karkas', "O'zbekiston, Toshkent", 6500000, 9200000],
    ['Oshxona stoli + 6 stul "Verona"', 'Stol va stul', '160 × 90 × 76', "Yong'oq", 'Massiv (buk)', 'Malayziya', 4200000, 6300000],
    ['Shkaf-kupe 3 eshikli', 'Shkaf', '240 × 60 × 240', 'Sonoma eman', 'LDSP, oyna', "O'zbekiston, Samarqand", 3900000, 5600000],
    ['Ortopedik matras "Comfort"', 'Matras', '160 × 200 × 25', 'Oq', 'Mustaqil prujina', 'Rossiya', 1800000, 2700000],
  ]) {
    const p = mk(...args);
    db.products.push(p);
    ps.push(p);
  }
  ['Yotoqxona to\'plami', 'Burchak divan', 'Stol-stul to\'plami', 'Shkaf-kupe', 'Ortopedik matras'].forEach((t, i) => { ps[i].type = t; });
  // Kurs hali olinmagan bo'lsa (internet yo'q) — namuna uchun taxminiy kurs
  if (!usdRate()) db.currency = { rate: 12800, date: today(), source: 'Namuna kurs', updatedAt: '', manual: false };
  ['Dub beliy, Oltin', 'Kulrang', "Yong'oq", 'Dub sonoma', 'Oq gladkiy'].forEach((c, i) => { ps[i].color = c; });
  // Turkiyadan keladigan to'plam dollarda narxlanadi
  Object.assign(ps[0], { priceCurrency: 'USD', buyPrice: 1400, salePrice: 1950, minPrice: 1800 });
  [8500000, 5800000, 5100000, 2450000].forEach((m, i) => { ps[i + 1].minPrice = m; });
  const d0 = new Date();
  const ago = (n) => localDate(new Date(d0 - n * 864e5));
  const wh = db.warehouses[0].id;
  const base = { created: new Date().toISOString(), userId: me.id, warehouseId: wh, note: '', discount: 0 };
  const rec = { ...base, id: uid(), type: 'receipt', no: await nextNo('receipt'), date: ago(10), counterpartyId: sup.id, items: ps.map((p, i) => ({ productId: p.id, qty: [2, 3, 2, 4, 6][i], price: toUZS(p.buyPrice, p.priceCurrency) })) };
  const sale = { ...base, id: uid(), type: 'sale', no: await nextNo('sale'), date: ago(2), counterpartyId: cus.id, status: 'pending', deliveryDate: ago(-1), address: cus.address, discount: 200000, items: [{ productId: ps[1].id, qty: 1, price: ps[1].salePrice }, { productId: ps[4].id, qty: 2, price: ps[4].salePrice }] };
  const order = { ...base, id: uid(), type: 'order', no: await nextNo('order'), date: ago(1), counterpartyId: cus.id, status: 'confirmed', deliveryDate: ago(-5), address: cus.address, items: [{ productId: ps[0].id, qty: 1, price: salePriceUZS(ps[0]) }] };
  db.docs.push(rec, sale, order);
  const pay = async (dir, date, amount, method, purpose, counterpartyId, docId, note = '') => ({
    id: uid(), no: await nextNo(dir === 'in' ? 'payIn' : 'payOut'), dir, date, amount, method, purpose, counterpartyId, docId, note, userId: me.id,
  });
  db.payments.push(
    await pay('out', ago(9), 50000000, 'bank', "Ta'minotchiga to'lov", sup.id, rec.id),
    await pay('in', ago(2), 8000000, 'cash', "Mijozdan to'lov", cus.id, sale.id),
    await pay('in', ago(1), 5000000, 'card', "Mijozdan to'lov", cus.id, order.id, "Oldindan to'lov"),
    await pay('out', ago(3), 4000000, 'cash', 'Ijara', null, null, "Do'kon ijarasi"),
  );
  await save();
  location.hash = '#dashboard';
}

// ---------- Chizish va navigatsiya ----------

const VIEWS = {
  dashboard: viewDashboard, products: viewProducts, stock: viewStock, parties: viewParties, debts: viewDebts,
  payments: viewPayments, cash: viewCash, profit: viewProfit, top: viewTop, users: viewUsers,
  telegram: viewTelegram, company: viewCompany, warehouses: viewWarehouses, categories: viewCategories, backup: viewBackup,
  server: viewServer, currency: viewCurrency,
};

function render() {
  // Hisob bloklangan yoki o'chirilgan bo'lsa (boshqa qurilmadan) — tizimdan chiqaramiz
  if (me && db.users.length && !db.users.some((u) => u.id === me.id && u.active !== false)) {
    me = null;
    logout();
    return;
  }
  $('#auth').hidden = !!me;
  $('#app').hidden = !me;
  if (!me) {
    if ($('#modal').open) closeModal();
    renderAuth();
    return;
  }
  me = Object.assign(me, db.users.find((u) => u.id === me.id));
  $('#authForm').innerHTML = '';
  $('#userName').innerHTML = `<b>${esc(me.name)}</b><span>${ROLES[me.role]}</span>`;
  $('#rateBox').innerHTML = usdRate() ? `${icon('cash')}<span>1 $ = <b>${fmtRate(usdRate())}</b> so'm</span>` : '';
  $('#syncBanner').hidden = !syncState.offline;
  refreshCtx();
  const { section, view } = currentRoute();
  $('#sections').innerHTML = visibleSections().map((s) => `<a href="#${s.id}" class="${s === section ? 'active' : ''}">${icon(s.icon)}<span>${s.title}</span></a>`).join('');
  const sub = section.views && visibleViews(section).find((v) => v[0] === view);
  $('#pageHead').innerHTML = `<h1>${icon(section.icon)}${esc(sub && section.id !== 'dashboard' ? viewTitle(sub) : section.title)}</h1>
    ${section.id === 'dashboard' ? `<span class="date">${longDate(new Date())}</span>` : ''}`;
  $('#subnav').innerHTML = section.views
    ? visibleViews(section).map((v) => `<a href="#${section.id}/${v[0]}" class="${v[0] === view ? 'active' : ''}">${esc(viewTitle(v))}</a>`).join('')
    : '';
  $('#subnav').hidden = !section.views;
  const focused = document.activeElement?.dataset?.filter;
  const caret = document.activeElement?.selectionStart;
  $('#view').innerHTML = (VIEWS[view] || ((v) => viewDocs(v)))(view);
  hydratePhotos($('#view'));
  // Qidiruv maydonida yozayotganda fokusni saqlaymiz
  if (focused) {
    const el = $(`[data-filter="${focused}"]`);
    if (el) {
      el.focus();
      if (caret != null && el.setSelectionRange && el.type !== 'date') el.setSelectionRange(caret, caret);
    }
  }
}

window.addEventListener('hashchange', render);

document.addEventListener('input', (e) => {
  const f = e.target.dataset?.filter;
  if (!f) return;
  filters[f] = e.target.value;
  render();
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'restoreInput') return;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  file.text().then((text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      alert("Faylni o'qib bo'lmadi: " + err.message);
      return;
    }
    if (!confirm("Joriy ma'lumotlar zaxiradagisi bilan to'liq almashtiriladi. Davom etilsinmi?")) return;
    runImport(data, false);
  });
});

const ACTIONS = {
  newDoc: (ds) => openDoc(ds.type),
  openDoc: (ds) => { const d = doc(ds.id); if (d) openDoc(d.type, d); },
  exportDocs: (ds) => exportDocs(ds.type),
  newProduct: () => newProduct(),
  editProduct: (ds) => editProduct(ds.id),
  deleteProduct: (ds) => deleteProduct(ds.id),
  unarchive: (ds) => { product(ds.id).archived = false; save(); },
  productHistory: (ds) => productHistory(ds.id),
  exportProducts: () => exportProducts(),
  tgProduct: (ds) => telegramPostProducts([ds.id], true),
  newParty: () => newParty(filterVal('parties.kind') || 'customer'),
  editParty: (ds) => editParty(ds.id),
  deleteParty: (ds) => deleteParty(ds.id),
  statement: (ds) => partyStatement(ds.id),
  newPayment: (ds) => newPayment(ds.dir),
  deletePayment: (ds) => deletePayment(ds.id),
  print: () => window.print(),
  tgSave: () => { tgReadForm(); save(); alert('Saqlandi.'); },
  tgDetect: () => tgDetect(),
  tgTest: () => tgTest(),
  tgAll: () => {
    const ids = db.products.filter((p) => !p.archived && qtyIn(ctx.stock, p.id) > 0).map((p) => p.id);
    if (!ids.length) return alert("Omborda mahsulot yo'q.");
    if (confirm(`${ids.length} ta mahsulot guruhga yuborilsinmi? Telegram cheklovi sababli har biri ~4 soniyada (jami ~${Math.ceil(ids.length * 4 / 60)} daqiqa); shu vaqt sahifani yopmang.`)) { tgReadForm(); commit(); telegramPostProducts(ids, true); }
  },
  coSave: () => {
    Object.assign(db.company, { name: $('#coName').value.trim(), phone: $('#coPhone').value.trim(), address: $('#coAddress').value.trim() });
    save();
    alert('Saqlandi.');
  },
  editWh: (ds) => editWarehouse(ds.id),
  deleteWh: (ds) => deleteWarehouse(ds.id),
  catSave: () => {
    const categories = [];
    const types = {};
    const renames = [];
    $$('#catRows .cat-row').forEach((row) => {
      const name = $('.cat-name', row).value.trim();
      if (!name || categories.includes(name)) return;
      categories.push(name);
      types[name] = $$('.chip', row).map((c) => c.dataset.v);
      if (row.dataset.orig && row.dataset.orig !== name) renames.push([row.dataset.orig, name]);
    });
    // Nomi o'zgargan kategoriya mahsulotlarda ham yangilanadi
    renames.forEach(([from, to]) => db.products.forEach((p) => { if (p.category === from) p.category = to; }));
    db.categories = categories;
    db.categoryTypes = types;
    db.colors = $$('#colorEditor .chip').map((c) => c.dataset.v);
    save();
    alert('Saqlandi.');
  },
  backup: () => backupData(),
  demo: () => loadDemo(),
  reset: () => {
    if (!confirm("Barcha ma'lumotlar o'chiriladi. Zaxira nusxa olganmisiz?")) return;
    if (backend.kind === 'supabase' && !confirm("DIQQAT: serverdagi ma'lumotlar BARCHA qurilmalarda o'chadi va qaytarib bo'lmaydi. Rostdan ham o'chirilsinmi?")) return;
    db = Object.assign(emptyDb(), { users: db.users });
    save();
  },
  editUser: (ds) => editUser(ds.id),
  chipToggle: (ds, el) => { el.classList.toggle('on'); syncChips(el.closest('.chips')); },
  chipRemove: (ds, el) => el.closest('.chip').remove(),
  catAdd: () => {
    $('#catRows').insertAdjacentHTML('beforeend', catRow('', []));
    $('#catRows .cat-row:last-child .cat-name').focus();
  },
  catDel: (ds, el) => {
    const row = el.closest('.cat-row');
    const used = db.products.filter((p) => p.category === row.dataset.orig).length;
    if (used && !confirm(`"${row.dataset.orig}" kategoriyasida ${used} ta mahsulot bor. Kategoriya ro'yxatdan olib tashlansinmi? (mahsulotlar o'chmaydi)`)) return;
    row.remove();
  },
  serverSettings: () => openServerSettings(),
  rateRefresh: () => refreshRate(true),
  rateManual: () => {
    const v = num($('#rateManual').value);
    if (!(v > 0)) return alert('Kursni kiriting.');
    db.currency = { rate: v, date: today(), source: "Qo'lda", updatedAt: new Date().toISOString(), manual: true };
    save();
  },
  rateAuto: () => {
    db.currency = Object.assign({}, db.currency, { manual: false, updatedAt: '' });
    refreshRate(true);
  },
  refreshUsage: () => refreshStorageUsage(),
  migrateLocal: () => migrateLocal(),
};

// Sotuvchi tugmani ko'rmasa ham, bu amallarni bajara olmasligi kerak
const ADMIN_ACTIONS = ['newProduct', 'deleteProduct', 'unarchive', 'exportProducts', 'tgProduct', 'deleteParty', 'deletePayment',
  'tgSave', 'tgDetect', 'tgTest', 'tgAll', 'coSave', 'editWh', 'deleteWh', 'catSave', 'catAdd', 'catDel', 'chipRemove', 'backup', 'demo', 'reset', 'editUser', 'exportDocs',
  'serverSettings', 'refreshUsage', 'migrateLocal', 'rateRefresh', 'rateManual', 'rateAuto'];

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#modal') && !el.closest('#modalBody')) return;
  e.preventDefault();
  if (ADMIN_ACTIONS.includes(el.dataset.act) && !isAdmin()) return;
  ACTIONS[el.dataset.act]?.(el.dataset, el);
});

// Teg-katakchalar: Enter bilan yangi qiymat qo'shish (mahsulot materiali va Sozlamalardagi ro'yxatlar)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList?.contains('chip-add')) return;
  e.preventDefault();
  const input = e.target;
  const v = input.value.trim();
  if (!v) return;
  const box = input.closest('.chips');
  const exists = $$('[data-v]', box).find((c) => c.dataset.v.toLowerCase() === v.toLowerCase());
  if (exists) {
    exists.classList.add('on');
  } else if (box.classList.contains('chips-pick')) {
    input.insertAdjacentHTML('beforebegin', `<button type="button" class="chip on" data-act="chipToggle" data-v="${esc(v)}">${esc(v)}</button>`);
  } else {
    input.insertAdjacentHTML('beforebegin', editChip(v));
  }
  input.value = '';
  syncChips(box);
});

$('#authForm').addEventListener('submit', onAuthSubmit);
$('#logoutBtn').addEventListener('click', logout);
$('#logoutBtn').innerHTML = icon('logout');
$('#brandMark').innerHTML = icon('sofa');
$('#authLogo').innerHTML = icon('sofa');

// Mavzu: mayin jigarrang (kunduzgi) yoki tungi. Har bir qurilmada alohida eslab qolinadi.
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  $('#themeBtn').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('#themeBtn').title = theme === 'dark' ? 'Kunduzgi mavzu' : 'Tungi mavzu';
  try { localStorage.setItem('biznes-tizim-theme', theme); } catch (e) { /* xotira yopiq */ }
}
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('#userName').addEventListener('click', (e) => { e.preventDefault(); editUser(me.id); });

async function start() {
  backend = createBackend();
  showLoading(true);
  try {
    await backend.init();
    me = await backend.restoreSession().catch((e) => { authMessage = e.message; return null; });
    if (me) await loadData();
    else authNeedsSetup = !(await backend.hasUsers());
  } catch (e) {
    console.error(e);
    authMessage = e.message;
  } finally {
    showLoading(false);
  }
  render();
}

start();

// Telefon ilovasi (Capacitor) o'z fayllarini o'zi beradi — service worker faqat brauzer uchun
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e));
}
