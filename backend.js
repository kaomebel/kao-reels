'use strict';

/*
 * Ma'lumotlar qatlami. Dastur ma'lumotni faqat shu fayl orqali o'qiydi va yozadi,
 * shuning uchun server almashtirilganda faqat shu fayl o'zgaradi.
 *
 *   LocalBackend    — shu brauzerning o'zida saqlaydi (serversiz sinash uchun)
 *   SupabaseBackend — Supabase: umumiy baza, rasmlar xotirasi, foydalanuvchilar
 *
 * Ikkalasi ham bir xil `db` obyektini qaytaradi va qabul qiladi:
 *   { products, counterparties, warehouses, docs, payments, categories, company, telegram, users, ... }
 */

const ENTITY_TABLES = ['warehouses', 'counterparties', 'products', 'docs', 'payments']; // yozish tartibi muhim
// Ruxsatlar: administrator hamma narsani qila oladi, boshqalarga administrator o'zi belgilaydi.
// Belgilanmagan bo'lsa — rolning standart ruxsatlari (serverdagi public.has_perm bilan bir xil)
const ROLE_PERMS = { seller: ['sale', 'enter'], purchaser: ['purchase', 'enter', 'products', 'costs'] };
const permsOf = (u) => (Array.isArray(u?.perms) ? u.perms : ROLE_PERMS[u?.role] || []);

const SETTINGS_KEYS = ['categories', 'categoryTypes', 'materials', 'colors', 'customerTypes', 'featureSets', 'categoryIcons', 'regions', 'currency', 'company', 'telegram', 'legacyUsers'];
const SERVER_CONFIG_KEY = 'biznes-tizim-server';
const LOCAL_DATA_KEY = 'biznes-tizim-v1';
const LOCAL_SESSION_KEY = 'biznes-tizim-session';
const PHOTO_BUCKET = 'photos';

// Supabase'da login — email. Xodimlarga oddiy login ("sardor") berish uchun unga ichki domen qo'shiladi
const LOGIN_DOMAIN = '@kao.local';
const toEmail = (login) => {
  const l = String(login || '').trim().toLowerCase();
  return l.includes('@') ? l : l + LOGIN_DOMAIN;
};
const shortLogin = (email) => String(email || '').replace(LOGIN_DOMAIN, '');

// config.js da server yozilgan bo'lsa — sayt faqat shu serverda ishlaydi: lokal rejim ham, boshqa server ham yo'q.
// Shunda havolani ochgan har kim faqat administrator bergan login bilan kira oladi.
const serverLocked = () => !!(window.BT_CONFIG?.supabaseUrl && window.BT_CONFIG?.supabaseAnonKey);

function serverConfig() {
  const c = window.BT_CONFIG || {};
  if (serverLocked()) return { url: c.supabaseUrl.trim(), key: c.supabaseAnonKey.trim() };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || '{}'); } catch (e) { /* xotira yopiq */ }
  return { url: (saved.url || c.supabaseUrl || '').trim(), key: (saved.key || c.supabaseAnonKey || '').trim() };
}

function saveServerConfig(cfg) {
  if (cfg) localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(SERVER_CONFIG_KEY);
}

function createBackend() {
  const cfg = serverConfig();
  return cfg.url && cfg.key ? new SupabaseBackend(cfg) : new LocalBackend();
}

// Ulanish ma'lumotlarini saqlashdan oldin tekshirish
async function testServerConfig(cfg) {
  const client = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.rpc('has_users');
  if (error) {
    if (/has_users/.test(error.message || '')) throw new Error("Server topildi, lekin sxema o'rnatilmagan: supabase/schema.sql faylini SQL Editor'da ishga tushiring.");
    throw new Error(error.message || String(error));
  }
}

// ---------- Rasmlar bilan ishlash (ikkala rejim uchun umumiy) ----------

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error("Rasmni o'qib bo'lmadi")); };
    img.src = URL.createObjectURL(blob);
  });
}

function canvasToBlob(img, max, type, quality) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const ctx2d = c.getContext('2d');
  ctx2d.fillStyle = '#fff'; // shaffof PNG qora bo'lib qolmasligi uchun
  ctx2d.fillRect(0, 0, c.width, c.height);
  ctx2d.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

// Katta (kartochka uchun) va kichik (ro'yxat uchun) nusxa. WebP qo'llanmasa — JPEG.
async function preparePhoto(blob) {
  const img = await loadImage(blob);
  let full = await canvasToBlob(img, 1200, 'image/webp', 0.8);
  let type = 'image/webp';
  if (!full || full.type !== 'image/webp') {
    type = 'image/jpeg';
    full = await canvasToBlob(img, 1200, type, 0.8);
  }
  const thumb = await canvasToBlob(img, 240, type, 0.7);
  return { full, thumb, ext: type === 'image/webp' ? 'webp' : 'jpg' };
}

// Telegram uchun JPEG ga o'tkazamiz (WebP ni hamma mijozlar ham rasm sifatida ko'rsatmaydi)
async function toJpeg(blob) {
  if (blob.type === 'image/jpeg') return blob;
  const img = await loadImage(blob);
  return canvasToBlob(img, 1600, 'image/jpeg', 0.88);
}

async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Kalitlari tartiblangan JSON: PostgreSQL jsonb kalitlarni o'z tartibida qaytaradi,
// oddiy JSON.stringify bilan solishtirsak, o'zgarmagan yozuvlar ham qayta yuborilardi.
function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const photoPath = (ext, suffix = '') => `products/${new Date().getFullYear()}/${newId()}${suffix}.${ext}`;

// ---------- Lokal rejim ----------

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('biznes-tizim', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(idb, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('photos', mode);
    const req = fn(tx.objectStore('photos'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

class LocalBackend {
  constructor() {
    this.kind = 'local';
    this.label = "Lokal rejim (shu qurilmada)";
    this.canSetOthersPassword = true;
    this.loginLabel = 'Login';
    this.urls = new Map();
  }

  async init() {
    try { this.idb = await openIdb(); } catch (e) { console.warn('IndexedDB:', e); }
    this.data = this.readData();
  }

  readData() {
    try {
      const raw = localStorage.getItem(LOCAL_DATA_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // --- Foydalanuvchilar ---

  get users() {
    return this.data?.users || [];
  }

  async hasUsers() {
    return this.users.length > 0;
  }

  async restoreSession() {
    let id = null;
    try { id = localStorage.getItem(LOCAL_SESSION_KEY); } catch (e) { /* xotira yopiq */ }
    return this.users.find((u) => u.id === id && u.active !== false) || null;
  }

  async signIn(login, password) {
    const u = this.users.find((x) => x.login === login.trim().toLowerCase());
    if (!u || u.passHash !== await sha256(u.salt + ':' + password)) throw new Error("Login yoki parol noto'g'ri.");
    if (u.active === false) throw new Error('Bu hisob bloklangan. Administratorga murojaat qiling.');
    localStorage.setItem(LOCAL_SESSION_KEY, u.id);
    return u;
  }

  async createFirstAdmin({ name, login, password }) {
    const u = { id: newId(), name, login: login.toLowerCase(), role: 'admin', active: true };
    await this.setPassword(u, password);
    this.data = Object.assign(this.data || {}, { users: [u] });
    this.writeData(this.data);
    localStorage.setItem(LOCAL_SESSION_KEY, u.id);
    return u;
  }

  async signOut() {
    localStorage.removeItem(LOCAL_SESSION_KEY);
  }

  async setPassword(u, password) {
    u.salt = newId() + newId();
    u.passHash = await sha256(u.salt + ':' + password);
  }

  async saveUser(user, password, isNew) {
    if (this.users.some((x) => x.login === user.login && x.id !== user.id)) throw new Error('Bu login band.');
    const target = isNew ? Object.assign(user, { id: newId() }) : this.users.find((x) => x.id === user.id);
    Object.assign(target, { name: user.name, login: user.login, role: user.role, active: user.active, perms: user.perms });
    if (password) await this.setPassword(target, password);
    if (isNew) this.data.users.push(target);
    this.writeData(this.data);
  }

  async changeOwnPassword(me, password) {
    await this.saveUser(me, password, false);
  }

  async listUsers() {
    return this.users.map(({ id, name, login, role, active, perms }) => ({ id, name, login, role, active, perms }));
  }

  // --- Ma'lumotlar ---

  async load() {
    const data = this.readData() || {};
    // Eski versiyadagi bitta rasm (data URL) — rasmlar xotirasiga ko'chiriladi
    let migrated = false;
    for (const p of data.products || []) {
      if (p.photo && p.photo.startsWith('data:')) {
        try {
          p.photos = [await this.uploadPhoto(await dataUrlToBlob(p.photo))];
          migrated = true;
        } catch (e) {
          console.warn(e);
        }
      }
      delete p.photo;
    }
    this.data = data;
    if (migrated) this.writeData(data);
    return JSON.parse(JSON.stringify(data));
  }

  writeData(data) {
    try {
      localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data));
    } catch (e) {
      throw new Error("Brauzer xotirasi to'lgan: " + e.message);
    }
  }

  async commit(db) {
    // Hisoblagich (seq) va foydalanuvchilar parollari bilan faqat shu yerda saqlanadi
    const data = Object.assign({}, db, { users: this.users, seq: this.data?.seq || {} });
    this.writeData(data);
    this.data = data;
  }

  async nextNo(kind, prefix) {
    this.data.seq = this.data.seq || {};
    this.data.seq[kind] = (this.data.seq[kind] || 0) + 1;
    this.writeData(this.data);
    return `${prefix}-${String(this.data.seq[kind]).padStart(5, '0')}`;
  }

  async counters() {
    return this.data?.seq || {};
  }

  async setCounters(seq) {
    this.data.seq = this.data.seq || {};
    Object.entries(seq || {}).forEach(([k, v]) => { this.data.seq[k] = Math.max(this.data.seq[k] || 0, v); });
    this.writeData(this.data);
  }

  subscribe() { /* bitta qurilma — jonli yangilanish kerak emas */ }
  unsubscribe() {}

  // --- Rasmlar ---

  async uploadPhoto(blob) {
    if (!this.idb) throw new Error("Brauzer rasmlarni saqlashni qo'llamaydi");
    const { full, thumb, ext } = await preparePhoto(blob);
    const path = photoPath(ext);
    const thumbPath = photoPath(ext, '_t');
    await idbRequest(this.idb, 'readwrite', (s) => { s.put(full, path); s.put(thumb, thumbPath); });
    return { path, thumb: thumbPath };
  }

  async deletePhotos(paths) {
    if (!this.idb || !paths.length) return;
    await idbRequest(this.idb, 'readwrite', (s) => { paths.forEach((p) => s.delete(p)); });
    paths.forEach((p) => { const u = this.urls.get(p); if (u) URL.revokeObjectURL(u); this.urls.delete(p); });
  }

  async photoBlob(path) {
    if (!this.idb) return null;
    const blob = await idbRequest(this.idb, 'readonly', (s) => s.get(path));
    return blob instanceof Blob ? blob : null;
  }

  async photoUrl(path) {
    if (!path) return '';
    if (!this.urls.has(path)) {
      const blob = await this.photoBlob(path);
      this.urls.set(path, blob ? URL.createObjectURL(blob) : '');
    }
    return this.urls.get(path);
  }

  async storageUsage() {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, limit: e.quota || 0 };
  }

  // Serverga ko'chirish uchun: rasmlarni ham faylga joylab beradi
  async exportWithPhotos() {
    const data = JSON.parse(JSON.stringify(this.readData() || {}));
    for (const p of data.products || []) {
      const photos = [];
      for (const ph of p.photos || []) {
        const blob = await this.photoBlob(ph.path);
        // Fayli yo'q rasm boshqa joyda baribir ochilmaydi — tashlab ketamiz
        if (blob) photos.push(Object.assign(ph, { data: await blobToDataUrl(blob) }));
      }
      p.photos = photos;
    }
    return data;
  }
}

// ---------- Supabase ----------

const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|fetch failed|ERR_|timeout/i;

// Ruxsat yoki ma'lumot xatosi (qayta urinish foyda bermaydi) — internet uzilishidan farqli
function syncError(error) {
  const network = NETWORK_RE.test(error?.message || '') || NETWORK_RE.test(error?.details || '');
  return Object.assign(new Error(friendlyError(error)), { fatal: !network });
}

function friendlyError(error) {
  const m = error?.message || String(error);
  if (/Invalid login credentials/i.test(m)) return "Login yoki parol noto'g'ri.";
  if (/Email not confirmed/i.test(m)) return "Hisob tasdiqlanmagan: Supabase'da Authentication → Email → «Confirm email» ni o'chiring.";
  if (/User already registered/i.test(m)) return "Bu email bilan foydalanuvchi allaqachon mavjud.";
  if (/Password should be at least/i.test(m)) return "Parol juda qisqa (kamida 6 belgi).";
  if (/rate limit/i.test(m)) return "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Serverga ulanib bo'lmadi. Internetni tekshiring.";
  if (/row-level security|permission denied|42501/i.test(m)) return "Bu amal uchun ruxsatingiz yo'q.";
  return m;
}

class SupabaseBackend {
  constructor(cfg) {
    this.kind = 'supabase';
    this.cfg = cfg;
    this.label = 'Supabase server: ' + cfg.url.replace(/^https?:\/\//, '');
    this.canSetOthersPassword = false;
    this.loginLabel = 'Login';
    this.sb = window.supabase.createClient(cfg.url, cfg.key);
    this.snap = {};
    this.profile = null;
    this.channel = null;
  }

  async init() {}

  // --- Foydalanuvchilar ---

  async hasUsers() {
    const { data, error } = await this.sb.rpc('has_users');
    if (error) throw new Error(friendlyError(error));
    return data;
  }

  async loadProfile(user) {
    const { data, error } = await this.sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw new Error(friendlyError(error));
    if (!data || !data.active) {
      await this.sb.auth.signOut();
      throw new Error("Hisobingiz hali faollashtirilmagan yoki bloklangan. Administratorga murojaat qiling.");
    }
    this.profile = data;
    return { id: data.id, name: data.name, login: shortLogin(data.login), role: data.role, active: data.active, perms: data.perms ?? undefined };
  }

  async restoreSession() {
    const { data } = await this.sb.auth.getSession();
    return data.session ? this.loadProfile(data.session.user) : null;
  }

  async signIn(login, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email: toEmail(login), password });
    if (error) throw new Error(friendlyError(error));
    return this.loadProfile(data.user);
  }

  async createFirstAdmin({ name, login, password }) {
    const { data, error } = await this.sb.auth.signUp({ email: toEmail(login), password, options: { data: { name } } });
    if (error) throw new Error(friendlyError(error));
    if (!data.session) throw new Error("Supabase'da «Confirm email» yoqilgan: Authentication → Sign In / Providers → Email → Confirm email ni o'chiring va qayta urinib ko'ring.");
    return this.loadProfile(data.user);
  }

  async signOut() {
    this.unsubscribe();
    await this.sb.auth.signOut();
  }

  async saveUser(user, password, isNew) {
    if (isNew) {
      // Alohida mijoz: administratorning o'z sessiyasi almashib ketmasligi uchun
      const tmp = window.supabase.createClient(this.cfg.url, this.cfg.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'bt-signup' },
      });
      const { data, error } = await tmp.auth.signUp({ email: toEmail(user.login), password, options: { data: { name: user.name } } });
      if (error) throw new Error(friendlyError(error));
      if (!data.user?.id || (data.user.identities && !data.user.identities.length)) throw new Error('Bu login band — boshqasini tanlang.');
      user.id = data.user.id;
    }
    const { error } = await this.sb.from('profiles')
      .update({ name: user.name, role: user.role, active: user.active, perms: user.perms ?? null })
      .eq('id', user.id);
    if (error) throw new Error(friendlyError(error));
  }

  async changeOwnPassword(me, password) {
    const { error } = await this.sb.auth.updateUser({ password });
    if (error) throw new Error(friendlyError(error));
  }

  async listUsers() {
    return (await this.fetchAll('profiles', 'id,name,login,role,active,perms')).map((u) => ({ ...u, login: shortLogin(u.login) }));
  }

  // --- Ma'lumotlar ---

  get isAdmin() {
    return this.profile?.role === 'admin';
  }

  // Kelish narxlari (alohida jadval) — administrator va "tannarxni ko'rish" ruxsati borlarga
  get canCosts() {
    return this.isAdmin || permsOf(this.profile).includes('costs');
  }

  async fetchAll(table, columns = 'id,data') {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.sb.from(table).select(columns).order('id').range(from, from + 999);
      if (error) throw new Error(`${table}: ${friendlyError(error)}`);
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  async load(defaults) {
    const [rows, costs, settings, profiles] = await Promise.all([
      Promise.all(ENTITY_TABLES.map((t) => this.fetchAll(t))),
      this.canCosts ? this.fetchAll('product_costs') : Promise.resolve([]),
      this.fetchAll('settings'),
      this.listUsers(),
    ]);
    const db = Object.assign({}, defaults);
    this.snap = {};
    ENTITY_TABLES.forEach((t, i) => {
      db[t] = rows[i].map((r) => r.data);
      this.snap[t] = new Map(rows[i].map((r) => [r.id, stableJson(r.data)]));
    });
    this.snap.product_costs = new Map(costs.map((r) => [r.id, stableJson(r.data)]));
    const costMap = new Map(costs.map((r) => [r.id, r.data.buyPrice]));
    db.products.forEach((p) => { if (costMap.has(p.id)) p.buyPrice = costMap.get(p.id); });
    this.snap.settings = new Map(settings.map((r) => [r.id, stableJson(r.data)]));
    settings.forEach((r) => { if (SETTINGS_KEYS.includes(r.id)) db[r.id] = r.data.value; });
    db.users = profiles;
    this.restoredPending = this.applyOutbox(db);

    // Yangi bazani administrator birinchi kirganda boshlang'ich ma'lumotlar bilan to'ldiramiz
    if (this.isAdmin && !db.warehouses.length) {
      db.warehouses = defaults.warehouses;
      if (!db.counterparties.length) db.counterparties = defaults.counterparties;
      await this.commit(db);
    }
    return db;
  }

  // Joriy holatni qatorlarga aylantiramiz: { jadval: Map(id → data) }
  rowsOf(db) {
    const out = {};
    ENTITY_TABLES.forEach((t) => {
      out[t] = new Map((db[t] || []).map((x) => {
        if (t === 'products') {
          const { buyPrice, ...rest } = x;
          return [x.id, rest];
        }
        return [x.id, x];
      }));
    });
    if (this.canCosts) out.product_costs = new Map((db.products || []).map((p) => [p.id, { buyPrice: p.buyPrice || 0 }]));
    if (this.isAdmin) {
      out.settings = new Map(SETTINGS_KEYS.filter((k) => db[k] !== undefined).map((k) => [k, { value: db[k] }]));
    }
    return out;
  }

  async commit(db) {
    const rows = this.rowsOf(db);
    const order = [...ENTITY_TABLES.slice(0, 3), 'product_costs', ...ENTITY_TABLES.slice(3), 'settings'];
    const plan = order.filter((t) => rows[t]).map((t) => {
      const snap = this.snap[t] || new Map();
      const upserts = [];
      rows[t].forEach((data, id) => {
        const json = stableJson(data);
        if (snap.get(id) !== json) upserts.push({ id, data, json });
      });
      const deletes = [...snap.keys()].filter((id) => !rows[t].has(id));
      return { t, upserts, deletes };
    });
    // Yuborilmagan o'zgarishlar avval telefon xotirasiga yoziladi: internet uzilib, dastur yopilsa ham
    // yo'qolmaydi va keyingi ochilishda serverga yuboriladi
    this.saveOutbox(plan);
    // Avval qo'shish/yangilash (bog'liq yozuvlar tartibida), keyin teskari tartibda o'chirish
    for (const { t, upserts } of plan) {
      for (let i = 0; i < upserts.length; i += 500) {
        const chunk = upserts.slice(i, i + 500);
        const { error } = await this.sb.from(t).upsert(chunk.map(({ id, data }) => ({ id, data })));
        if (error) throw syncError(error);
        this.snap[t] = this.snap[t] || new Map();
        chunk.forEach(({ id, json }) => this.snap[t].set(id, json));
      }
    }
    for (const { t, deletes } of plan.slice().reverse()) {
      for (let i = 0; i < deletes.length; i += 200) {
        const chunk = deletes.slice(i, i + 200);
        const { error } = await this.sb.from(t).delete().in('id', chunk);
        if (error) throw syncError(error);
        chunk.forEach((id) => this.snap[t].delete(id));
      }
    }
    this.saveOutbox([]);
  }

  get outboxKey() {
    return 'biznes-tizim-outbox-' + (this.profile?.id || '');
  }

  saveOutbox(plan) {
    const items = plan.filter((x) => x.upserts.length || x.deletes.length)
      .map(({ t, upserts, deletes }) => ({ t, upserts: upserts.map(({ id, data }) => ({ id, data })), deletes }));
    try {
      if (items.length) localStorage.setItem(this.outboxKey, JSON.stringify({ at: new Date().toISOString(), items }));
      else localStorage.removeItem(this.outboxKey);
    } catch (e) { console.warn('Outbox:', e); }
  }

  // Serverdan yuklangan holatga oldingi seansda yuborilmay qolgan o'zgarishlarni qo'yamiz
  // (dastur keyin ularni odatdagidek serverga yuboradi). Qaytaradi: nechta yozuv tiklandi
  applyOutbox(db) {
    let box = null;
    try { box = JSON.parse(localStorage.getItem(this.outboxKey) || 'null'); } catch (e) { /* buzilgan */ }
    if (!box?.items?.length) return 0;
    let n = 0;
    box.items.forEach(({ t, upserts, deletes }) => {
      upserts.forEach(({ id, data }) => {
        n++;
        if (t === 'settings') { if (SETTINGS_KEYS.includes(id)) db[id] = data.value; return; }
        if (t === 'product_costs') { const p = db.products.find((x) => x.id === id); if (p) p.buyPrice = data.buyPrice; return; }
        if (!Array.isArray(db[t])) return;
        const i = db[t].findIndex((x) => x.id === id);
        // Mahsulot qatorida kelish narxi alohida saqlanadi — uni yo'qotmaymiz
        const merged = t === 'products' && i >= 0 ? { ...data, buyPrice: db[t][i].buyPrice } : data;
        if (i >= 0) db[t][i] = merged; else db[t].push(merged);
      });
      deletes.forEach((id) => {
        n++;
        if (Array.isArray(db[t])) db[t] = db[t].filter((x) => x.id !== id);
      });
    });
    return n;
  }

  async nextNo(kind, prefix) {
    const { data, error } = await this.sb.rpc('next_no', { kind, prefix });
    if (error) throw new Error(friendlyError(error));
    return data;
  }

  async counters() {
    return {}; // hisoblagichlar serverda; zaxira nusxaga kerak emas
  }

  async setCounters(seq) {
    if (!seq || !Object.keys(seq).length) return;
    const { error } = await this.sb.rpc('set_counters', { seq });
    if (error) throw new Error(friendlyError(error));
  }

  // Sotuvchi uchun qoldiq serverda hisoblanadi (u xarid hujjatlarini ko'rmaydi)
  async stockLevels() {
    const { data, error } = await this.sb.rpc('stock_levels');
    if (error) throw new Error(friendlyError(error));
    const st = {};
    (data || []).forEach((r) => {
      if (!r.product_id || !r.warehouse_id) return;
      st[r.product_id] = st[r.product_id] || {};
      st[r.product_id][r.warehouse_id] = (st[r.product_id][r.warehouse_id] || 0) + Number(r.qty);
    });
    return st;
  }

  // Boshqa qurilmalardagi o'zgarishlarni `db` ga qo'llaydi
  subscribe(db, onChange) {
    this.unsubscribe();
    this.channel = this.sb.channel('biznes-tizim');
    ['products', 'product_costs', 'warehouses', 'counterparties', 'docs', 'payments', 'settings', 'profiles'].forEach((table) => {
      this.channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        if (this.applyChange(db, table, payload)) onChange(table);
      });
    });
    this.channel.subscribe();
  }

  unsubscribe() {
    if (this.channel) this.sb.removeChannel(this.channel);
    this.channel = null;
  }

  applyChange(db, table, { eventType, new: row, old }) {
    const id = row?.id || old?.id;
    if (!id) return false;
    if (table === 'profiles') {
      const i = db.users.findIndex((u) => u.id === id);
      if (eventType === 'DELETE') { if (i >= 0) db.users.splice(i, 1); } else {
        const u = { id: row.id, name: row.name, login: shortLogin(row.login), role: row.role, active: row.active, perms: row.perms ?? undefined };
        if (i >= 0) db.users[i] = u; else db.users.push(u);
      }
      return true;
    }
    const snap = (this.snap[table] = this.snap[table] || new Map());
    if (eventType === 'DELETE') {
      if (!snap.has(id)) return false;
      snap.delete(id);
    } else {
      const json = stableJson(row.data);
      if (snap.get(id) === json) return false; // o'zimizning o'zgarishimiz qaytib keldi
      snap.set(id, json);
    }
    const data = eventType === 'DELETE' ? null : row.data;
    if (table === 'settings') {
      if (data && SETTINGS_KEYS.includes(id)) db[id] = data.value;
      return true;
    }
    if (table === 'product_costs') {
      const p = db.products.find((x) => x.id === id);
      if (p) p.buyPrice = data ? data.buyPrice : 0;
      return true;
    }
    const list = db[table];
    const i = list.findIndex((x) => x.id === id);
    if (!data) {
      if (i >= 0) list.splice(i, 1);
    } else {
      if (table === 'products' && i >= 0) data.buyPrice = list[i].buyPrice;
      if (i >= 0) list[i] = data; else list.push(data);
    }
    return true;
  }

  // --- Rasmlar ---

  async uploadPhoto(blob) {
    const { full, thumb, ext } = await preparePhoto(blob);
    const path = photoPath(ext);
    const thumbPath = photoPath(ext, '_t');
    const storage = this.sb.storage.from(PHOTO_BUCKET);
    for (const [p, b] of [[path, full], [thumbPath, thumb]]) {
      const { error } = await storage.upload(p, b, { contentType: b.type, cacheControl: '31536000' });
      if (error) throw new Error('Rasm yuklanmadi: ' + friendlyError(error));
    }
    return { path, thumb: thumbPath };
  }

  async deletePhotos(paths) {
    if (!paths.length) return;
    const { error } = await this.sb.storage.from(PHOTO_BUCKET).remove(paths);
    if (error) console.warn('Rasm o\'chirilmadi:', error);
  }

  async photoUrl(path) {
    return path ? this.sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl : '';
  }

  async photoBlob(path) {
    const res = await fetch(await this.photoUrl(path));
    return res.ok ? res.blob() : null;
  }

  async storageUsage() {
    const { data, error } = await this.sb.rpc('photos_usage');
    if (error) return null;
    return { used: Number(data) || 0, limit: 1024 ** 3 }; // bepul tarif: 1 GB
  }
}
