'use strict';

/*
 * Biznes Tizim — mebel do'koni uchun ombor va savdo hisobi.
 * Hisob hujjatlarga asoslangan: tovar qoldig'i va kontragent qarzlari
 * saqlanmaydi, balki hujjatlar (qabul qilish, jo'natish, qaytarish...)
 * va to'lovlardan har safar hisoblab chiqiladi.
 */

const STORAGE_KEY = 'biznes-tizim-v1';

// ---------- Ma'lumotnomalar ----------

const ORDER_STATUSES = { new: 'Yangi', confirmed: 'Tasdiqlandi', making: 'Tayyorlanmoqda', shipped: "Jo'natildi", cancel: 'Bekor qilindi' };
const PO_STATUSES = { new: 'Yangi', sent: 'Yuborildi', received: 'Qabul qilindi', cancel: 'Bekor qilindi' };
const DELIVERY_STATUSES = { pending: 'Yetkazilishi kerak', onway: "Yo'lda", delivered: 'Yetkazildi' };

// stock: ombor qoldig'iga ta'siri; money: kontragent bizga qarzi qanday o'zgaradi;
// pay: hujjat bo'yicha to'lov yo'nalishi; next: shu hujjat asosida yaratiladigan hujjat.
const DOC_TYPES = {
  purchaseOrder: { list: "Ta'minotchiga buyurtmalar", one: "Ta'minotchiga buyurtma", prefix: 'TB', party: 'supplier', price: 'buy', stock: 0, money: 0, statuses: PO_STATUSES, pay: 'out', next: 'receipt' },
  receipt: { list: 'Qabul qilish', one: 'Qabul qilish', prefix: 'QQ', party: 'supplier', price: 'buy', stock: 1, money: -1, pay: 'out', next: 'purchaseReturn' },
  purchaseReturn: { list: "Ta'minotchiga qaytarish", one: "Ta'minotchiga qaytarish", prefix: 'TQ', party: 'supplier', price: 'buy', stock: -1, money: 1, pay: 'in' },
  order: { list: 'Mijoz buyurtmalari', one: 'Mijoz buyurtmasi', prefix: 'MB', party: 'customer', price: 'sale', stock: 0, money: 0, statuses: ORDER_STATUSES, pay: 'in', delivery: true, next: 'sale' },
  sale: { list: "Jo'natish (sotuv)", one: "Jo'natish", prefix: 'S', party: 'customer', price: 'sale', stock: -1, money: 1, statuses: DELIVERY_STATUSES, pay: 'in', delivery: true, next: 'salesReturn' },
  salesReturn: { list: 'Mijozdan qaytarish', one: 'Mijozdan qaytarish', prefix: 'MQ', party: 'customer', price: 'sale', stock: 1, money: -1, pay: 'out' },
  enter: { list: 'Kirim qilish', one: 'Kirim qilish', prefix: 'K', price: 'buy', stock: 1, money: 0 },
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

// ---------- Ma'lumotlar ombori ----------

function emptyDb() {
  return {
    products: [],
    counterparties: [{ id: 'retail', name: 'Chakana xaridor', kind: 'customer', phone: '', address: '', inn: '', note: '' }],
    warehouses: [{ id: 'main', name: 'Asosiy ombor', address: '' }],
    docs: [],
    payments: [],
    categories: DEFAULT_CATEGORIES.slice(),
    seq: {},
    company: { name: 'KAO Mebel', phone: '', address: '' },
    telegram: { token: '', chatId: '', onReceipt: true, onNewProduct: true, showQty: true, log: [] },
    users: [],
  };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const base = emptyDb();
      return Object.assign(base, data, { telegram: Object.assign(base.telegram, data.telegram) });
    }
  } catch (e) {
    console.error(e);
  }
  return emptyDb();
}

let db = loadDb();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    alert("Ma'lumotlarni saqlab bo'lmadi (brauzer xotirasi to'lgan bo'lishi mumkin — rasmlar hajmini kamaytiring): " + e.message);
  }
}

function save() {
  persist();
  render();
}

// ---------- Foydalanuvchilar va kirish ----------

const ROLES = { admin: 'Administrator', seller: 'Sotuvchi' };
const SESSION_KEY = 'biznes-tizim-session';

let me = null;
const isAdmin = () => me?.role === 'admin';

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setPassword(user, password) {
  user.salt = uid() + uid();
  user.passHash = await hashPassword(password, user.salt);
}

function restoreSession() {
  let id = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch (e) { /* xotira yopiq */ }
  me = db.users.find((u) => u.id === id && u.active !== false) || null;
}

function setSession(user) {
  me = user;
  try {
    if (user) localStorage.setItem(SESSION_KEY, user.id);
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) { /* xotira yopiq */ }
}

function renderAuth() {
  const setup = !db.users.length;
  $('#authSubtitle').textContent = setup
    ? "Birinchi ishga tushirish: administrator hisobini yarating."
    : 'Tizimga kirish';
  $('#authForm').innerHTML = `
    ${setup ? '<label>Ismingiz<input name="name" required autocomplete="name"></label>' : ''}
    <label>Login<input name="login" required autocomplete="username" autocapitalize="none"></label>
    <label>Parol<input name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    ${setup ? '<label>Parolni takrorlang<input name="password2" type="password" required autocomplete="new-password"></label>' : ''}
    <div class="auth-error" id="authError"></div>
    <button class="primary" type="submit">${setup ? 'Yaratish va kirish' : 'Kirish'}</button>`;
  $('#authForm [name=login]')?.focus();
  if (setup) $('#authForm [name=name]').focus();
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  const err = (t) => { $('#authError').textContent = t; };
  const login = (d.login || '').trim().toLowerCase();
  if (!login || !d.password) return err('Login va parolni kiriting.');

  if (!db.users.length) {
    if (!d.name.trim()) return err('Ismingizni kiriting.');
    if (d.password.length < 4) return err("Parol kamida 4 belgidan iborat bo'lsin.");
    if (d.password !== d.password2) return err('Parollar mos emas.');
    const u = { id: uid(), name: d.name.trim(), login, role: 'admin', active: true, created: today() };
    await setPassword(u, d.password);
    db.users.push(u);
    persist();
    setSession(u);
    render();
    return;
  }

  const u = db.users.find((x) => x.login === login);
  if (!u || u.passHash !== await hashPassword(d.password, u.salt)) return err("Login yoki parol noto'g'ri.");
  if (u.active === false) return err('Bu hisob bloklangan. Administratorga murojaat qiling.');
  setSession(u);
  location.hash = '#dashboard';
  render();
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const product = (id) => db.products.find((p) => p.id === id);
const party = (id) => db.counterparties.find((c) => c.id === id);
const warehouse = (id) => db.warehouses.find((w) => w.id === id);
const doc = (id) => db.docs.find((d) => d.id === id);

function nextNo(type) {
  db.seq[type] = (db.seq[type] || 0) + 1;
  return `${DOC_TYPES[type]?.prefix || 'P'}-${String(db.seq[type]).padStart(5, '0')}`;
}

function linesSum(d) {
  return d.items.reduce((s, it) => s + it.qty * it.price, 0);
}
function docTotal(d) {
  return Math.max(0, linesSum(d) - (d.discount || 0));
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
function computeStock(excludeId) {
  const st = {};
  const add = (pid, wh, q) => {
    st[pid] = st[pid] || {};
    st[pid][wh] = (st[pid][wh] || 0) + q;
  };
  db.docs.forEach((d) => {
    if (d.id === excludeId) return;
    const t = DOC_TYPES[d.type];
    if (t.move) {
      d.items.forEach((it) => { add(it.productId, d.warehouseId, -it.qty); add(it.productId, d.toWarehouseId, it.qty); });
    } else if (t.stock) {
      d.items.forEach((it) => add(it.productId, d.warehouseId, t.stock * it.qty));
    }
  });
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
      a.s += it.qty * it.price;
    });
  });
  const cost = {};
  db.products.forEach((p) => {
    const a = acc[p.id];
    cost[p.id] = a && a.q ? a.s / a.q : p.buyPrice || 0;
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
  // onSubmit false qaytarsa oyna yopilmaydi
  const result = modalState.onSubmit ? await modalState.onSubmit(data) : undefined;
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

const whOptions = () => db.warehouses.map((w) => [w.id, w.name]);

// ---------- Mahsulotlar ----------

function productForm(p = {}) {
  const cats = [['', '—'], ...db.categories.map((c) => [c, c])];
  return `<div class="product-form">
    <div class="photo-box">
      <img id="photoPreview" src="${p.photo || ''}" ${p.photo ? '' : 'hidden'} alt="">
      <div id="photoEmpty" class="muted" ${p.photo ? 'hidden' : ''}>Rasm yo'q</div>
      <label class="filebtn">Rasm tanlash<input type="file" id="photoInput" accept="image/*" hidden></label>
      <button type="button" class="small" id="photoRemove">Rasmni olib tashlash</button>
      <input type="hidden" name="photo" value="${esc(p.photo || '')}">
    </div>
    <div class="form-grid">
      ${field('Nomi *', 'name', p.name, 'required', 'full')}
      ${field('Kod / artikul', 'code', p.code)}
      ${selectField('Kategoriya', 'category', cats, p.category || '')}
      ${field("O'lchami (E×Ch×B, sm)", 'size', p.size, 'placeholder="200 × 160 × 45"')}
      ${field('Rangi', 'color', p.color, 'placeholder="Oq, yong\'oq..."')}
      ${field('Materiali', 'material', p.material, 'placeholder="LDSP, MDF, massiv..."')}
      ${field('Ishlab chiqarilgan joyi', 'origin', p.origin, 'placeholder="O\'zbekiston, Toshkent / Turkiya..."')}
      ${field('Ishlab chiqaruvchi (fabrika)', 'maker', p.maker)}
      ${field("O'lchov birligi", 'unit', p.unit || 'dona')}
      ${isAdmin() ? field('Kelish narxi', 'buyPrice', p.buyPrice ?? '', 'inputmode="numeric"') : ''}
      ${field('Sotish narxi *', 'salePrice', p.salePrice ?? '', 'inputmode="numeric" required')}
      ${field('Minimal qoldiq', 'minQty', p.minQty ?? 1, 'type="number" min="0"')}
      ${p.id ? '' : field("Boshlang'ich qoldiq", 'initQty', 0, 'type="number" min="0"')}
      ${p.id ? '' : selectField('Ombor', 'initWh', whOptions(), db.warehouses[0].id)}
      ${textArea('Tavsif', 'note', p.note)}
    </div>
  </div>`;
}

// Rasmni brauzer xotirasini to'ldirmasligi uchun kichraytirib JPEG ga o'tkazamiz
function resizeImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function bindProductForm() {
  const hidden = $('#modalForm [name=photo]');
  const show = (src) => {
    hidden.value = src;
    $('#photoPreview').src = src;
    $('#photoPreview').hidden = !src;
    $('#photoEmpty').hidden = !!src;
  };
  $('#photoInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) show(await resizeImage(f));
  });
  $('#photoRemove').addEventListener('click', () => show(''));
}

function readProduct(d, p) {
  return Object.assign(p, {
    name: d.name.trim(),
    code: d.code.trim(),
    category: d.category,
    size: d.size.trim(),
    color: d.color.trim(),
    material: d.material.trim(),
    origin: d.origin.trim(),
    maker: d.maker.trim(),
    unit: d.unit.trim() || 'dona',
    buyPrice: num(d.buyPrice),
    salePrice: num(d.salePrice),
    minQty: num(d.minQty),
    note: d.note.trim(),
    photo: d.photo,
  });
}

function newProduct() {
  openModal({
    title: 'Yangi mahsulot',
    body: productForm(),
    wide: true,
    onOpen: bindProductForm,
    onSubmit: (d) => {
      const p = readProduct(d, { id: uid(), created: today() });
      db.products.push(p);
      const qty = num(d.initQty);
      let entry = null;
      if (qty > 0) {
        entry = {
          id: uid(), type: 'enter', no: nextNo('enter'), date: today(), warehouseId: d.initWh,
          items: [{ productId: p.id, qty, price: p.buyPrice }], note: "Boshlang'ich qoldiq",
        };
        db.docs.push(entry);
      }
      save();
      if (entry) telegramOnStockIn(entry);
      else if (db.telegram.onNewProduct) telegramPostProducts([p.id]);
    },
  });
}

function editProduct(id) {
  const p = product(id);
  if (!isAdmin()) {
    // Sotuvchi kartochkani faqat ko'radi
    openModal({ title: p.name, body: `<fieldset disabled>${productForm(p)}</fieldset>`, wide: true });
    $$('#modalBody .filebtn, #photoRemove').forEach((el) => { el.hidden = true; });
    return;
  }
  openModal({
    title: 'Mahsulot kartochkasi',
    body: productForm(p),
    wide: true,
    onOpen: bindProductForm,
    extra: [
      { label: 'Telegramga yuborish', onClick: () => telegramPostProducts([id], true) },
      { label: 'Harakatlar tarixi', onClick: () => productHistory(id) },
    ],
    onSubmit: (d) => {
      readProduct(d, p);
      save();
    },
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
  save();
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
      ${rows.length ? rows.map(({ d, t, it, delta, wh }) => `<tr><td>${esc(d.date)}</td><td>${esc(t.one)} ${esc(d.no)}</td><td>${esc(wh)}</td>
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
    return `<tr><td>${esc(r.date)}</td><td>${esc(r.title)}</td><td class="num">${r.delta > 0 ? money(r.delta) : ''}</td><td class="num">${r.delta < 0 ? money(-r.delta) : ''}</td><td class="num">${money(bal)}</td></tr>`;
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

function itemRowHtml(t, it = {}) {
  const opts = db.products.filter((p) => !p.archived || p.id === it.productId).map((p) =>
    `<option value="${p.id}" ${p.id === it.productId ? 'selected' : ''}>${esc(p.name)}${p.code ? ' · ' + esc(p.code) : ''}</option>`).join('');
  return `<tr>
    <td><select class="it-product"><option value="">— mahsulot —</option>${opts}</select></td>
    <td class="it-avail muted num"></td>
    <td><input class="it-qty" type="number" min="1" step="1" value="${it.qty || 1}"></td>
    <td><input class="it-price" inputmode="numeric" value="${it.price ?? ''}"></td>
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
  if (t.delivery) {
    head += field('Yetkazish sanasi', 'deliveryDate', d.deliveryDate, 'type="date"');
    head += field('Yetkazish manzili', 'address', d.address, '', 'wide2');
  }

  let foot = '';
  if (t.money || type === 'order' || type === 'purchaseOrder') foot += field("Chegirma (so'm)", 'discount', d.discount || 0, 'inputmode="numeric"');
  if (!d.id && t.pay) {
    foot += field(t.pay === 'in' ? "Hozir to'landi (so'm)" : "Hozir to'ladik (so'm)", 'payNow', d.payNow ?? '', 'inputmode="numeric" placeholder="0"');
    foot += selectField("To'lov usuli", 'payMethod', Object.entries(PAY_METHODS), 'cash');
  }
  foot += textArea('Izoh', 'note', d.note);

  const items = (d.items && d.items.length ? d.items : [{}]).map((it) => itemRowHtml(t, it)).join('');
  return `<div class="form-grid">${head}</div>
    <h4>Mahsulotlar</h4>
    <div class="table-wrap"><table class="items-table">
      <thead><tr><th>Mahsulot</th><th class="num">Omborda</th><th>Soni</th><th>Narxi</th><th class="num">Summa</th><th></th></tr></thead>
      <tbody id="itemRows">${items}</tbody>
    </table></div>
    <button type="button" class="small" id="addItemRow">+ Qator qo'shish</button>
    <div class="form-grid" style="margin-top:12px">${foot}</div>
    <div class="total-line">Jami: <b id="docTotal">0</b></div>`;
}

function bindDocForm(type, editingId) {
  const t = DOC_TYPES[type];
  const stock = computeStock(editingId);
  const body = $('#itemRows');
  const whSel = $('#modalForm [name=warehouseId]');
  const discount = $('#modalForm [name=discount]');

  const recalc = () => {
    let sum = 0;
    $$('tr', body).forEach((tr) => {
      const pid = $('.it-product', tr).value;
      const line = num($('.it-qty', tr).value) * num($('.it-price', tr).value);
      sum += line;
      $('.it-sum', tr).textContent = pid ? fmt(line) : '';
      $('.it-avail', tr).textContent = pid ? qtyIn(stock, pid, whSel.value) : '';
    });
    $('#docTotal').textContent = money(Math.max(0, sum - num(discount?.value)));
  };

  body.addEventListener('change', (e) => {
    if (e.target.classList.contains('it-product')) {
      const p = product(e.target.value);
      const price = $('.it-price', e.target.closest('tr'));
      if (p) price.value = t.price === 'sale' ? p.salePrice : (ctx.cost[p.id] ? Math.round(ctx.cost[p.id]) : p.buyPrice);
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
  $('#addItemRow').addEventListener('click', () => body.insertAdjacentHTML('beforeend', itemRowHtml(t)));
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

function saveDoc(type, existing, preset, data, stock) {
  const t = DOC_TYPES[type];
  const items = readItems();
  if (!items.length) {
    alert('Kamida bitta mahsulot tanlang.');
    return false;
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

  const d = existing || Object.assign({ id: uid(), type, no: nextNo(type), created: new Date().toISOString(), userId: me?.id }, preset.orderId ? { orderId: preset.orderId } : {}, preset.baseId ? { baseId: preset.baseId } : {});
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
  });

  if (!existing) {
    db.docs.push(d);
    const pay = num(data.payNow);
    if (pay > 0) {
      db.payments.push({
        id: uid(), no: nextNo(t.pay === 'in' ? 'payIn' : 'payOut'), dir: t.pay, date: d.date, counterpartyId, docId: d.id,
        amount: pay, method: data.payMethod, purpose: t.pay === 'in' ? PAY_PURPOSES_IN[0] : PAY_PURPOSES_OUT[0], note: '', userId: me?.id,
      });
    }
    // Asos hujjat holatini yangilaymiz
    const base = preset.baseId && doc(preset.baseId);
    if (base?.type === 'order') base.status = 'shipped';
    if (base?.type === 'purchaseOrder') base.status = 'received';
  }
  save();
  if (!existing && (type === 'receipt' || type === 'enter')) telegramOnStockIn(d);
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
    return `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}<br><small>${esc([p.size, p.color, p.material].filter(Boolean).join(', '))}</small></td><td>${it.qty} ${esc(p.unit || '')}</td><td>${fmt(it.price)}</td><td>${fmt(it.qty * it.price)}</td></tr>`;
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
    <h2>${esc(t.one)} № ${esc(d.no)} — ${esc(d.date)}</h2>
    ${t.party ? `<div>${t.party === 'supplier' ? "Ta'minotchi" : 'Mijoz'}: <b>${esc(c.name)}</b> ${esc(c.phone)}</div>` : ''}
    <div>Ombor: ${esc(warehouse(d.warehouseId)?.name)}${t.move ? ' → ' + esc(warehouse(d.toWarehouseId)?.name) : ''}</div>
    ${d.address ? `<div>Yetkazish: ${esc(d.address)} ${esc(d.deliveryDate || '')}</div>` : ''}
    <table><tr><th>№</th><th>Mahsulot</th><th>Soni</th><th>Narxi</th><th>Summa</th></tr>${rows}</table>
    <div class="r">${d.discount ? `Chegirma: ${fmt(d.discount)}<br>` : ''}<b>Jami: ${money(docTotal(d))}</b>
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
      body: `<p>Sana: ${esc(existing.date)} · Ombor: ${esc(warehouse(existing.warehouseId)?.name)}</p>
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
    onSubmit: (data) => {
      const items = $$('#invRows tr[data-pid]').map((tr) => ({ productId: tr.dataset.pid, expected: num(tr.dataset.exp), qty: num($('.inv-fact', tr).value), price: ctx.cost[tr.dataset.pid] || 0 }));
      const inv = { id: uid(), type: 'inventory', no: nextNo('inventory'), date: data.date, warehouseId: data.warehouseId, items, note: '' };
      const plus = items.filter((it) => it.qty > it.expected).map((it) => ({ productId: it.productId, qty: it.qty - it.expected, price: it.price }));
      const minus = items.filter((it) => it.qty < it.expected).map((it) => ({ productId: it.productId, qty: it.expected - it.qty, price: it.price }));
      const created = [];
      if (plus.length) {
        const e = { id: uid(), type: 'enter', no: nextNo('enter'), date: data.date, warehouseId: data.warehouseId, items: plus, note: `Inventarizatsiya ${inv.no} — ortiqcha`, baseId: inv.id };
        db.docs.push(e);
        created.push(`Kirim qilish ${e.no}`);
      }
      if (minus.length) {
        const w = { id: uid(), type: 'writeoff', no: nextNo('writeoff'), date: data.date, warehouseId: data.warehouseId, items: minus, note: `Inventarizatsiya ${inv.no} — kamomad`, baseId: inv.id };
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
    onSubmit: (d) => {
      const amount = num(d.amount);
      if (amount <= 0) {
        alert("Summani kiriting.");
        return false;
      }
      db.payments.push({
        id: uid(), no: nextNo(dir === 'in' ? 'payIn' : 'payOut'), dir, date: d.date, amount, method: d.method,
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
  if (p.code) lines.push(`🔖 Kod: ${esc(p.code)}`);
  lines.push(`💰 Narxi: <b>${money(p.salePrice)}</b>`);
  if (p.size) lines.push(`📐 O'lchami: ${esc(p.size)} sm`);
  if (p.color) lines.push(`🎨 Rangi: ${esc(p.color)}`);
  if (p.material) lines.push(`🪵 Materiali: ${esc(p.material)}`);
  if (p.origin || p.maker) lines.push(`🏭 Ishlab chiqarilgan: ${esc([p.origin, p.maker].filter(Boolean).join(', '))}`);
  lines.push(`📦 ${stockLine(p)}`);
  if (p.note) lines.push('', esc(p.note));
  if (db.company.phone) lines.push('', `📞 ${esc(db.company.phone)}`);
  if (p.category) lines.push(`#${p.category.replace(/[^\p{L}\p{N}]+/gu, '_')}`);
  return lines.join('\n');
}

async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}

async function telegramSend(p) {
  const { token, chatId } = db.telegram;
  const api = `https://api.telegram.org/bot${token}/`;
  const caption = telegramCaption(p);
  let res;
  if (p.photo && caption.length <= 1024) {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    fd.append('photo', await dataUrlToBlob(p.photo), 'photo.jpg');
    res = await fetch(api + 'sendPhoto', { method: 'POST', body: fd });
  } else {
    res = await fetch(api + 'sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' }),
    });
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
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
  for (const id of [...new Set(ids)]) {
    const p = product(id);
    if (!p) continue;
    try {
      await telegramSend(p);
      telegramLog(`Yuborildi: ${p.name}`, true);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      telegramLog(`Xato: ${p.name} — ${e.message}`, false);
    }
  }
  persist();
  if (currentRoute().view === 'telegram') render();
  if (errors.length) alert("Telegramga yuborilmadi:\n" + errors.join('\n'));
  else if (manual) alert('Telegramga yuborildi.');
}

function telegramOnStockIn(d) {
  if (db.telegram.onReceipt) telegramPostProducts(d.items.map((it) => it.productId));
}

// ---------- Ko'rinishlar (sahifalar) ----------

// Uchinchi element 'A' — faqat administrator ko'radi
const SECTIONS = [
  { id: 'dashboard', title: "Ko'rsatkichlar" },
  { id: 'purchases', title: 'Xaridlar', admin: true, views: [['purchaseOrder'], ['receipt'], ['purchaseReturn']] },
  { id: 'sales', title: 'Savdo', views: [['order'], ['sale'], ['salesReturn']] },
  { id: 'goods', title: 'Tovarlar', views: [['products', 'Mahsulotlar'], ['stock', 'Qoldiqlar'], ['enter', '', 'A'], ['writeoff', '', 'A'], ['move', '', 'A'], ['inventory', '', 'A']] },
  { id: 'parties', title: 'Kontragentlar', views: [['parties', 'Kontragentlar'], ['debts', 'Qarzlar', 'A']] },
  { id: 'money', title: 'Pul', views: [['payments', "To'lovlar"], ['cash', 'Kassa va hisoblar', 'A']] },
  { id: 'reports', title: 'Hisobotlar', admin: true, views: [['profit', 'Foyda va zarar'], ['top', 'Savdo tahlili']] },
  { id: 'settings', title: 'Sozlamalar', admin: true, views: [['users', 'Foydalanuvchilar'], ['telegram', 'Telegram'], ['company', 'Kompaniya'], ['warehouses', 'Omborlar'], ['categories', 'Kategoriyalar'], ['backup', 'Zaxira nusxa']] },
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

const userName = (id) => db.users.find((u) => u.id === id)?.name || '';

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
    ['sale', '+ Sotuv', 'primary'], ['order', '+ Buyurtma'],
    ...(isAdmin() ? [['receipt', '+ Qabul qilish']] : []),
  ].map(([type, label, cls]) => `<button class="${cls || ''}" data-act="newDoc" data-type="${type}">${label}</button>`).join('') +
    (isAdmin() ? '<button data-act="newProduct">+ Mahsulot</button>' : '') +
    `<button data-act="newPayment" data-dir="in">+ Kirim to'lovi</button>` +
    (isAdmin() ? `<button data-act="newPayment" data-dir="out">+ Xarajat</button>` : '');

  const low = db.products.filter((p) => !p.archived && qtyIn(ctx.stock, p.id) - qtyIn(ctx.reserve, p.id) <= (p.minQty || 0));
  const deliveries = db.docs
    .filter((d) => (d.type === 'order' && RESERVING.includes(d.status)) || (d.type === 'sale' && d.status !== 'delivered'))
    .filter((d) => d.deliveryDate)
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
    .slice(0, 10);
  const recent = db.docs.filter((d) => canUseDoc(d.type))
    .sort((a, b) => (b.created || b.date).localeCompare(a.created || a.date)).slice(0, 8);

  return `<div class="stats">${cards.map(([l, v, h, cls]) => `<div class="stat"><div class="label">${l}</div><div class="value ${cls || ''}">${v}</div><div class="muted small">${h}</div></div>`).join('')}</div>
    <div class="quick">${quick}</div>
    <div class="grid2">
      <div class="card"><h3>Yaqin yetkazishlar</h3><table><thead><tr><th>Sana</th><th>Hujjat</th><th>Mijoz</th><th>Manzil</th></tr></thead><tbody>
        ${deliveries.length ? deliveries.map((d) => `<tr class="click" data-act="openDoc" data-id="${d.id}"><td class="${d.deliveryDate < t ? 'debt' : ''}">${esc(d.deliveryDate)}</td><td>${esc(d.no)}</td>
          <td>${esc(party(d.counterpartyId)?.name)}</td><td>${esc(d.address)}</td></tr>`).join('') : emptyRow(4, "Rejalashtirilgan yetkazish yo'q")}
      </tbody></table></div>
      <div class="card"><h3>Kam qolgan mahsulotlar</h3><table><thead><tr><th>Mahsulot</th><th class="num">Mavjud</th><th class="num">Min.</th></tr></thead><tbody>
        ${low.length ? low.map((p) => `<tr class="click" data-act="editProduct" data-id="${p.id}"><td>${esc(p.name)}</td><td class="num debt">${qtyIn(ctx.stock, p.id) - qtyIn(ctx.reserve, p.id)}</td><td class="num">${p.minQty}</td></tr>`).join('') : emptyRow(3, 'Hammasi yetarli')}
      </tbody></table></div>
    </div>
    <div class="card"><h3>Oxirgi hujjatlar</h3><table><thead><tr><th>Sana</th><th>Hujjat</th><th>Kontragent</th><th class="num">Summa</th></tr></thead><tbody>
      ${recent.length ? recent.map((d) => `<tr class="click" data-act="openDoc" data-id="${d.id}"><td>${esc(d.date)}</td><td>${esc(DOC_TYPES[d.type].one)} ${esc(d.no)}</td>
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
      <td>${esc(d.no)}</td><td>${esc(d.date)}${d.userId ? `<div class="muted small">${esc(userName(d.userId))}</div>` : ''}</td><td>${where}</td>
      <td class="items-cell">${d.items.slice(0, 3).map((it) => `${esc(product(it.productId)?.name)} × ${it.qty}`).join('<br>')}${d.items.length > 3 ? `<br><span class="muted">yana ${d.items.length - 3} ta</span>` : ''}</td>
      <td class="num">${type === 'inventory' ? '' : money(docTotal(d))}</td>
      ${t.pay ? `<td class="num">${paid >= docTotal(d) && paid > 0 ? badge("To'langan", 'done') : paid > 0 ? fmt(paid) : badge("To'lanmagan", 'cancel')}</td>` : ''}
      ${t.statuses ? `<td>${badge(t.statuses[d.status] || '', d.status)}</td>` : ''}
    </tr>`;
  }).join('');

  return toolbar(type, {
    extra: periodInputs(type) + statusFilter,
    buttons: `<button class="primary" data-act="newDoc" data-type="${type}">+ ${esc(t.one)}</button>${isAdmin() ? `<button data-act="exportDocs" data-type="${type}">CSV</button>` : ''}`,
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
  const cat = filterVal('products.cat');
  const arch = filterVal('products.arch') === '1';
  const list = db.products
    .filter((p) => !!p.archived === arch)
    .filter((p) => !cat || p.category === cat)
    .filter((p) => !q || [p.name, p.code, p.material, p.color, p.origin, p.maker, p.size].join(' ').toLowerCase().includes(q));

  const admin = isAdmin();
  const rows = list.map((p) => {
    const st = qtyIn(ctx.stock, p.id);
    const rs = qtyIn(ctx.reserve, p.id);
    return `<tr>
      <td class="thumb">${p.photo ? `<img src="${p.photo}" alt="">` : ''}</td>
      <td class="click" data-act="editProduct" data-id="${p.id}"><b>${esc(p.name)}</b><div class="muted small">${esc([p.code, p.category].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(p.size)}</td>
      <td>${esc([p.color, p.material].filter(Boolean).join(', '))}</td>
      <td>${esc(p.origin)}</td>
      ${admin ? `<td class="num">${money(ctx.cost[p.id])}</td>` : ''}
      <td class="num">${money(p.salePrice)}</td>
      <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}${rs ? `<div class="muted small">rezerv ${rs}</div>` : ''}</td>
      <td class="actions">${admin ? `
        <button class="small" data-act="tgProduct" data-id="${p.id}" title="Telegram guruhga yuborish">✈︎</button>
        ${p.archived ? `<button class="small" data-act="unarchive" data-id="${p.id}">Tiklash</button>` : `<button class="small danger" data-act="deleteProduct" data-id="${p.id}">O'chirish</button>`}` : ''}
      </td>
    </tr>`;
  }).join('');

  return toolbar('products', {
    extra: `<select data-filter="products.cat"><option value="">Barcha kategoriyalar</option>${db.categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-filter="products.arch"><option value="">Faol</option><option value="1" ${arch ? 'selected' : ''}>Arxiv</option></select>`,
    buttons: admin ? `<button class="primary" data-act="newProduct">+ Mahsulot</button><button data-act="exportProducts">CSV</button>` : '',
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th></th><th>Nomi</th><th>O'lchami</th><th>Rangi / materiali</th><th>Ishlab chiqarilgan</th>
    ${admin ? '<th class="num">Tannarx</th>' : ''}<th class="num">Sotish narxi</th><th class="num">Qoldiq</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(9, "Mahsulot yo'q")}</tbody></table></div></div>`;
}

function exportProducts() {
  const rows = [['Kod', 'Nomi', 'Kategoriya', "O'lchami", 'Rangi', 'Materiali', 'Ishlab chiqarilgan', 'Ishlab chiqaruvchi', 'Tannarx', 'Sotish narxi', 'Qoldiq', 'Rezerv']];
  db.products.forEach((p) => rows.push([p.code, p.name, p.category, p.size, p.color, p.material, p.origin, p.maker, Math.round(ctx.cost[p.id]), p.salePrice, qtyIn(ctx.stock, p.id), qtyIn(ctx.reserve, p.id)]));
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
      tq += st; tc += st * cost; ts += st * p.salePrice;
      return `<tr class="click" data-act="productHistory" data-id="${p.id}"><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td>
        <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}</td><td class="num">${rs || ''}</td><td class="num">${st - rs}</td>
        ${admin ? `<td class="num">${fmt(cost)}</td><td class="num">${fmt(st * cost)}</td>` : ''}<td class="num">${fmt(p.salePrice)}</td><td class="num">${fmt(st * p.salePrice)}</td></tr>`;
    }).join('');
  return toolbar('stock', {
    extra: `<select data-filter="stock.wh"><option value="">Barcha omborlar</option>${db.warehouses.map((w) => `<option value="${w.id}" ${w.id === wh ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-filter="stock.cat"><option value="">Barcha kategoriyalar</option>${db.categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-filter="stock.pos"><option value="">Hammasi</option><option value="1" ${onlyPos ? 'selected' : ''}>Faqat bor</option></select>`,
    buttons: `<button data-act="print">Chop etish</button>`,
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
      <td class="actions"><button class="small" data-act="statement" data-id="${c.id}">Hisob-kitob</button>${isAdmin() ? `<button class="small danger" data-act="deleteParty" data-id="${c.id}">O'chirish</button>` : ''}</td></tr>`;
  }).join('');
  return toolbar('parties', {
    extra: !isAdmin() ? '' : `<select data-filter="parties.kind"><option value="">Hammasi</option><option value="customer" ${kind === 'customer' ? 'selected' : ''}>Mijozlar</option><option value="supplier" ${kind === 'supplier' ? 'selected' : ''}>Ta'minotchilar</option></select>`,
    buttons: `<button class="primary" data-act="newParty">+ Kontragent</button>`,
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
    return `<tr><td>${esc(p.no)}</td><td>${esc(p.date)}</td><td>${p.dir === 'in' ? badge('Kirim', 'done') : badge('Chiqim', 'cancel')}</td>
      <td>${esc(p.purpose)}</td><td>${esc(party(p.counterpartyId)?.name || '—')}</td>
      <td>${d ? `<a href="javascript:void 0" data-act="openDoc" data-id="${d.id}">${esc(d.no)}</a>` : ''}</td>
      <td>${esc(PAY_METHODS[p.method])}</td><td class="num">${money(p.amount)}</td><td>${esc(p.note)}</td>
      <td class="actions">${admin ? `<button class="small danger" data-act="deletePayment" data-id="${p.id}">×</button>` : ''}</td></tr>`;
  }).join('');
  return toolbar('payments', {
    extra: periodInputs('payments') + (!admin ? '' : `<select data-filter="payments.dir"><option value="">Hammasi</option><option value="in" ${dir === 'in' ? 'selected' : ''}>Kirim</option><option value="out" ${dir === 'out' ? 'selected' : ''}>Chiqim</option></select>`),
    buttons: `<button class="primary" data-act="newPayment" data-dir="in">+ Kirim</button>${admin ? '<button data-act="newPayment" data-dir="out">+ Chiqim</button>' : ''}`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th>№</th><th>Sana</th><th>Turi</th><th>Moddasi</th><th>Kontragent</th><th>Hujjat</th><th>Usul</th><th class="num">Summa</th><th>Izoh</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(10, "To'lov yo'q")}</tbody>
    <tfoot><tr><td colspan="7">Kirim: ${money(tin)} · Chiqim: ${money(tout)}</td><td class="num">${money(tin - tout)}</td><td colspan="2"></td></tr></tfoot></table></div></div>`;
}

function viewCash() {
  const b = cashBalances();
  return `<div class="stats">${Object.entries(PAY_METHODS).map(([k, v]) => `<div class="stat"><div class="label">${v}</div><div class="value">${money(b[k] || 0)}</div></div>`).join('')}
    <div class="stat"><div class="label">Jami</div><div class="value">${money(b.cash + b.card + b.bank)}</div></div></div>
    <div class="card"><p class="muted">Qoldiqlar barcha kirim va chiqim to'lovlaridan hisoblanadi. Boshlang'ich qoldiqni kiritish uchun "Boshqa kirim" moddasi bilan kirim to'lovi yarating.</p>
    <button data-act="newPayment" data-dir="in">+ Kirim</button> <button data-act="newPayment" data-dir="out">+ Chiqim</button></div>`;
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

function viewUsers() {
  return `<div class="card narrow"><h3>Foydalanuvchilar</h3>
    <p class="muted"><b>Administrator</b> — hamma bo'limlar. <b>Sotuvchi</b> — faqat savdo (buyurtma, jo'natish, qaytarish), mijozlar, kirim to'lovlari va qoldiqlarni ko'rish; tannarx, foyda, xaridlar va sozlamalar unga ko'rinmaydi, o'zgalar hujjatlarini o'zgartira olmaydi va hech narsani o'chira olmaydi.</p>
    <table><thead><tr><th>Ism</th><th>Login</th><th>Roli</th><th>Holati</th><th></th></tr></thead><tbody>
    ${db.users.map((u) => `<tr><td>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(siz)</span>' : ''}</td><td>${esc(u.login)}</td>
      <td>${badge(ROLES[u.role], u.role === 'admin' ? 'admin' : '')}</td><td>${u.active === false ? badge('Bloklangan', 'cancel') : badge('Faol', 'done')}</td>
      <td class="actions"><button class="small" data-act="editUser" data-id="${u.id}">Tahrirlash</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:12px"><button class="primary" data-act="editUser">+ Foydalanuvchi</button></div></div>`;
}

function editUser(id) {
  const u = id ? db.users.find((x) => x.id === id) : { role: 'seller', active: true };
  const self = u.id === me.id;
  openModal({
    title: id ? 'Foydalanuvchi' : 'Yangi foydalanuvchi',
    body: `<div class="form-grid">
      ${field('Ism *', 'name', u.name, 'required')}
      ${field('Login *', 'login', u.login, 'required autocapitalize="none" autocomplete="off"')}
      ${selectField('Roli', 'role', Object.entries(ROLES), u.role, '', self ? 'disabled' : '')}
      ${selectField('Holati', 'active', [['1', 'Faol'], ['0', 'Bloklangan']], u.active === false ? '0' : '1', '', self ? 'disabled' : '')}
      ${field(id ? "Yangi parol (o'zgartirmaslik uchun bo'sh qoldiring)" : 'Parol *', 'password', '', `type="password" autocomplete="new-password" ${id ? '' : 'required'}`, 'full')}
    </div>`,
    onSubmit: async (d) => {
      const login = d.login.trim().toLowerCase();
      if (db.users.some((x) => x.login === login && x.id !== u.id)) {
        alert('Bu login band.');
        return false;
      }
      if (d.password && d.password.length < 4) {
        alert("Parol kamida 4 belgidan iborat bo'lsin.");
        return false;
      }
      Object.assign(u, { name: d.name.trim(), login });
      if (!self) Object.assign(u, { role: d.role, active: d.active === '1' });
      if (d.password) await setPassword(u, d.password);
      if (!id) {
        u.id = uid();
        u.created = today();
        db.users.push(u);
      }
      save();
    },
  });
}

function viewTelegram() {
  const tg = db.telegram;
  const sample = db.products[0];
  return `<div class="card narrow">
    <h3>Telegram guruhga avtomatik e'lon</h3>
    <p class="muted">Omborga mahsulot kelganda (Qabul qilish yoki Kirim qilish hujjati, yoki boshlang'ich qoldiq bilan yangi mahsulot) uning rasmi va ma'lumotlari guruhga yuboriladi.</p>
    <ol class="muted small">
      <li>Telegramda <b>@BotFather</b> ga yozing → <code>/newbot</code> → bot nomini kiriting → u bergan <b>token</b> ni pastga joylang.</li>
      <li>Botni guruhingizga qo'shing va uni <b>administrator</b> qiling (xabar yuborish huquqi bilan).</li>
      <li>Guruhga istalgan xabar yozing, so'ng "Guruh ID sini aniqlash" tugmasini bosing. Ochiq kanal/guruh uchun <code>@guruh_nomi</code> ham yozish mumkin.</li>
    </ol>
    <div class="form-grid">
      <label class="full">Bot tokeni<input id="tgToken" value="${esc(tg.token)}" placeholder="123456789:AA..." autocomplete="off"></label>
      <label class="full">Guruh / kanal ID<input id="tgChat" value="${esc(tg.chatId)}" placeholder="-1001234567890 yoki @guruh_nomi"></label>
      <label class="check full"><input type="checkbox" id="tgOnReceipt" ${tg.onReceipt ? 'checked' : ''}> Omborga qabul qilinganda yuborish</label>
      <label class="check full"><input type="checkbox" id="tgOnNew" ${tg.onNewProduct ? 'checked' : ''}> Yangi mahsulot (qoldiqsiz) yaratilganda ham yuborish</label>
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
  ${sample ? `<div class="card narrow"><h3>Namuna xabar</h3><div class="tg-preview">${sample.photo ? `<img src="${sample.photo}" alt="">` : ''}<div>${telegramCaption(sample).replace(/\n/g, '<br>')}</div></div></div>` : ''}
  <div class="card narrow"><h3>Yuborish jurnali</h3><table><tbody>
    ${tg.log.length ? tg.log.map((l) => `<tr><td class="muted small">${esc(l.at)}</td><td class="${l.ok ? '' : 'debt'}">${esc(l.text)}</td></tr>`).join('') : emptyRow(2, "Hali yuborilmagan")}
  </tbody></table></div>`;
}

function tgReadForm() {
  Object.assign(db.telegram, {
    token: $('#tgToken').value.trim(),
    chatId: $('#tgChat').value.trim(),
    onReceipt: $('#tgOnReceipt').checked,
    onNewProduct: $('#tgOnNew').checked,
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
  persist();
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
      <td class="actions"><button class="small" data-act="editWh" data-id="${w.id}">Tahrirlash</button><button class="small danger" data-act="deleteWh" data-id="${w.id}">O'chirish</button></td></tr>`).join('')}
    </tbody></table><div class="toolbar" style="margin-top:12px"><button class="primary" data-act="editWh">+ Ombor</button></div></div>`;
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

function viewCategories() {
  return `<div class="card narrow"><h3>Mahsulot kategoriyalari</h3><p class="muted">Har bir qatorga bitta kategoriya.</p>
    <textarea id="catInput" rows="12">${esc(db.categories.join('\n'))}</textarea>
    <div class="toolbar" style="margin-top:12px"><button class="primary" data-act="catSave">Saqlash</button></div></div>`;
}

function viewBackup() {
  return `<div class="card narrow"><h3>Zaxira nusxa</h3>
    <p class="muted">Barcha ma'lumotlar shu brauzerda saqlanadi. Ularni yo'qotmaslik uchun har kuni zaxira nusxasini yuklab oling. Boshqa kompyuterga o'tkazish uchun ham shu fayldan foydalaning.</p>
    <div class="toolbar">
      <button class="primary" data-act="backup">Zaxira nusxani yuklab olish (.json)</button>
      <label class="filebtn">Zaxiradan tiklash<input type="file" id="restoreInput" accept=".json,application/json" hidden></label>
    </div></div>
    <div class="card narrow"><h3>Namuna ma'lumotlar</h3><p class="muted">Dasturni sinab ko'rish uchun bir nechta mahsulot, kontragent va hujjat qo'shadi.</p>
      <button data-act="demo">Namuna ma'lumotlarni yuklash</button></div>
    <div class="card narrow"><h3>Tozalash</h3><button class="danger" data-act="reset">Barcha ma'lumotlarni o'chirish</button></div>`;
}

function loadDemo() {
  if (db.products.length && !confirm("Namuna ma'lumotlar mavjud ma'lumotlarga qo'shiladi. Davom etilsinmi?")) return;
  const sup = { id: uid(), name: '"Mebel Lux" MChJ', kind: 'supplier', phone: '+998 71 200 00 00', address: 'Toshkent, Chilonzor', inn: '301234567', note: '' };
  const cus = { id: uid(), name: 'Aliyev Jamshid', kind: 'customer', phone: '+998 90 111 22 33', address: "Toshkent, Yunusobod 4-kvartal", inn: '', note: '' };
  db.counterparties.push(sup, cus);
  const mk = (name, category, size, color, material, origin, buyPrice, salePrice) =>
    ({ id: uid(), name, code: 'A' + String(db.products.length + 101), category, size, color, material, origin, maker: '', unit: 'dona', buyPrice, salePrice, minQty: 1, note: '', photo: '' });
  const ps = [
    mk('Yotoqxona to\'plami "Milano"', 'Yotoqxona', '200 × 180 × 110', 'Oq / oltin', 'MDF, LDSP', 'Turkiya, Istanbul', 18000000, 24500000),
    mk('Burchak divan "Oskar"', 'Divan va kreslo', '280 × 180 × 90', 'Kulrang', 'Velyur, yog\'och karkas', "O'zbekiston, Toshkent", 6500000, 9200000),
    mk('Oshxona stoli + 6 stul "Verona"', 'Stol va stul', '160 × 90 × 76', "Yong'oq", 'Massiv (buk)', 'Malayziya', 4200000, 6300000),
    mk('Shkaf-kupe 3 eshikli', 'Shkaf', '240 × 60 × 240', 'Sonoma eman', 'LDSP, oyna', "O'zbekiston, Samarqand", 3900000, 5600000),
    mk('Ortopedik matras "Comfort"', 'Matras', '160 × 200 × 25', 'Oq', 'Mustaqil prujina', 'Rossiya', 1800000, 2700000),
  ];
  db.products.push(...ps);
  const d0 = new Date();
  const ago = (n) => localDate(new Date(d0 - n * 864e5));
  const wh = db.warehouses[0].id;
  const rec = { id: uid(), type: 'receipt', no: nextNo('receipt'), date: ago(10), counterpartyId: sup.id, warehouseId: wh, discount: 0, note: '', items: ps.map((p, i) => ({ productId: p.id, qty: [2, 3, 2, 4, 6][i], price: p.buyPrice })) };
  const sale = { id: uid(), type: 'sale', no: nextNo('sale'), date: ago(2), counterpartyId: cus.id, warehouseId: wh, status: 'pending', deliveryDate: ago(-1), address: cus.address, discount: 200000, note: '', userId: me.id, items: [{ productId: ps[1].id, qty: 1, price: ps[1].salePrice }, { productId: ps[4].id, qty: 2, price: ps[4].salePrice }] };
  const order = { id: uid(), type: 'order', no: nextNo('order'), date: ago(1), counterpartyId: cus.id, warehouseId: wh, status: 'confirmed', deliveryDate: ago(-5), address: cus.address, discount: 0, note: '', userId: me.id, items: [{ productId: ps[0].id, qty: 1, price: ps[0].salePrice }] };
  db.docs.push(rec, sale, order);
  db.payments.push(
    { id: uid(), no: nextNo('payOut'), dir: 'out', date: ago(9), amount: 50000000, method: 'bank', purpose: "Ta'minotchiga to'lov", counterpartyId: sup.id, docId: rec.id, note: '' },
    { id: uid(), no: nextNo('payIn'), dir: 'in', date: ago(2), amount: 8000000, method: 'cash', purpose: "Mijozdan to'lov", counterpartyId: cus.id, docId: sale.id, note: '' },
    { id: uid(), no: nextNo('payIn'), dir: 'in', date: ago(1), amount: 5000000, method: 'card', purpose: "Mijozdan to'lov", counterpartyId: cus.id, docId: order.id, note: 'Oldindan to\'lov' },
    { id: uid(), no: nextNo('payOut'), dir: 'out', date: ago(3), amount: 4000000, method: 'cash', purpose: 'Ijara', counterpartyId: null, docId: null, note: "Do'kon ijarasi" },
  );
  save();
  location.hash = '#dashboard';
}

// ---------- Chizish va navigatsiya ----------

const VIEWS = {
  dashboard: viewDashboard, products: viewProducts, stock: viewStock, parties: viewParties, debts: viewDebts,
  payments: viewPayments, cash: viewCash, profit: viewProfit, top: viewTop, users: viewUsers,
  telegram: viewTelegram, company: viewCompany, warehouses: viewWarehouses, categories: viewCategories, backup: viewBackup,
};

function render() {
  // Hisob bloklangan yoki o'chirilgan bo'lsa sessiyani yopamiz
  if (me && !db.users.some((u) => u.id === me.id && u.active !== false)) setSession(null);
  $('#auth').hidden = !!me;
  $('#app').hidden = !me;
  if (!me) {
    if ($('#modal').open) closeModal();
    renderAuth();
    return;
  }
  me = db.users.find((u) => u.id === me.id);
  $('#authForm').innerHTML = '';
  $('#userName').textContent = `${me.name} · ${ROLES[me.role]}`;
  refreshCtx();
  const { section, view } = currentRoute();
  $('#sections').innerHTML = visibleSections().map((s) => `<a href="#${s.id}" class="${s === section ? 'active' : ''}">${s.title}</a>`).join('');
  $('#subnav').innerHTML = section.views
    ? visibleViews(section).map((v) => `<a href="#${section.id}/${v[0]}" class="${v[0] === view ? 'active' : ''}">${esc(viewTitle(v))}</a>`).join('')
    : '';
  $('#subnav').hidden = !section.views;
  const focused = document.activeElement?.dataset?.filter;
  const caret = document.activeElement?.selectionStart;
  $('#view').innerHTML = (VIEWS[view] || ((v) => viewDocs(v)))(view);
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
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.products) || !Array.isArray(data.docs)) throw new Error("Bu Biznes Tizim zaxira fayli emas");
      if (!confirm("Joriy ma'lumotlar zaxiradagisi bilan almashtiriladi. Davom etilsinmi?")) return;
      const base = emptyDb();
      db = Object.assign(base, data, { telegram: Object.assign(base.telegram, data.telegram) });
      // Eski zaxirada foydalanuvchilar bo'lmasa, joriy administratorni saqlab qolamiz
      if (!db.users.length) db.users.push(me);
      save();
      alert('Tiklandi.');
    } catch (err) {
      alert("Faylni o'qib bo'lmadi: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
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
    if (confirm(`${ids.length} ta mahsulot guruhga yuborilsinmi?`)) { tgReadForm(); persist(); telegramPostProducts(ids, true); }
  },
  coSave: () => {
    Object.assign(db.company, { name: $('#coName').value.trim(), phone: $('#coPhone').value.trim(), address: $('#coAddress').value.trim() });
    save();
    alert('Saqlandi.');
  },
  editWh: (ds) => editWarehouse(ds.id),
  deleteWh: (ds) => deleteWarehouse(ds.id),
  catSave: () => {
    db.categories = $('#catInput').value.split('\n').map((s) => s.trim()).filter(Boolean);
    save();
    alert('Saqlandi.');
  },
  backup: () => download(`biznes-tizim-zaxira-${today()}.json`, JSON.stringify(db), 'application/json'),
  demo: () => loadDemo(),
  reset: () => {
    if (!confirm("Barcha ma'lumotlar o'chiriladi. Zaxira nusxa olganmisiz?")) return;
    db = Object.assign(emptyDb(), { users: db.users });
    save();
  },
  editUser: (ds) => editUser(ds.id),
};

// Sotuvchi tugmani ko'rmasa ham, bu amallarni bajara olmasligi kerak
const ADMIN_ACTIONS = ['newProduct', 'deleteProduct', 'unarchive', 'exportProducts', 'tgProduct', 'deleteParty', 'deletePayment',
  'tgSave', 'tgDetect', 'tgTest', 'tgAll', 'coSave', 'editWh', 'deleteWh', 'catSave', 'backup', 'demo', 'reset', 'editUser', 'exportDocs'];

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#modal') && !el.closest('#modalBody')) return;
  e.preventDefault();
  if (ADMIN_ACTIONS.includes(el.dataset.act) && !isAdmin()) return;
  ACTIONS[el.dataset.act]?.(el.dataset);
});

$('#authForm').addEventListener('submit', onAuthSubmit);
$('#logoutBtn').addEventListener('click', () => {
  setSession(null);
  render();
});

restoreSession();
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e));
}
