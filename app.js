'use strict';

/*
 * Biznes Tizim — mebel do'koni uchun ombor va savdo hisobi.
 * Hisob hujjatlarga asoslangan: tovar qoldig'i va kontragent qarzlari
 * saqlanmaydi, balki hujjatlar (qabul qilish, sotuv, qaytarish...)
 * va to'lovlardan har safar hisoblab chiqiladi.
 */

// ---------- Ma'lumotnomalar ----------

const ORDER_STATUSES = { new: 'Yangi', confirmed: 'Tasdiqlandi', making: 'Tayyorlanmoqda', shipped: 'Sotildi', cancel: 'Bekor qilindi' };
const PO_STATUSES = { new: 'Yangi', sent: 'Yuborildi', received: 'Qabul qilindi', cancel: 'Bekor qilindi' };
const DELIVERY_STATUSES = { pending: 'Yetkazilishi kerak', onway: "Yo'lda", delivered: 'Yetkazildi' };

// stock: ombor qoldig'iga ta'siri; money: kontragent bizga qarzi qanday o'zgaradi;
// pay: hujjat bo'yicha to'lov yo'nalishi; next: shu hujjat asosida yaratiladigan hujjat.
const DOC_TYPES = {
  purchaseOrder: { fx: true, list: "Ta'minotchiga buyurtmalar", one: "Ta'minotchiga buyurtma", prefix: 'TB', party: 'supplier', price: 'buy', stock: 0, money: 0, statuses: PO_STATUSES, pay: 'out', next: 'receipt' },
  receipt: { fx: true, tgAsk: true, list: 'Qabul qilish', one: 'Qabul qilish', prefix: 'QQ', party: 'supplier', price: 'buy', stock: 1, money: -1, pay: 'out', next: 'purchaseReturn' },
  purchaseReturn: { fx: true, list: "Ta'minotchiga qaytarish", one: "Ta'minotchiga qaytarish", prefix: 'TQ', party: 'supplier', price: 'buy', stock: -1, money: 1, pay: 'in' },
  order: { list: 'Mijoz buyurtmalari', one: 'Mijoz buyurtmasi', prefix: 'MB', party: 'customer', price: 'sale', stock: 0, money: 0, statuses: ORDER_STATUSES, pay: 'in', delivery: true, next: 'sale' },
  sale: { list: 'Sotuv', one: 'Sotuv', add: 'Sotish', prefix: 'S', party: 'customer', price: 'sale', stock: -1, money: 1, statuses: DELIVERY_STATUSES, pay: 'in', delivery: true, next: 'salesReturn' },
  salesReturn: { list: 'Mijozdan qaytarish', one: 'Mijozdan qaytarish', prefix: 'MQ', party: 'customer', price: 'sale', stock: 1, money: -1, pay: 'out' },
  enter: { fx: true, tgAsk: true, list: 'Kirim qilish', one: 'Kirim qilish', prefix: 'K', price: 'buy', stock: 1, money: 0 },
  writeoff: { list: 'Hisobdan chiqarish', one: 'Hisobdan chiqarish', prefix: 'HC', price: 'buy', stock: -1, money: 0 },
  move: { list: "Ko'chirish", one: "Ko'chirish", prefix: 'KO', price: 'buy', stock: 0, money: 0, move: true },
  inventory: { list: 'Inventarizatsiya', one: 'Inventarizatsiya', prefix: 'INV', price: 'buy', stock: 0, money: 0 },
};

// Rezervga olinadigan (hali jo'natilmagan) buyurtma holatlari
const RESERVING = ['new', 'confirmed', 'making'];

const PAY_METHODS = { cash: 'Naqd (kassa)', card: "Karta (o'tkazma)", terminal: 'Terminal', bank: 'Perechisleniye (hisob raqam)' };
// Naqd bo'lmagan to'lovda chek surati so'raladi va Telegramga saqlanadi
const NEEDS_RECEIPT = ['card', 'terminal', 'bank'];
const cashTotal = (b) => Object.keys(PAY_METHODS).reduce((s, k) => s + (b[k] || 0), 0);
const PAY_PURPOSES_IN = ["Mijozdan to'lov", "Ta'minotchidan qaytim", 'Boshqa kirim'];
const PAY_PURPOSES_OUT = ["Ta'minotchiga to'lov", 'Mijozga qaytarish', 'Ijara', 'Ish haqi', 'Kommunal', 'Transport / yetkazish', 'Soliq', 'Reklama', 'Boshqa xarajat'];
// Kontragentga bog'liq bo'lmagan chiqimlar foyda hisobotida xarajat sifatida olinadi
const EXPENSE_PURPOSES = PAY_PURPOSES_OUT.slice(2);

// Xarajat moddalari (Xarajatlar → Moddalar bo'limida o'zgartiriladi)
// subs — modda ichidagi tugmalar (masalan, Kommunal → Elektr, Gaz), subsOn — ular yoqilganmi.
// Oylik moddasida ichki tugmalar — xodimlar ismlari.
const DEFAULT_EXPENSE_CATS = [
  { name: 'Ish haqi (oylik)', emoji: '👷', subsOn: true, subs: [] },
  { name: 'Ombor (sklad) ijarasi', emoji: '🏭' },
  { name: "Do'kon ijarasi", emoji: '🏪' },
  { name: "Kommunal to'lovlar", emoji: '💡', subsOn: true, subs: ['Elektr', 'Maxsustrans', 'Gaz'] },
  { name: "Avtomashina yoqilg'isi", emoji: '⛽' },
  { name: 'Ovqat (obed)', emoji: '🍽' },
  { name: "Yo'lkira", emoji: '🚚', subsOn: true, subs: ['Yetkazish', 'Olib kelish'] },
  { name: 'Reklama', emoji: '📣' },
  { name: 'Soliq', emoji: '🧾' },
  { name: "Ta'mirlash", emoji: '🔧' },
  { name: 'Boshqa xarajat', emoji: '📦' },
];
const isSalaryCat = (name) => /ish haqi|oylik|maosh/i.test(name || '');

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

// Yetkazish manzillari: viloyat → shahar/tuman → mahalla/joy. Asosiy savdo hududi — Farg'ona
// viloyati va Farg'ona shahri — ro'yxatda doim birinchi turadi va oldindan tanlangan bo'ladi.
const P = (name, spots = []) => ({ name, spots });
const DEFAULT_REGIONS = [
  { name: "Farg'ona viloyati", places: [P("Farg'ona shahri", ['Joydam']), P("Marg'ilon shahri", ['Yovqachar']), P("Qo'qon shahri"), P('Quvasoy shahri'),
    P('Quva tumani', ['Akbarobod']), P('Oltiariq tumani'), P("Bag'dod tumani"), P('Beshariq tumani'), P('Buvayda tumani'), P("Dang'ara tumani"),
    P("Farg'ona tumani"), P('Furqat tumani'), P("Qo'shtepa tumani"), P('Rishton tumani'), P("So'x tumani"), P('Toshloq tumani'),
    P("Uchko'prik tumani"), P("O'zbekiston tumani"), P('Yozyovon tumani')] },
  { name: 'Andijon viloyati', places: [P('Andijon shahri'), P('Xonobod shahri'), P('Asaka tumani', ['Shahar markazi']), P('Andijon tumani'),
    P('Baliqchi tumani'), P("Bo'ston tumani"), P('Buloqboshi tumani'), P('Izboskan tumani'), P('Jalaquduq tumani'), P("Xo'jaobod tumani"),
    P("Qo'rg'ontepa tumani"), P('Marhamat tumani'), P("Oltinko'l tumani"), P('Paxtaobod tumani'), P('Shahrixon tumani'), P("Ulug'nor tumani")] },
  { name: 'Namangan viloyati', places: [P('Namangan shahri'), P('Chortoq tumani'), P('Chust tumani'), P('Kosonsoy tumani'), P('Mingbuloq tumani'),
    P('Namangan tumani'), P('Norin tumani'), P('Pop tumani'), P("To'raqo'rg'on tumani"), P("Uchqo'rg'on tumani"), P('Uychi tumani'), P("Yangiqo'rg'on tumani")] },
  ...['Toshkent shahri', 'Toshkent viloyati', 'Samarqand viloyati', 'Buxoro viloyati', 'Navoiy viloyati', 'Qashqadaryo viloyati',
    'Surxondaryo viloyati', 'Jizzax viloyati', 'Sirdaryo viloyati', 'Xorazm viloyati', "Qoraqalpog'iston Respublikasi"].map((name) => ({ name, places: [] })),
];

// Mijoz turlari (Sozlamalarda o'zgartiriladi)
const DEFAULT_CUSTOMER_TYPES = ['Chakana xaridor', 'Mebelchi', 'Domchi', "Do'konchi", 'Optomchi', "Uy to'ldiruvchi"];

const CHAIR_COLORS_BY = {
  Mato: ['Kulrang', "To'q kulrang", 'Qora', "To'q ko'k", "Ko'k", 'Bej', 'Yashil', 'Qizil', "To'q sariq"],
  'Eko-charm': ['Qora', 'Oq', 'Jigarrang', 'Kapuchino', 'Bej', 'Kulrang', 'Qizil'],
  'Tabiiy charm': ['Qora', 'Jigarrang', 'Konyak', 'Bej', 'Oq'],
  "Setka (to'r)": ['Qora', 'Kulrang', 'Oq', "Ko'k"],
  Velyur: ['Kulrang', 'Bej', 'Yashil', "To'q ko'k", 'Pushti'],
  'Aralash (charm + setka)': ['Qora', 'Kulrang', 'Oq + qora'],
};

// Kategoriya/turga xos xususiyatlar: shu turdagi mahsulot kartochkasida o'z ranglari va qo'shimcha
// maydonlari chiqadi (Sozlamalar → Ro'yxatlar da o'zgartiriladi). "applies" — "Kategoriya" yoki "Kategoriya › Tur"
// Stullar: LDSP/MDF ranglari o'rniga qoplama materiali (mago, meshkovina, charm) va karkas
const STUL_SET = {
  id: 'stul',
  name: 'Stullar',
  applies: ['Stol va stul › Stul', 'Oshxona › Oshxona stuli', 'Oshxona › Bar stuli', 'Ofis mebeli › Stul'],
  colors: ['Kulrang', 'Bej', 'Qora', 'Oq', 'Jigarrang', 'Kapuchino', 'Yashil', "To'q ko'k", 'Pushti'],
  colorField: 'Qoplama materiali',
  colorsBy: {
    Mago: ['Kulrang', "To'q kulrang", 'Bej', 'Kapuchino', 'Yashil', "To'q ko'k", 'Pushti', 'Qora'],
    Meshkovina: ['Bej', 'Qum rang', 'Kulrang', 'Jigarrang', 'Zaytun'],
    Charm: ['Qora', 'Jigarrang', 'Oq', 'Bej', 'Kapuchino', 'Konyak'],
    'Eko-charm': ['Qora', 'Oq', 'Jigarrang', 'Bej', 'Kapuchino', 'Kulrang'],
    Velyur: ['Kulrang', 'Bej', 'Yashil', "To'q ko'k", 'Pushti'],
  },
  fields: [
    { name: 'Qoplama materiali', options: ['Mago', 'Meshkovina', 'Charm', 'Eko-charm', 'Velyur'] },
    { name: 'Karkas', options: ['Temir', "Yog'och", 'Plastmas'] },
  ],
};

const DEFAULT_FEATURE_SETS = [{
  id: 'chairs',
  name: 'Ofis kreslo va stullar',
  applies: ['Ofis mebeli › Ofis kreslo', 'Ofis mebeli › Rahbar kreslosi'],
  colors: ['Qora', 'Kulrang', 'Oq', 'Bej', 'Jigarrang', "To'q ko'k", "Ko'k", 'Qizil', 'Yashil', "To'q sariq"],
  // Avval material tanlanadi, keyin shu materialning ranglari chiqadi
  colorField: 'Qoplama materiali',
  colorsBy: CHAIR_COLORS_BY,
  fields: [
    { name: 'Qoplama materiali', options: ['Mato', 'Eko-charm', 'Tabiiy charm', "Setka (to'r)", 'Velyur', 'Aralash (charm + setka)'] },
    { name: 'Krestovina turi', options: ['Plastik', 'Neylon', 'Xrom', 'Alyuminiy', "Yog'och", "Metall (bo'yalgan)"] },
    { name: 'Mexanizm', options: ["Piastra (oddiy ko'tarish)", 'Tilt (tebranish)', 'Top-Gun', 'Multiblok', 'Sinxron', 'Anyfix'] },
  ],
}, STUL_SET];

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
    featureSets: JSON.parse(JSON.stringify(DEFAULT_FEATURE_SETS)),
    categoryIcons: {},
    categoryColors: {}, // kategoriyaning o'z ranglari (bo'sh — umumiy ranglar)
    expenseCats: JSON.parse(JSON.stringify(DEFAULT_EXPENSE_CATS)),
    uiOrder: { sections: [], tabs: {} },
    drivers: [],
    driverChats: [],
    staffNames: [],
    customerTypes: DEFAULT_CUSTOMER_TYPES.slice(),
    regions: JSON.parse(JSON.stringify(DEFAULT_REGIONS)),
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
  // Avval saqlangan kreslo to'plamiga "material → ranglar" bog'lanishini qo'shamiz
  (out.featureSets || []).forEach((f) => {
    if (f.id === 'chairs' && f.colorField === undefined) Object.assign(f, { colorField: 'Qoplama materiali', colorsBy: JSON.parse(JSON.stringify(CHAIR_COLORS_BY)) });
  });
  return out;
}

let backend = null;
let db = emptyDb();
let syncState = { offline: false, message: '' };

// O'zgarishlar navbat bilan yuboriladi. Internet uzilsa — keyinroq qayta urinadi.
let commitQueue = Promise.resolve();
let retryTimer = null;

function commit(quiet = false) {
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
    // Sozlamalardagi ro'yxatlar o'zi saqlanganda sahifa qayta chizilmaydi (yozilayotgan matn yo'qolmasin)
    if (!quiet) render();
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
  el.textContent = offline ? "⚠️ Internet yo'q — o'zgarishlar telefonda saqlandi va internet qaytganda (yoki dastur keyingi safar ochilganda) serverga o'zi yuboriladi." : '';
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
// Administrator xodimning ruxsatlarini o'zgartirsa — xodimning dasturida darhol kuchga kiradi
// (qayta kirish shart emas): kerakli ma'lumotlar serverdan qayta yuklanadi.
let accessReloading = false;
async function checkMyAccess() {
  const u = me && db.users.find((x) => x.id === me.id);
  if (!u || u.active === false || accessReloading) return; // bloklanganini render() o'zi hal qiladi
  const key = (x) => x.role + '|' + JSON.stringify(permsOf(x));
  if (key(u) === key(me)) return;
  Object.assign(me, { role: u.role, perms: u.perms });
  accessReloading = true;
  try {
    await loadData();
    render();
    alert("Administrator ruxsatlaringizni o'zgartirdi. Dastur yangilandi.");
  } finally {
    accessReloading = false;
  }
}

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
    backend.subscribe(db, (table) => { if (table === 'profiles') checkMyAccess(); scheduleRender(); });
    if (isAdmin()) refreshStorageUsage();
    refreshRate();
  } finally {
    showLoading(false);
  }
  requestPersistentStorage();
  setTimeout(autoBackup, 5000);
  // Oldingi safar internet yo'qligida kiritilib, yuborilmay qolgan o'zgarishlar — endi serverga
  const pending = backend.restoredPending;
  if (pending) {
    backend.restoredPending = 0;
    commit();
    setTimeout(() => alert(`Oldingi safar internet yo'qligida kiritilgan ${pending} ta o'zgarish serverga yuborilmoqda.`), 300);
  }
}

function showLoading(on, text = 'Yuklanmoqda...') {
  $('#loading').hidden = !on;
  $('#loadingText').textContent = text;
}

// ---------- Foydalanuvchilar va kirish ----------

const ROLES = { admin: 'Administrator', seller: 'Sotuvchi', purchaser: "Ta'minot xodimi" };

// Administrator har bir foydalanuvchiga qaysi bo'limlar ochiqligini belgilaydi
const PERMS = {
  sale: ['Sotish', "Sotuv, buyurtma, mijozdan qaytarish; mijozlar va ulardan to'lov olish"],
  enter: ['Kirim qilish', "Omborga tovar kiritish (Kirim qilish hujjati) va yangi mahsulot qo'shish"],
  purchase: ['Xaridlar', "Ta'minotchiga buyurtma, qabul qilish, qaytarish; ta'minotchilar"],
  stockOps: ['Ombor amallari', "Hisobdan chiqarish, ko'chirish, inventarizatsiya"],
  products: ['Mahsulotlar', "Mahsulot qo'shish va kartochkani o'zgartirish"],
  partyAdd: ["Kontragent qo'shish", "Kontragentlar bo'limida yangi mijoz yoki ta'minotchi qo'shish (sotuvda yangi xaridor baribir yoziladi)"],
  costs: ['Tannarx', "Kelish narxi, tannarx va ombordagi tovar qiymatini ko'rish"],
  money: ['Pul', "Kassa, xarajatlar, barcha kirim-chiqim to'lovlari va qarzlar"],
  expenses: ['Xarajatlar', "Xarajat kiritish (oylik, ijara, yoqilg'i, obed, yo'lkira...) va xarajatlar ro'yxati"],
  reports: ['Hisobotlar', 'Foyda va zarar, savdo tahlili'],
};
const can = (perm) => isAdmin() || permsOf(me).includes(perm);
// Yangi mahsulot qo'shish: «Mahsulotlar» yoki «Kirim qilish» ruxsati bilan (o'zgartirish — faqat «Mahsulotlar»)
const canAddProducts = () => can('products') || can('enter');
// Kontragentlar bo'limida yangi kontragent qo'shish — alohida ruxsat
const canAddParty = () => can('partyAdd');
// Hujjat turi → kerakli ruxsat
const DOC_PERM = { order: 'sale', sale: 'sale', salesReturn: 'sale', purchaseOrder: 'purchase', receipt: 'purchase', purchaseReturn: 'purchase', enter: 'enter', writeoff: 'stockOps', move: 'stockOps', inventory: 'stockOps' };

let me = null;
const isAdmin = () => me?.role === 'admin';

let authNeedsSetup = false;
let authMessage = '';

function renderAuth() {
  const setup = authNeedsSetup;
  const loginLabel = backend.loginLabel;
  $('#authSubtitle').textContent = setup ? 'Birinchi ishga tushirish: administrator hisobini yarating.' : 'Tizimga kirish';
  $('#authForm').innerHTML = `
    ${setup ? '<label>Ismingiz<input name="name" required autocomplete="name"></label>' : ''}
    <label>${loginLabel}<input name="login" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
    <label>Parol<input name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    ${setup ? '<label>Parolni takrorlang<input name="password2" type="password" required autocomplete="new-password"></label>' : ''}
    <div class="auth-error" id="authError">${esc(authMessage)}</div>
    <button class="primary" type="submit">${setup ? 'Yaratish va kirish' : 'Kirish'}</button>
    ${serverLocked()
    ? '<div class="auth-server muted small">Login va parolni administratordan oling.</div>'
    : `<div class="auth-server muted small">${esc(backend.label)} · <a href="#" id="serverLink">${backend.kind === 'local' ? 'Serverga ulanish' : "O'zgartirish"}</a></div>`}`;
  $('#serverLink')?.addEventListener('click', (e) => { e.preventDefault(); openServerSettings(); });
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
// Hujjat qatori nomi: katalogdagi mahsulot yoki individual buyurtma nomi
const itemName = (it) => product(it.productId)?.name || it.name || "(o'chirilgan)";
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
  // Buyurtma bo'yicha oldindan to'lov uning asosidagi sotuvga ham tegishli
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
  const items = d.items.filter((it) => it.productId); // individual buyurtma omborga ta'sir qilmaydi
  if (t.move) {
    items.forEach((it) => { add(it.productId, d.warehouseId, -it.qty); add(it.productId, d.toWarehouseId, it.qty); });
  } else if (t.stock) {
    items.forEach((it) => add(it.productId, d.warehouseId, t.stock * it.qty));
  }
}

// excludeId — tahrirlanayotgan hujjatni hisobga olmaslik uchun
function computeStock(excludeId) {
  if (serverStock) {
    // Sotuvchi: serverdan kelgan qoldiq, tahrirlanayotgan hujjat ta'siri olib tashlanadi
    const st = JSON.parse(JSON.stringify(serverStock));
    const ex = excludeId && doc(excludeId);
    if (ex) applyDocStock(st, ex, -1);
    return addKitStock(st);
  }
  const st = {};
  db.docs.forEach((d) => { if (d.id !== excludeId) applyDocStock(st, d, 1); });
  return addKitStock(st);
}

// ---------- Komplektlar ----------
// Komplekt — bir nechta mahsulotdan iborat to'plam (krovat + matras, stol + 4 stul, yotoqxona to'plami).
// Uning o'z qoldig'i yo'q: har bir omborda nechta to'liq komplekt yig'ish mumkinligi tarkibidan hisoblanadi.
// Sotilganda hujjatga tarkibidagi mahsulotlar yoziladi — ombor, tannarx va hisobotlar o'zgarishsiz ishlaydi.
const isKit = (p) => Array.isArray(p?.kit) && p.kit.length > 0;
const kitParts = (p) => (p.kit || []).filter((c) => product(c.productId));

function addKitStock(st) {
  db.products.filter(isKit).forEach((k) => {
    const parts = kitParts(k);
    const m = {};
    db.warehouses.forEach((w) => {
      const n = parts.length ? Math.min(...parts.map((c) => Math.floor(qtyIn(st, c.productId, w.id) / Math.max(1, c.qty)))) : 0;
      if (n > 0) m[w.id] = n;
    });
    st[k.id] = m;
  });
  return st;
}

// Hujjat qatorlaridagi komplektni tarkibiga yoyamiz. Komplekt narxi mahsulotlar orasida
// ularning narxiga mutanosib taqsimlanadi (jami summa o'zgarmaydi).
function expandKits(items, t) {
  const out = [];
  items.forEach((it) => {
    const k = product(it.productId);
    if (!isKit(k)) return out.push(it);
    const parts = kitParts(k);
    const weight = (c) => Math.max(0, t.price === 'sale' ? salePriceUZS(product(c.productId)) : ctx.cost[c.productId] || 0) * c.qty;
    let total = parts.reduce((s, c) => s + weight(c), 0);
    const w = total ? weight : (c) => c.qty;
    if (!total) total = parts.reduce((s, c) => s + c.qty, 0);
    // Oxirgi qatorga yaxlitlash qoldig'i tushadi — iloji bo'lsa 1 donalik mahsulot oxirida turadi
    const ordered = [...parts.filter((c) => c.qty !== 1), ...parts.filter((c) => c.qty === 1)];
    let left = it.price;
    ordered.forEach((c, i) => {
      const last = i === ordered.length - 1;
      const unit = last ? Math.round((left / c.qty) * 100) / 100 : Math.round((it.price * w(c)) / total / c.qty);
      left -= unit * c.qty;
      out.push({ productId: c.productId, qty: it.qty * c.qty, price: unit, kitId: k.id, kitName: k.name, kitQty: it.qty });
    });
  });
  return out;
}

function computeReserve() {
  const rs = {};
  db.docs.filter((d) => d.type === 'order' && RESERVING.includes(d.status)).forEach((d) => {
    d.items.filter((it) => it.productId).forEach((it) => {
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
  db.products.filter(isKit).forEach((k) => { cost[k.id] = kitParts(k).reduce((s, c) => s + (cost[c.productId] || 0) * c.qty, 0); });
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
  const b = Object.fromEntries(Object.keys(PAY_METHODS).map((k) => [k, 0]));
  // Shofyor olgan, lekin hali topshirmagan pul kassaga kirmagan
  db.payments.forEach((p) => { if (p.handover?.status === 'pending') return; b[p.method] = (b[p.method] || 0) + (p.dir === 'in' ? p.amount : -p.amount); });
  return b;
}

let ctx = {};
function refreshCtx() {
  ctx = { stock: computeStock(), reserve: computeReserve(), cost: computeCost() };
}

// ---------- Modal oyna ----------

// iPhone: klaviatura ochilib-yopilganda oyna ekranning ko'rinib turgan qismiga moslashadi —
// tugmalar klaviatura ustida turadi va klaviatura yopilgach oyna joyiga qaytadi
(function trackVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  // Klaviatura yopiq bo'lsa — oyna butun ekranni egallaydi (100dvh). Aks holda iPhone ba'zan
  // eski (klaviatura ochiq paytdagi) balandlikni qoldirib, tugmalar ekran o'rtasida qolib ketardi.
  const typing = () => {
    const el = document.activeElement;
    return !!el && (el.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type)));
  };
  const apply = () => {
    const full = document.documentElement.clientHeight || window.innerHeight;
    const kb = typing() && vv.height < full - 120;
    if (kb) {
      root.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
    } else {
      root.removeProperty('--vvh');
      root.removeProperty('--vvt');
      // iPhone klaviatura yopilgach sahifani surilgan holda qoldiradi — oyna ekran o'rtasiga «tushib» qolardi
      const base = window.modalScrollY ?? 0;
      if (document.querySelector('dialog[open]') && (Math.abs(window.scrollY - base) > 2 || vv.offsetTop)) window.scrollTo(0, base);
    }
  };
  // Klaviatura yopilish animatsiyasi tugaguncha bir necha marta qayta tekshiramiz
  const settle = () => { apply(); [80, 250, 500, 900].forEach((t) => setTimeout(apply, t)); };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', settle);
  window.addEventListener('orientationchange', settle);
  window.addEventListener('pageshow', settle);
  document.addEventListener('visibilitychange', settle);
  window.trackViewportSettle = settle;
  apply();
})();

let modalState = null;

function openModal({ title, body, onSubmit, onOpen, extra = [], wide = false, submitText = 'Saqlash' }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modal').classList.toggle('wide', wide);
  $('#modalSubmit').textContent = submitText;
  $('#modalSubmit').hidden = !onSubmit;
  $('#modalExtra').innerHTML = extra.map((b, i) => `<button type="button" class="${b.cls || ''}" data-extra="${i}">${esc(b.label)}</button>`).join('');
  modalState = { onSubmit, extra };
  if (!$('#modal').open) { window.modalScrollY = window.scrollY; $('#modal').showModal(); }
  document.documentElement.classList.add('modal-open');
  window.trackViewportSettle?.();
  $('#modalBody').scrollTop = 0;
  if (onOpen) onOpen();
  hydratePhotos($('#modalBody'));
  cardTables($('#modalBody'));
  // Telefonda oyna ochilishi bilan klaviatura yoki kalendar chiqib ketmasin — maydonni o'zingiz bosasiz
  if (isTouch()) $('#modalTitle').focus({ preventScroll: true });
}

const isTouch = () => window.matchMedia('(pointer: coarse), (max-width: 700px)').matches;

// Telefonda jadval qatorlari kartochkaga aylanadi: har bir katakka ustun nomi yoziladi (CSS ko'rsatadi)
function cardTables(root) {
  $$('table', root).forEach((table) => {
    if (['items-table', 'kit-table', 'exp-cats'].some((c) => table.classList.contains(c))) return;
    const heads = $$('thead th', table).map((th) => th.textContent.trim());
    table.classList.add('m-cards');
    $$('tbody tr, tfoot tr', table).forEach((tr) => {
      let i = 0;
      [...tr.cells].forEach((td) => {
        td.dataset.label = td.colSpan > 1 ? '' : heads[i] || '';
        i += td.colSpan || 1;
      });
    });
  });
}

function closeModal() {
  $('#modal').close();
}
// Oyna ochiq paytda orqadagi sahifa surilmaydi (iPhone'da oyna joyidan siljimasin)
document.addEventListener('close', () => {
  if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('modal-open');
  window.trackViewportSettle?.();
}, true);

// Ichki oyna — asosiy oyna (masalan, sotuv) yopilmasdan uning ustida ochiladi
let subState = null;
function openSubModal({ title, body, onSubmit, onOpen, submitText = 'Saqlash' }) {
  $('#subTitle').textContent = title;
  $('#subBody').innerHTML = body;
  $('#subSubmit').textContent = submitText;
  subState = { onSubmit };
  if (!$('#subModal').open) $('#subModal').showModal();
  if (onOpen) onOpen();
  if (isTouch()) $('#subTitle').focus({ preventScroll: true });
}
$('#subCancel').addEventListener('click', () => $('#subModal').close());
$('#subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bad = $$('[required]', e.target).find((el) => !el.value.trim());
  if (bad) { bad.focus(); return; }
  const btn = $('#subSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(e.target).entries());
    const ok = await subState?.onSubmit?.(data);
    if (ok !== false) $('#subModal').close();
  } catch (ex) {
    alert('Xato: ' + ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// ---------- To'lov cheklari (karta, terminal, perechisleniye) ----------
// Chek surati serverda joy egallamaydi: Telegram bot orqali administratorning chatiga yuboriladi,
// to'lovda faqat Telegram fayl ID si saqlanadi (dasturda ko'rish mumkin).
let receiptFiles = [];

async function shrinkReceipt(file) {
  try {
    const img = await loadImage(file);
    return (await canvasToBlob(img, 1600, 'image/jpeg', 0.82)) || file;
  } catch (e) {
    return file;
  }
}

function renderReceiptLine() {
  const line = $('#receiptLine');
  if (!line) return;
  const method = $('#modalBody [name=payMethod]')?.value;
  const pay = num($('#modalBody [name=payNow]')?.value);
  line.hidden = !(NEEDS_RECEIPT.includes(method) && pay > 0);
  line.innerHTML = `🧾 <b>Chek surati:</b> ${receiptFiles.length ? `${receiptFiles.length} ta` : "<span class='debt'>qo'shilmagan</span>"}
    <button type="button" class="small" id="receiptOpen">${receiptFiles.length ? "O'zgartirish" : 'Chekni suratga olish'}</button>`;
}

function openReceiptPicker() {
  const draw = () => {
    $('#rcList').innerHTML = receiptFiles.length
      ? receiptFiles.map((f, i) => `<div class="rc-ph"><img src="${f.url}" alt="" data-i="${i}"><button type="button" class="ph-del rc-del" data-i="${i}" title="O'chirish">×</button></div>`).join('')
      : `<div class="photo-empty">${icon('camera')}<span>Hali surat yo'q</span></div>`;
  };
  openSubModal({
    title: 'Chek surati',
    submitText: 'Tayyor',
    body: `<p class="muted small">Karta, terminal yoki perechisleniye chekini suratga oling yoki galereyadan tanlang. Surat serverda emas, <b>Telegram</b>da saqlanadi.</p>
      <div class="rc-btns">
        <label class="btn-like primary">${icon('camera')}<span>Suratga olish</span><input type="file" id="rcCam" accept="image/*" capture="environment" hidden></label>
        <label class="btn-like">${icon('upload')}<span>Galereyadan</span><input type="file" id="rcGal" accept="image/*" multiple hidden></label>
      </div>
      <div class="rc-list" id="rcList"></div>`,
    onOpen: () => {
      draw();
      const add = (e) => {
        [...e.target.files].slice(0, 10 - receiptFiles.length).forEach((file) => receiptFiles.push({ file, url: URL.createObjectURL(file) }));
        e.target.value = '';
        draw();
      };
      $('#rcCam').addEventListener('change', add);
      $('#rcGal').addEventListener('change', add);
      $('#rcList').addEventListener('click', (e) => {
        const del = e.target.closest('.rc-del');
        if (del) {
          if (!confirm("Chek surati o'chirilsinmi?")) return;
          const [f] = receiptFiles.splice(+del.dataset.i, 1);
          URL.revokeObjectURL(f.url);
          draw();
          return;
        }
        const img = e.target.closest('img[data-i]');
        if (img) openLightbox(receiptFiles.map((f) => ({ url: f.url })), +img.dataset.i);
      });
    },
    onSubmit: () => renderReceiptLine(),
  });
  $('#subModal').addEventListener('close', renderReceiptLine, { once: true });
}

// Saqlashda: cheklarni Telegramga yuboradi
async function sendReceipts(caption) {
  if (!receiptFiles.length) return [];
  const files = await Promise.all(receiptFiles.map((f) => shrinkReceipt(f.file)));
  if (backend.kind === 'supabase') return backend.uploadReceipts(files, caption);
  // Lokal rejim: brauzerdan to'g'ridan-to'g'ri bot orqali
  const tg = db.telegram;
  if (!tg.token || !tg.backupChatId) throw new Error("Telegram sozlanmagan: Sozlamalar → Telegram va Zaxira nusxa → «Mening Telegramimni aniqlash»");
  const out = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append('chat_id', tg.backupChatId);
    fd.append('photo', f, 'chek.jpg');
    fd.append('caption', caption);
    const res = await telegramCall('sendPhoto', fd);
    const ph = res.result.photo;
    out.push({ fileId: ph[ph.length - 1].file_id, msgId: res.result.message_id, chat: String(tg.backupChatId) });
  }
  return out;
}

async function receiptUrl(fileId) {
  if (backend.kind === 'supabase') return backend.receiptUrl(fileId);
  const res = await telegramCall('getFile', { file_id: fileId });
  return `https://api.telegram.org/file/bot${db.telegram.token}/${res.result.file_path}`;
}

async function showReceipts(list) {
  const items = (list || []).filter((r) => r.fileId);
  if (!items.length) return;
  showLoading(true, 'Chek yuklanmoqda...');
  try {
    const urls = await Promise.all(items.map((r) => receiptUrl(r.fileId)));
    openLightbox(urls.map((url) => ({ url })), 0);
  } catch (e) {
    alert("Chekni ochib bo'lmadi: " + e.message);
  } finally {
    showLoading(false);
  }
}

// ---------- Sotuv paytida tezkor kirim ----------

// Sotuvda kerakli mahsulot omborda yo'q (yoki bazada umuman yo'q) bo'lsa — sotuv oynasidan chiqmasdan
// shu yerning o'zida kirim qilinadi; sotuv qatori o'sha mahsulot bilan to'ldiriladi.
let docFormCtx = null; // { quick, warehouseId(), refresh(), row }

function quickEntry({ productId, name = '', qty = 1, row }) {
  if (!can('enter')) return alert("Kirim qilish uchun ruxsatingiz yo'q. Administratordan «Kirim qilish» ruxsatini so'rang.");
  const p = product(productId);
  if (!p && !canAddProducts()) return alert("Bu mahsulot bazada yo'q. Yangi mahsulot qo'shish uchun «Kirim qilish» yoki «Mahsulotlar» ruxsati kerak — administratorga murojaat qiling.");
  const wh = docFormCtx?.warehouseId?.() || db.warehouses[0]?.id;
  const showCost = can('costs');
  openSubModal({
    title: p ? `Kirim: ${p.name}` : 'Yangi mahsulotni kirim qilish',
    submitText: 'Kirim qilish',
    body: `<div class="form-grid">
        ${p ? `<p class="full muted">Omborda hozir: <b>${qtyIn(computeStock(), p.id, wh)}</b> ${esc(p.unit || 'dona')}. Kirim qilingach, sotuvga qaytasiz.</p>`
          : `${field('Nomi *', 'qName', name, 'required', 'full')}
             ${selectField('Kategoriya', 'qCategory', [['', '—'], ...db.categories.map((c) => [c, c])], '')}
             ${moneyField('Sotish narxi *', 'qSale', '', 'UZS', 'required')}`}
        <label>Soni${qtyStepper('q-qty', Math.max(1, Math.ceil(qty)))}</label>
        ${selectField('Ombor', 'qWh', db.warehouses.map((w) => [w.id, w.name]), wh)}
        ${showCost ? moneyField('Kelish narxi (bittasi)', 'qBuy', p ? Math.round(ctx.cost[p.id] || toUZS(p.buyPrice || 0, p.priceCurrency)) || '' : '', 'UZS') : ''}
      </div>`,
    onOpen: () => {
      const q = $('#subBody .q-qty');
      q.name = 'qQty';
      if (!p) setTimeout(() => $('#subBody [name=qName]').focus(), 50);
    },
    onSubmit: async (d) => {
      const n = Math.max(1, Math.round(num(d.qQty)));
      let prod = p;
      if (!prod) {
        const nm = d.qName.trim();
        if (!(num(d.qSale) > 0)) { alert('Sotish narxini kiriting.'); return false; }
        prod = { id: uid(), created: today(), name: nm, code: '', category: d.qCategory || '', type: '', size: '', color: '', material: '', origin: '', maker: '',
          unit: 'dona', priceCurrency: 'UZS', salePrice: num(d.qSale), minPrice: 0, buyPrice: showCost ? num(d.qBuy) : 0, minQty: 0, note: '', photos: [] };
        db.products.push(prod);
      }
      const buy = showCost ? num(d.qBuy) : 0;
      db.docs.push({
        id: uid(), type: 'enter', no: await nextNo('enter'), date: today(), created: new Date().toISOString(), warehouseId: d.qWh, userId: me?.id,
        items: [{ productId: prod.id, qty: n, price: buy }], // narxsiz qator o'rtacha tannarxga ta'sir qilmaydi
        note: 'Sotuv paytida tezkor kirim', currency: 'UZS', discount: 0,
      });
      await save();
      if (stockFromServer()) await refreshServerStock();
      refreshCtx();
      // Sotuv qatoriga shu mahsulotni qo'yamiz va qoldiqni yangilaymiz
      const tr = row && row.isConnected ? row : null;
      if (tr && $('.it-product', tr).value !== prod.id) {
        picker.input = $('.it-search', tr);
        choosePickedProduct(prod);
      }
      docFormCtx?.refresh?.();
      if (!p) alert(`«${prod.name}» qo'shildi va ${n} dona kirim qilindi.`);
    },
  });
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

// ---------- Telefon raqami ----------
// O'zbekiston raqami: +998 dan keyin 9 ta raqam (operator kodi + abonent): +998 90 123 45 67
const phoneDigits = (s) => String(s || '').replace(/\D/g, '');
const phoneKey = (s) => {
  let d = phoneDigits(s);
  if (d.length > 9 && d.startsWith('998')) d = d.slice(3);
  return d.slice(-9);
};

function fmtPhone(d) {
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return ['+998', ...parts].join(' ');
}

// Katakdagi raqamning +998 dan keyingi qismi. "+998 " turgan katakka butun raqam
// ("+998 90 123 45 67") joylansa, takrorlangan 998 ham olib tashlanadi.
function fieldPhoneDigits(value) {
  let d = phoneDigits(value);
  if (d.startsWith('998')) d = d.slice(3);
  if (d.length > 9 && d.startsWith('998')) d = d.slice(3);
  return d.slice(0, 9);
}

function formatPhoneInput(el) {
  const d = fieldPhoneDigits(el.value);
  el.value = fmtPhone(d) + (d.length ? '' : ' ');
}

function phoneField(label, name, value = '', attrs = '', cls = '') {
  return `<label class="${cls}">${label}<input name="${name}" class="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="+998 90 123 45 67" value="${esc(value)}" ${attrs}></label>`;
}

document.addEventListener('focusin', (e) => {
  if (e.target.classList?.contains('phone') && !e.target.value) e.target.value = '+998 ';
});
document.addEventListener('focusout', (e) => {
  if (e.target.classList?.contains('phone') && phoneDigits(e.target.value) === '998') e.target.value = '';
});
document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('phone')) formatPhoneInput(e.target);
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
      <div class="muted small">${MAX_PHOTOS} tagacha. Birinchisi — asosiy (Telegram va ro'yxatda). Rasm ustiga bosilsa — to'liq ekranda ochiladi; «★ Asosiy qilish» — asosiy rasm qiladi.</div>`}
    </div>
    <div class="form-grid">
      ${field('Mahsulot *', 'name', p.name, 'required', 'full')}
      <label class="full">Artikul<span class="it-sw"><input name="code" value="${esc(p.code || '')}" autocomplete="off"><button type="button" class="it-scan code-scan" title="Shtrix-kodni skanerlab yozish" aria-label="Skaner">${icon('scan')}</button></span></label>
      ${sizeField(p.size, noSizeType(p.type))}
      ${selectField('Kategoriya', 'category', cats, p.category || '', '', 'id="catSel"')}
      <label>Turi<select name="type" id="typeSel">${typeOptions(p.category, p.type)}</select>
        <input name="typeNew" id="typeNew" placeholder="Yangi tur nomi" hidden></label>
      <label>Ishlab chiqaruvchi / ta'minotchi<select name="makerId" id="makerSel">${makerOptions(p)}</select>
        <input name="makerNew" id="makerNew" placeholder="Fabrika yoki ta'minotchi nomi" hidden></label>
      <div class="field full feat-wrap" id="featBlock">${featureBlock(p.category, p.type, p)}</div>
      ${field('Ishlab chiqarilgan joyi', 'origin', p.origin, 'placeholder="O\'zbekiston, Toshkent / Turkiya..."')}
      ${isAdmin() ? field('Minimal qoldiq', 'minQty', p.minQty ?? 1, 'type="number" inputmode="numeric" min="0"') : ''}
      <div class="field full price-block">
        <span class="field-label">Narxlar valyutasi</span>
        <div class="seg seg-sm" role="radiogroup">
          <label><input type="radio" name="priceCurrency" value="UZS" ${p.priceCurrency !== 'USD' ? 'checked' : ''}><span>So'm</span></label>
          <label><input type="radio" name="priceCurrency" value="USD" ${p.priceCurrency === 'USD' ? 'checked' : ''}><span>Dollar ($)</span></label>
        </div>
        <div class="price-grid">
          ${can('costs') ? moneyField('Kelish narxi', 'buyPrice', p.buyPrice ?? '', p.priceCurrency || 'UZS') : ''}
          ${moneyField('Sotish narxi (etiketka) *', 'salePrice', p.salePrice ?? '', p.priceCurrency || 'UZS', 'required')}
          ${moneyField('Eng kam narx (savdolashish chegarasi)', 'minPrice', p.minPrice ?? '', p.priceCurrency || 'UZS')}
        </div>
        <div class="price-preview muted small" id="pricePreview"></div>
      </div>
      ${p.id ? '' : `<div class="field full"><span class="field-label">Boshlang'ich qoldiq — har bir omborda nechta bor</span>
        <div class="wh-qty">${db.warehouses.map((w) => `<label>${esc(w.name)}<input type="number" min="0" step="1" name="initQty_${esc(w.id)}" value="0" inputmode="numeric"></label>`).join('')}</div></div>`}
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
  return [['', '—'], ...list, ...(can('products') ? [['__new', "+ Yangi ishlab chiqaruvchi..."]] : [])]
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
      <img ${ph.file ? `src="${ph.url}"` : `data-photo="${esc(i === 0 ? ph.path : ph.thumb)}"`} data-i="${i}" alt="" title="Kattalashtirish">
      ${i === 0 ? '<span class="ph-main">Asosiy</span>' : readonly ? '' : `<button type="button" class="ph-star" data-i="${i}" title="Asosiy rasm qilish">★ Asosiy qilish</button>`}
      ${readonly ? '' : `<button type="button" class="ph-del" data-i="${i}" title="O'chirish">×</button>`}
    </div>`).join('') : `<div class="photo-empty">${icon('camera')}<span>Rasm yo'q</span></div>`;
  hydratePhotos(box);
}

// O'lcham uch katakda: raqamdan keyin probel (yoki x, *, vergul, Enter) — keyingi katakka o'tadi
const DIM_NAMES = ['Uzunlik', 'Kenglik', 'Balandlik'];

// Stul va kreslolarda o'lcham so'ralmaydi
const noSizeType = (type) => /stul|kreslo/i.test(type || '');

function sizeField(size, hidden = false) {
  const parts = String(size || '').split(/[x×х*,\s]+/i).filter(Boolean);
  return `<label class="wide2" id="sizeLbl" ${hidden ? 'hidden' : ''}>O'lchami (sm): uzunlik × kenglik × balandlik
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

// --- Kategoriya ikonkalari ---
// Tanlab olinadigan mebel ikonkalari (Sozlamalar → Ro'yxatlar)
const FURNITURE_ICONS = ['bed', 'sofa', 'armchair', 'pouf', 'kitchen', 'dining', 'table', 'chair', 'officeChair', 'desk', 'wardrobe', 'dresser', 'bookshelf', 'tvStand', 'mirror', 'crib', 'mattress', 'lamp', 'safe', 'box'];
// Nomidagi so'z bo'yicha o'zi tanlanadi (birinchi mos kelgani); o'zgartirilgani db.categoryIcons da
const ICON_RULES = [
  [/komplekt/i, 'dining'],
  [/ofis kreslo|rahbar kreslo|kompyuter kreslo|ofis stul/i, 'officeChair'],
  [/yotoq|karavot/i, 'bed'], [/beshik|bolalar/i, 'crib'], [/matras|topper/i, 'mattress'],
  [/oshxona garnitur|oshxona$/i, 'kitchen'], [/divan/i, 'sofa'], [/kreslo/i, 'armchair'], [/puf/i, 'pouf'],
  [/stol va stul|stol-stul|to'plam.*stul/i, 'dining'], [/stul/i, 'chair'],
  [/ofis|yozuv stol|kompyuter stol|xodim stol|rahbar stol|resepshn/i, 'desk'], [/stol/i, 'table'],
  [/shkaf|garderob/i, 'wardrobe'], [/kitob|javon|vitrina/i, 'bookshelf'], [/komod|tumb|tumba/i, 'dresser'],
  [/tv|mehmonxona/i, 'tvStand'], [/trelyaj|oyna|ko'zgu|dahliz/i, 'mirror'], [/chiroq|lampa|lyustra/i, 'lamp'], [/seyf/i, 'safe'],
];
const guessIcon = (name) => ICON_RULES.find(([re]) => re.test(name || ''))?.[1] || '';
const categoryIcon = (cat) => db.categoryIcons?.[cat] || guessIcon(cat) || 'box';
const typeIcon = (cat, type) => guessIcon(type) || categoryIcon(cat);
const productIcon = (p) => (p.type ? typeIcon(p.category, p.type) : categoryIcon(p.category));

// Ro'yxatlar ustidagi kategoriya tugmalari (ikonka + nomi + soni)
function categoryBar(filterKey, list) {
  const cur = filterVal(filterKey);
  const counts = list.reduce((m, p) => m.set(p.category || '', (m.get(p.category || '') || 0) + 1), new Map());
  const btn = (v, label, ic, n) => `<button type="button" class="cat-chip ${v === cur ? 'on' : ''}" data-act="catFilter" data-f="${filterKey}" data-v="${esc(v)}">${icon(ic)}<span>${esc(label)}</span>${n != null ? `<small>${n}</small>` : ''}</button>`;
  return `<div class="cat-bar">${btn('', 'Hammasi', 'dashboard', list.length)}${db.categories.map((c) => btn(c, c, categoryIcon(c), counts.get(c) || 0)).join('')}</div>`;
}

function typeBar(filterKey, cat, list) {
  const cur = filterVal(filterKey);
  const types = uniqNames([...(db.categoryTypes[cat] || []), ...list.map((p) => p.type)]);
  const n = (t) => list.filter((p) => nameKey(p.type) === nameKey(t)).length;
  const btn = (v, label, ic, k) => `<button type="button" class="cat-chip sm ${v === cur ? 'on' : ''}" data-act="catFilter" data-f="${filterKey}" data-v="${esc(v)}">${icon(ic)}<span>${esc(label)}</span><small>${k}</small></button>`;
  return `<div class="cat-bar type-bar">${btn('', 'Barcha turlar', categoryIcon(cat), list.length)}${types.map((t) => btn(t, t, typeIcon(cat, t), n(t))).join('')}</div>`;
}

// --- Kategoriyaga xos xususiyatlar ---
const featureSetFor = (cat, type) => (db.featureSets || []).find((f) => (f.applies || []).some((a) => a === cat || (type && a === `${cat} › ${type}`)));
const productAttrs = (p) => Object.entries(p.attrs || {}).filter(([, v]) => v);
const attrsText = (p, sep = ' · ') => productAttrs(p).map(([k, v]) => `${k}: ${v}`).join(sep);

// Bitta tanlanadigan tugmachalar (krestovina, mexanizm...)
function chipOne(name, options, value, ctl = false) {
  const all = [...options, ...(value && !options.includes(value) ? [value] : [])];
  return `<div class="field full"><span class="field-label">${esc(name)}</span>
    <div class="chips chips-pick chips-one" ${ctl ? 'data-ctl="1"' : ''}>
      ${all.map((m) => `<button type="button" class="chip ${m === value ? 'on' : ''}" data-act="chipOne" data-v="${esc(m)}">${esc(m)}</button>`).join('')}
      ${can('products') ? `<input class="chip-add" placeholder="+ Boshqa" enterkeyhint="done">` : ''}
    </div>
    <input type="hidden" name="attr:${esc(name)}" value="${esc(value || '')}"></div>`;
}

// Rang va qo'shimcha maydonlar: kategoriya/tur o'zgarganda o'zi almashadi
// Ranglar ro'yxati: material (yoki boshqa bog'langan maydon) tanlangan bo'lsa — o'sha materialniki
function colorsFor(set, attrs = {}) {
  if (!set) return db.colors;
  const v = set.colorField ? attrs[set.colorField] : '';
  return (v && set.colorsBy?.[v]) || set.colors || [];
}

function featureBlock(cat, type, p = {}) {
  const set = featureSetFor(cat, type);
  const colorBox = (colors, label, note = '') => `<div class="field full"><span class="field-label">${label}</span>
    ${note ? `<div class="muted small feat-note">${note}</div>` : chipPicker('colorChips', colors, p.color, '+ Yangi rang')}
    <input type="hidden" name="color" value="${esc(p.color || '')}"></div>`;
  if (!set) {
    const own = db.categoryColors?.[cat] || [];
    return `<div class="form-grid">${colorBox(own.length ? own : db.colors, 'Rangi')}</div>`;
  }
  const fields = set.fields || [];
  const ctl = fields.find((f) => f.name === set.colorField);
  const ctlVal = ctl ? p.attrs?.[ctl.name] || '' : '';
  const tag = ` <span class="feat-tag">${esc(set.name)}</span>`;
  // Avval material, keyin uning ranglari, so'ng qolgan maydonlar
  const color = ctl && !ctlVal && !p.color
    ? colorBox([], 'Rangi' + tag, `Avval «${esc(ctl.name)}» ni tanlang — ranglar shunga qarab chiqadi.`)
    : colorBox(colorsFor(set, p.attrs), (ctlVal ? `Rangi — ${esc(ctlVal)}` : 'Rangi') + tag);
  return `<div class="form-grid">
    ${ctl ? chipOne(ctl.name, ctl.options || [], ctlVal, true) : ''}
    ${color}
    ${fields.filter((f) => f !== ctl).map((f) => chipOne(f.name, f.options || [], p.attrs?.[f.name] || '')).join('')}
  </div>`;
}

// Material almashtirilsa — ranglar o'sha materialniki bo'ladi (yangi ro'yxatda yo'q rang olib tashlanadi)
function refreshFeatures() {
  const box = $('#featBlock');
  if (!box) return;
  const cat = $('#catSel').value;
  const type = $('#typeSel').value;
  const draft = readFeatureDraft();
  const list = colorsFor(featureSetFor(cat, type), draft.attrs);
  draft.color = splitList(draft.color).filter((c) => list.includes(c)).join(', ');
  box.innerHTML = featureBlock(cat, type, draft);
}

// Kartochkada tanlanganlar (kategoriya almashtirilganda yo'qolmasligi uchun)
function readFeatureDraft() {
  const f = Object.fromEntries(new FormData($('#modalForm')).entries());
  const attrs = {};
  Object.entries(f).forEach(([k, v]) => { if (k.startsWith('attr:') && v) attrs[k.slice(5)] = v; });
  return { color: f.color, attrs };
}

// Turi — tanlangan kategoriyaning o'z turlari
// Nomlar katta-kichik harf va bo'shliqlardan qat'i nazar bir xil hisoblanadi («xontaxta» = «Xontaxta»)
const nameKey = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
const capFirst = (v) => { const t = String(v || '').trim().replace(/\s+/g, ' '); return t ? t[0].toLocaleUpperCase() + t.slice(1) : t; };
function uniqNames(list) {
  const seen = new Set();
  return list.filter((v) => { const k = nameKey(v); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}
// Kategoriya turlari: sozlamalardagi ro'yxat + mahsulotlarda ishlatilganlari (masalan, xodim qo'shgan tur)
const typesOf = (cat) => uniqNames([...(db.categoryTypes[cat] || []), ...db.products.filter((p) => p.category === cat).map((p) => p.type)]);
// Kategoriyalar: sozlamalardagi + mahsulotlarda ishlatilganlari (komplektlarsiz)
const categoriesAll = () => uniqNames([...db.categories, ...db.products.filter((p) => !isKit(p)).map((p) => p.category)]);

function typeOptions(cat, value) {
  const types = typesOf(cat);
  if (value && !types.some((t) => nameKey(t) === nameKey(value))) types.push(value);
  value = types.find((t) => nameKey(t) === nameKey(value)) || value;
  return [['', '—'], ...types.map((t) => [t, t]), ...(can('products') ? [['__new', '+ Yangi tur...']] : [])]
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
  const refresh = () => {
    const box = $('#featBlock');
    if (box) box.innerHTML = featureBlock(cat.value, type.value, readFeatureDraft());
  };
  cat.addEventListener('change', () => {
    type.innerHTML = typeOptions(cat.value, ''); toggle(); refresh();
    // Kategoriya tanlanishi bilan turlar ro'yxati o'zi ochiladi
    if (cat.value && [...type.options].some((o) => o.value && o.value !== '__new')) {
      setTimeout(() => {
        if (isTouch()) openSelectSheet(type);
        else { type.focus(); try { type.showPicker?.(); } catch (e) { /* brauzer ruxsat bermadi */ } }
      }, 150);
    }
  });
  type.addEventListener('change', () => { toggle(); refresh(); });
}

// Tanlash tugmachalari (rang): bir nechtasini belgilash mumkin, "Dub beliy, Oq gladkiy" ko'rinishida saqlanadi
const splitList = (str) => String(str || '').split(',').map((x) => x.trim()).filter(Boolean);

function chipPicker(id, options, value, addLabel) {
  const selected = splitList(value);
  const all = [...options, ...selected.filter((m) => !options.includes(m))];
  return `<div class="chips chips-pick" id="${id}">
    ${all.map((m) => `<button type="button" class="chip ${selected.includes(m) ? 'on' : ''}" data-act="chipToggle" data-v="${esc(m)}">${esc(m)}</button>`).join('')}
    ${can('products') ? `<input class="chip-add" placeholder="${addLabel}" enterkeyhint="done">` : ''}
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
  $('#typeSel')?.addEventListener('change', (e) => { const l = $('#sizeLbl'); if (l) l.hidden = noSizeType(e.target.value); });
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
    const star = e.target.closest('.ph-star');
    const img = e.target.closest('img[data-i]');
    if (del) {
      if (!confirm("Rasm o'chirilsinmi?\n\n(Kartochka saqlangandan keyin o'chadi — «Yopish» bosilsa, rasm joyida qoladi.)")) return;
      const [ph] = photoEdit.items.splice(+del.dataset.i, 1);
      if (ph.file) URL.revokeObjectURL(ph.url);
      else photoEdit.removed.push(ph.path, ph.thumb);
    } else if (star) {
      const [ph] = photoEdit.items.splice(+star.dataset.i, 1);
      photoEdit.items.unshift(ph);
    } else if (img) {
      return openLightbox(photoEdit.items, +img.dataset.i);
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

// ---------- Rasmni to'liq ekranda ko'rish ----------
// Barmoq bilan chapga/o'ngga surib almashtiriladi, ikki marta bosilsa (yoki 🔍) kattalashadi.
function openLightbox(items, start = 0) {
  const list = (items || []).filter((ph) => ph && (ph.path || ph.url));
  if (!list.length) return;
  let i = Math.min(Math.max(0, start), list.length - 1);
  let lb = $('#lightbox');
  if (!lb) {
    lb = document.createElement('dialog');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `<div class="lb-stage"><img class="lb-img" alt=""></div>
      <div class="lb-top"><span class="lb-count"></span><span class="lb-gap"></span>
        <button type="button" class="lb-btn lb-zoom" title="Kattalashtirish">🔍</button>
        <button type="button" class="lb-btn lb-close" title="Yopish">×</button></div>
      <button type="button" class="lb-btn lb-nav lb-prev" title="Oldingi">‹</button>
      <button type="button" class="lb-btn lb-nav lb-next" title="Keyingi">›</button>
      <div class="lb-loading">Yuklanmoqda...</div>`;
    document.body.appendChild(lb);
  }
  const img = $('.lb-img', lb);
  const stage = $('.lb-stage', lb);
  const setZoom = (on, cx, cy) => {
    lb.classList.toggle('zoomed', on);
    if (on && cx != null) {
      // Bosilgan joy markazga kelsin
      requestAnimationFrame(() => {
        stage.scrollLeft = cx * img.offsetWidth - stage.clientWidth / 2;
        stage.scrollTop = cy * img.offsetHeight - stage.clientHeight / 2;
      });
    }
  };
  const show = async () => {
    setZoom(false);
    const ph = list[i];
    $('.lb-count', lb).textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    $('.lb-prev', lb).hidden = $('.lb-next', lb).hidden = list.length < 2;
    lb.classList.add('loading');
    img.removeAttribute('src');
    const url = ph.url || await backend.photoUrl(ph.path).catch(() => null) || (ph.thumb && await backend.photoUrl(ph.thumb).catch(() => null));
    if (list[i] !== ph) return;
    if (url) img.src = url;
    img.onload = img.onerror = () => lb.classList.remove('loading');
  };
  const go = (d) => { i = (i + d + list.length) % list.length; show(); };
  lb.onclick = (e) => {
    if (e.target.closest('.lb-close')) return lb.close();
    if (e.target.closest('.lb-prev')) return go(-1);
    if (e.target.closest('.lb-next')) return go(1);
    if (e.target.closest('.lb-zoom')) return setZoom(!lb.classList.contains('zoomed'), 0.5, 0.5);
    if (e.target === stage && !lb.classList.contains('zoomed')) lb.close(); // rasm atrofidagi bo'sh joy
  };
  img.ondblclick = (e) => {
    const r = img.getBoundingClientRect();
    setZoom(!lb.classList.contains('zoomed'), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  // Telefonda: surish — boshqa rasm, ikki marta tegish — kattalashtirish
  let t0 = null;
  let lastTap = 0;
  stage.ontouchstart = (e) => { t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() } : null; };
  stage.ontouchend = (e) => {
    if (!t0) return;
    const tch = e.changedTouches[0];
    const dx = tch.clientX - t0.x;
    const dy = tch.clientY - t0.y;
    if (!lb.classList.contains('zoomed') && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { go(dx < 0 ? 1 : -1); t0 = null; return; }
    if (!lb.classList.contains('zoomed') && dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) { lb.close(); t0 = null; return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && e.target === img) {
      const now = Date.now();
      if (now - lastTap < 320) {
        e.preventDefault();
        const r = img.getBoundingClientRect();
        setZoom(!lb.classList.contains('zoomed'), (tch.clientX - r.left) / r.width, (tch.clientY - r.top) / r.height);
        lastTap = 0;
      } else lastTap = now;
    }
    t0 = null;
  };
  lb.onkeydown = (e) => {
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  if (!lb.open) lb.showModal();
  $('.lb-close', lb).focus();
  show();
}

async function hydratePhotos(root = document) {
  for (const img of $$('img[data-photo]', root)) {
    const path = img.dataset.photo;
    img.removeAttribute('data-photo');
    backend.photoUrl(path).then((u) => { if (u) img.src = u; }).catch(() => {});
  }
}

function readProduct(d, p) {
  let type = d.type === '__new' ? capFirst(d.typeNew) : d.type;
  // Bor tur boshqacha yozilgan bo'lsa (xontaxta / Xontaxta) — ro'yxatdagi yozilishi olinadi
  type = typesOf(d.category).find((t) => nameKey(t) === nameKey(type)) || type;
  // Yangi tur va materiallar keyingi safar ro'yxatda tursin
  if (type && d.category) {
    const list = (db.categoryTypes[d.category] = db.categoryTypes[d.category] || []);
    if (!list.some((t) => nameKey(t) === nameKey(type))) list.push(type);
  }
  // Yangi ranglar va xususiyat qiymatlari keyingi safar ro'yxatda tursin
  const set = featureSetFor(d.category, type);
  const ctlVal = set?.colorField ? (d['attr:' + set.colorField] || '').trim() : '';
  const colorList = !set ? db.colors
    : ctlVal ? ((set.colorsBy = set.colorsBy || {})[ctlVal] = set.colorsBy[ctlVal] || [])
    : (set.colors = set.colors || []);
  splitList(d.color).forEach((c) => { if (!colorList.includes(c)) colorList.push(c); });
  const attrs = {};
  if (set) {
    (set.fields || []).forEach((f) => {
      const v = (d['attr:' + f.name] || '').trim();
      if (!v) return;
      attrs[f.name] = v;
      f.options = f.options || [];
      if (!f.options.includes(v)) f.options.push(v);
    });
  }
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
    attrs,
    origin: d.origin.trim(),
    supplierId: supplierId || '',
    maker,
    unit: p.unit || 'dona', // hamma mahsulot donada
    priceCurrency: d.priceCurrency === 'USD' ? 'USD' : 'UZS',
    // Sotuvchi kelish narxini ko'rmaydi — uning formasida bu maydon yo'q
    buyPrice: d.buyPrice !== undefined ? num(d.buyPrice) : p.buyPrice || 0,
    salePrice: num(d.salePrice),
    minPrice: num(d.minPrice),
    // Minimal qoldiqni faqat administrator kiritadi
    minQty: d.minQty !== undefined ? num(d.minQty) : p.minQty ?? 1,
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
  if (!canAddProducts()) return alert("Mahsulot qo'shish uchun ruxsatingiz yo'q.");
  openModal({
    title: 'Yangi mahsulot',
    body: productForm(),
    wide: true,
    onOpen: () => bindProductForm({}),
    onSubmit: (d) => (!tgAnswered(d) ? false : withPhotos(async (photos) => {
      const p = readProduct(d, { id: uid(), created: today(), photos });
      db.products.push(p);
      // Har bir ombor uchun alohida kirim hujjati
      for (const w of db.warehouses) {
        const qty = Math.max(0, Math.floor(num(d[`initQty_${w.id}`])));
        if (!qty) continue;
        db.docs.push({
          id: uid(), type: 'enter', no: await nextNo('enter'), date: today(), warehouseId: w.id, userId: me.id,
          items: [{ productId: p.id, qty, price: p.buyPrice }], note: "Boshlang'ich qoldiq",
          currency: p.priceCurrency, rate: p.priceCurrency === 'USD' ? usdRate() : undefined,
        });
      }
      await save();
      if (d.tgPost === 'yes') telegramPostProducts([p.id], true);
    })),
  });
}

function editProduct(id) {
  const p = product(id);
  if (isKit(p)) return editKit(id);
  if (!can('products')) {
    // Mahsulot ruxsati yo'q — kartochkani faqat ko'radi
    openModal({ title: p.name, body: `<fieldset disabled>${productForm(p, true)}</fieldset>`, wide: true, onOpen: () => bindProductForm(p, true), extra: [{ label: 'Etiketka', onClick: () => quickLabel(id) }] });
    return;
  }
  openModal({
    title: 'Mahsulot kartochkasi',
    body: productForm(p),
    wide: true,
    onOpen: () => bindProductForm(p),
    extra: [
      { label: 'Etiketka', onClick: () => quickLabel(id) },
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

// --- Komplekt kartochkasi ---
const KIT_CATEGORY = 'Komplektlar';

function kitPartRow(c = {}) {
  const p = product(c.productId);
  return `<tr>
    <td class="it-pick"><input type="hidden" class="it-product" value="${esc(p ? p.id : '')}">
      <div class="it-sw"><input class="it-search" autocomplete="off" placeholder="Artikul yoki nomi — yoki tanlang" value="${esc(productLabel(p))}"><button type="button" class="it-scan" title="Shtrix-kod / QR skaner" aria-label="Skaner">${icon('scan')}</button></div>
      <div class="it-path muted small">${p ? esc(productPath(p)) : ''}</div></td>
    <td>${qtyStepper('kit-qty', c.qty || 1)}</td>
    <td class="kit-line num muted"></td>
    <td><button type="button" class="small danger kit-del" title="O'chirish">×</button></td>
  </tr>`;
}

function kitForm(k = {}) {
  const parts = k.kit?.length ? k.kit : [{}, {}];
  return `<div class="form-grid">
      ${field('Komplekt nomi *', 'name', k.name, 'required placeholder="Masalan: Yotoqxona to\'plami «Milano»"', 'full')}
      ${field('Artikul', 'code', k.code)}
      ${selectField('Kategoriya', 'category', [[KIT_CATEGORY, KIT_CATEGORY], ...db.categories.filter((c) => c !== KIT_CATEGORY).map((c) => [c, c])], k.category || KIT_CATEGORY)}
    </div>
    <h4 class="kit-h">Tarkibi</h4>
    <div class="table-wrap"><table class="kit-table"><thead><tr><th>Mahsulot</th><th class="num">Soni</th><th class="num">Narxi</th><th></th></tr></thead>
      <tbody id="kitRows">${parts.map(kitPartRow).join('')}</tbody></table></div>
    <button type="button" class="small" id="kitAdd">${icon('plus')}Mahsulot qo'shish</button>
    <p class="muted small" id="kitInfo"></p>
    <div class="form-grid">
      ${moneyField('Komplekt narxi *', 'salePrice', k.salePrice ?? '', 'UZS', 'required')}
      ${moneyField('Eng kam narx', 'minPrice', k.minPrice ?? '', 'UZS')}
      ${textArea('Izoh', 'note', k.note)}
    </div>`;
}

function readKitParts() {
  const parts = [];
  for (const tr of $$('#kitRows tr')) {
    const p = product($('.it-product', tr).value);
    if (!p || isKit(p)) continue;
    const qty = Math.max(1, Math.round(num($('.kit-qty', tr).value)));
    const same = parts.find((c) => c.productId === p.id);
    if (same) same.qty += qty; else parts.push({ productId: p.id, qty });
  }
  return { parts };
}

function bindKitForm(k) {
  pickKits = false; // komplekt ichiga komplekt qo'shilmaydi
  const rows = $('#kitRows');
  const price = $('#modalBody [name=salePrice]');
  let touched = !!k.salePrice;
  price.addEventListener('input', () => { touched = true; });
  const refresh = () => {
    const { parts = [] } = readKitParts();
    $$('#kitRows tr').forEach((tr) => {
      const p = product($('.it-product', tr).value);
      $('.kit-line', tr).textContent = p ? money(salePriceUZS(p) * Math.max(1, num($('.kit-qty', tr).value))) : '';
    });
    const sum = parts.reduce((s, c) => s + salePriceUZS(product(c.productId)) * c.qty, 0);
    const avail = parts.length ? Math.min(...parts.map((c) => Math.floor(qtyIn(ctx.stock, c.productId) / c.qty))) : 0;
    $('#kitInfo').innerHTML = parts.length
      ? `Alohida sotilsa: <b>${money(sum)}</b> · Omborda yig'ish mumkin: <b>${Math.max(0, avail)} ta komplekt</b>`
      : 'Komplektga kiradigan mahsulotlarni qo\'shing (masalan: krovat va matras).';
    if (!touched && sum) { price.value = sum; formatMoneyInput(price); }
  };
  rows.addEventListener('input', refresh);
  rows.addEventListener('change', refresh);
  rows.addEventListener('click', (e) => {
    if (!e.target.closest('.kit-del')) return;
    const chosen = product($('.it-product', e.target.closest('tr')).value);
    if (chosen && !confirm(`«${chosen.name}» komplekt tarkibidan olib tashlansinmi?`)) return;
    e.target.closest('tr').remove();
    if (!rows.children.length) rows.insertAdjacentHTML('beforeend', kitPartRow());
    refresh();
  });
  $('#kitAdd').addEventListener('click', () => {
    rows.insertAdjacentHTML('beforeend', kitPartRow());
    $('#kitRows tr:last-child .it-search').focus();
  });
  refresh();
}

function editKit(id) {
  const k = id ? product(id) : null;
  if (!can('products')) {
    openModal({ title: k.name, body: `<fieldset disabled>${kitForm(k)}</fieldset>`, wide: true, onOpen: () => bindKitForm(k) });
    return;
  }
  const extra = k ? [{ label: 'Etiketka', onClick: () => quickLabel(id) }] : [];
  if (k && isAdmin()) extra.push({ label: "O'chirish", cls: 'danger', onClick: () => { closeModal(); deleteProduct(id); } });
  openModal({
    title: k ? `Komplekt: ${k.name}` : 'Yangi komplekt',
    body: kitForm(k || {}),
    wide: true,
    extra,
    onOpen: () => bindKitForm(k || {}),
    onSubmit: async (d) => {
      const { parts, error } = readKitParts();
      if (error) { alert(error); return false; }
      if (parts.length < 2 && !(parts.length === 1 && parts[0].qty > 1)) {
        alert("Komplektga kamida 2 ta mahsulot qo'shing.");
        return false;
      }
      if (!(num(d.salePrice) > 0)) { alert('Komplekt narxini kiriting.'); return false; }
      const code = d.code.trim();
      if (code && db.products.some((p) => p.code === code && p.id !== k?.id)) { alert(`«${code}» artikuli band.`); return false; }
      const target = k || { id: uid(), created: today(), photos: [], unit: 'komplekt' };
      Object.assign(target, {
        name: d.name.trim(), code, category: d.category || KIT_CATEGORY, type: '',
        priceCurrency: 'UZS', salePrice: num(d.salePrice), minPrice: num(d.minPrice), minQty: 0,
        note: d.note.trim(), kit: parts,
      });
      if (!k) db.products.push(target);
      if (target.category === KIT_CATEGORY && !db.categories.includes(KIT_CATEGORY)) db.categories.push(KIT_CATEGORY);
      await save();
    },
  });
}

function viewKits() {
  const q = filterVal('kits.q').toLowerCase();
  const list = db.products.filter((p) => isKit(p) && !p.archived && (!q || [p.name, p.code].join(' ').toLowerCase().includes(q)));
  const rows = list.map((k) => {
    const parts = kitParts(k);
    const sum = parts.reduce((s, c) => s + salePriceUZS(product(c.productId)) * c.qty, 0);
    const st = qtyIn(ctx.stock, k.id);
    return `<tr class="click" data-act="editProduct" data-id="${k.id}">
      <td><b>${esc(k.name)}</b>${k.code ? ` <span class="muted small">${esc(k.code)}</span>` : ''}
        <div class="kit-parts">${parts.map((c) => `<span>${esc(product(c.productId).name)}${c.qty > 1 ? ` × ${c.qty}` : ''}</span>`).join('')}</div></td>
      <td class="num">${money(k.salePrice)}${sum > k.salePrice ? `<div class="muted small">alohida: ${money(sum)}</div>` : ''}</td>
      <td class="num ${st ? '' : 'debt'}">${st}</td>
    </tr>`;
  }).join('');
  return toolbar('kits', { buttons: can('products') ? `<button class="primary" data-act="newKit">${icon('plus')}Komplekt</button>` : '' })
    + `<p class="muted small kit-hint">Komplekt sotilganda omborlardan uning tarkibidagi har bir mahsulot ayiriladi. «Mavjud» — omborda to'liq yig'ish mumkin bo'lgan komplektlar soni.</p>`
    + `<div class="card"><div class="table-wrap"><table><thead><tr><th>Komplekt va tarkibi</th><th class="num">Narxi</th><th class="num">Mavjud</th></tr></thead>
      <tbody>${rows || emptyRow(3, "Komplekt yo'q. Masalan: krovat + matras, stol + 4 ta stul, yotoqxona to'plami.")}</tbody></table></div></div>`;
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

// Qanday kontragent qo'sha oladi: savdo — mijoz, xarid — ta'minotchi
function partyKinds() {
  if (isAdmin()) return Object.entries(KINDS);
  return [...(can('sale') ? [['customer', KINDS.customer]] : []), ...(can('purchase') ? [['supplier', KINDS.supplier]] : [])];
}

function partyForm(c = {}) {
  return `<div class="form-grid">
    ${field('Nomi / F.I.O. *', 'name', c.name, 'required', 'full')}
    ${selectField('Turi', 'kind', partyKinds(), c.kind || partyKinds()[0][0])}
    ${phoneField('Telefon', 'phone', c.phone)}
    ${customerTypeField(c.ctype, 'Mijoz turi')}
    ${field('STIR (INN)', 'inn', c.inn)}
    ${field('Manzil', 'address', c.address, '', 'full')}
    ${textArea('Izoh', 'note', c.note)}
  </div>`;
}

// Qidiruvda raqam "90 111", "901112233" yoki "+998..." ko'rinishida yozilsa ham topiladi
const phoneMatch = (phone, q) => phoneDigits(q).length >= 3 && phoneDigits(phone).includes(phoneKey(q));

// Shu raqamli boshqa kontragent bormi
function phoneTaken(phone, exceptId) {
  const key = phoneKey(phone);
  return key.length === 9 && db.counterparties.find((c) => c.id !== exceptId && phoneKey(c.phone) === key);
}

function readParty(d, c) {
  if (fieldPhoneDigits(d.phone).length === 9) d.phone = fmtPhone(fieldPhoneDigits(d.phone));
  else if (phoneDigits(d.phone) === '998') d.phone = '';
  return Object.assign(c, { name: d.name.trim(), kind: d.kind, ctype: d.kind === 'supplier' ? '' : readCustomerType(d), phone: d.phone.trim(), inn: d.inn.trim(), address: d.address.trim(), note: d.note.trim() });
}

function newParty(kind) {
  openModal({
    title: 'Yangi kontragent',
    body: partyForm({ kind }),
    onSubmit: (d) => {
      const dup = phoneTaken(d.phone);
      if (dup && !confirm(`Bu raqam bilan kontragent allaqachon bor: ${dup.name}. Baribir yangisini qo'shilsinmi?`)) return false;
      db.counterparties.push(readParty(d, { id: uid(), created: today() }));
      save();
    },
  });
}

// Xodimlarga kontragentlarning to'liq ma'lumotlari (telefon, manzil, STIR, izoh, balans) ko'rsatilmaydi
const seesParties = () => isAdmin();
function maskPhone(ph) {
  const d = phoneKey(ph);
  return d ? `+998 •• ••• •• ${d.slice(-2)}` : '';
}

function editParty(id) {
  const c = party(id);
  if (!seesParties()) {
    openModal({ title: 'Kontragent', body: `<p><b>${esc(c.name)}</b></p><p class="muted">${esc(KINDS[c.kind] || '')}${c.phone ? ' · ' + maskPhone(c.phone) : ''}</p>
      <p class="muted small">To'liq ma'lumotlarni faqat administrator ko'radi.</p>` });
    return;
  }
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

const productLabel = (p) => (p ? p.name + (p.code ? ' · ' + p.code : '') : '');
const productPath = (p) => [p.category || 'Kategoriyasiz', p.type].filter(Boolean).join(' › ');

// Son kiritish: telefonda raqamli klaviatura va katta −/+ tugmalar
function qtyStepper(cls, value, min = 1) {
  return `<span class="qty-step"><button type="button" class="qs" data-d="-1" tabindex="-1" aria-label="Kamaytirish">−</button><input class="${cls}" type="number" inputmode="numeric" min="${min}" step="1" value="${value}"><button type="button" class="qs" data-d="1" tabindex="-1" aria-label="Ko'paytirish">+</button></span>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.qty-step .qs');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  if (input.disabled || input.closest('fieldset[disabled]')) return;
  const min = num(input.min) || 0;
  input.value = Math.max(min, Math.round(num(input.value)) + Number(b.dataset.d));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

// Sotuv va buyurtmada har bir qatorda «Chegirma (1 dona)» — sotish narxi = narx − chegirma
const rowDiscDoc = (t) => t === DOC_TYPES.sale || t === DOC_TYPES.order;

function itemRowHtml(t, it = {}, cur = 'UZS') {
  const p = product(it.productId);
  const rd = rowDiscDoc(t);
  const listPrice = rd && it.disc ? it.listPrice ?? it.price + it.disc : it.price;
  const kit = it.kitId ? ` data-kit-id="${esc(it.kitId)}" data-kit-name="${esc(it.kitName || '')}" data-kit-qty="${it.kitQty || ''}"` : '';
  return `<tr${kit}>
    <td class="it-pick"><input type="hidden" class="it-product" value="${esc(p ? p.id : '')}">
      <div class="it-sw"><input class="it-search" autocomplete="off" placeholder="Artikul yoki nomi — yoki tanlang" value="${esc(productLabel(p))}"><button type="button" class="it-scan" title="Shtrix-kod / QR skaner" aria-label="Skaner">${icon('scan')}</button></div>
      <div class="it-path muted small">${p ? esc(productPath(p)) : ''}${it.kitName ? ` · <b>Komplekt: ${esc(it.kitName)}</b>` : ''}</div></td>
    <td class="it-avail muted num"></td>
    <td>${qtyStepper('it-qty', it.qty || 1)}</td>
    <td><span class="money-wrap"><input class="it-price money" data-cur="${cur}" inputmode="decimal" value="${esc(fmtIn(listPrice ?? '', cur))}"><span class="cur">${CUR_SIGN[cur]}</span></span>
      ${rd ? `<label class="it-dl">Chegirma (1 dona)<span class="money-wrap"><input class="it-disc money" data-cur="${cur}" inputmode="numeric" placeholder="0" value="${esc(it.disc ? fmtIn(it.disc, cur) : '')}"><span class="cur">${CUR_SIGN[cur]}</span></span></label>` : ''}
      <div class="it-min muted small"></div></td>
    <td class="it-sum num"></td>
    <td><button type="button" class="small danger it-remove" title="O'chirish">×</button></td>
  </tr>`;
}

// Eng ko'p ruxsat etilgan chegirma: har bir mahsulot eng kam narxigacha (eng kam narx yo'q bo'lsa — tannarxigacha)
function maxDiscount(items) {
  return items.reduce((s, it) => {
    const p = product(it.productId);
    if (!p || !it.productId) return s;
    const floor = minPriceUZS(p) || Math.round(ctx.cost?.[p.id] || 0);
    return s + Math.max(0, (it.price - floor) * it.qty);
  }, 0);
}

// Chegirma maydoni: savdoda 1 dona uchun (discountK = mahsulotlar soni), xaridlarda — to'liq summa
const discountOf = (data) => num(data.discount) * (num(data.discountK) || 1);

// Kirim / hisobdan chiqarish / ko'chirishda narx — kelish narxi; tannarx ruxsati yo'q xodimga ko'rsatilmaydi
// (narxsiz qator tannarx hisobiga ta'sir qilmaydi)
const hidesCost = (t) => t.price === 'buy' && !t.money && !can('costs');

function docForm(type, d) {
  const t = DOC_TYPES[type];
  const isOrder = type === 'order';
  // Individual buyurtma va undan qilingan sotuv katalogdan tashqari qator bilan ishlaydi
  const custom = (isOrder || type === 'sale') && d.orderKind === 'custom';
  let head = '';
  // Yangi sotuvda: mijoz hozir xarid qildimi yoki buyurtma berdimi
  if (!d.id && (type === 'sale' || isOrder)) {
    head += `<div class="field full"><span class="field-label">Sotuv turi</span><div class="seg" role="radiogroup">
      <label><input type="radio" name="saleMode" value="sale" ${type === 'sale' ? 'checked' : ''}><span>${icon('bag')}Xarid qildi</span></label>
      <label><input type="radio" name="saleMode" value="order" ${isOrder ? 'checked' : ''}><span>${icon('clock')}Buyurtma berdi</span></label>
    </div></div>`;
  }
  // Savdoda mijoz va mahsulotlar eng tepada (mijoz shoshayotgan bo'lishi mumkin);
  // holati, yetkazish, sana va ombor — mahsulotlardan keyin
  const late = t.party === 'customer';
  let after = '';
  let tail = '';
  const dateF = field('Sana', 'date', d.date, 'type="date" required');
  if (late) tail += dateF; else head += dateF;
  if (t.party === 'customer') {
    // Mijoz: telefon → ism (ostida mos mijozlar ro'yxati) → mijoz turi.
    // Ism va telefon bo'sh qolsa — "Chakana xaridor".
    const cur = party(d.counterpartyId);
    const known = cur && cur.id !== 'retail' ? cur : null;
    const draft = d.draftParty || {};
    head += phoneField('Telefon raqami', 'partyPhone', known ? known.phone : draft.phone && phoneDigits(draft.phone) !== '998' ? draft.phone : '', 'id="partyPhone"');
    head += `<label class="party-name">Mijoz ismi
        <input name="partyName" id="partyName" autocomplete="off" placeholder="Ism familiya" value="${esc(known ? known.name : draft.name || '')}">
        <div class="party-suggest" id="partySuggest" hidden></div>
      </label>
      <input type="hidden" name="counterpartyId" id="partyId" value="${esc(known ? known.id : '')}">`;
    // Mijoz turi faqat administratorga ko'rinadi — sotuvchi oynasida yo'q (saqlangan turi o'zgarmaydi)
    if (isAdmin()) head += customerTypeField(known ? known.ctype : draft.ctype || '');
    head += `<div class="full party-hint" id="partyHint"></div>`;
  } else if (t.party) {
    // Telefon yozilsa — saqlangan mijoz avtomatik topiladi; topilmasa, yangi mijoz ismi so'raladi
    const who = t.party === 'supplier' ? "ta'minotchi" : 'mijoz';
    const cur = party(d.counterpartyId);
    head += phoneField('Telefon raqami', 'partyPhone', cur && cur.id !== 'retail' ? cur.phone : '', 'id="partyPhone"');
    head += selectField(t.party === 'supplier' ? "Ta'minotchi *" : 'Mijoz *', 'counterpartyId', [...partyOptions(t.party), ...(t.party === 'customer' || canAddParty() ? [['__new', `+ Yangi ${who}...`]] : [])], d.counterpartyId || (t.party === 'customer' ? 'retail' : ''), '', 'id="partySel"');
    head += `<label class="new-party" hidden>Yangi ${who} ismi *<input name="newPartyName" id="newPartyName" placeholder="Ism familiya" autocomplete="off"></label>`;
    head += `<div class="full party-hint" id="partyHint"></div>`;
  }
  const whF = selectField(t.move ? 'Qaysi ombordan' : 'Ombor', 'warehouseId', whOptions(), d.warehouseId || db.warehouses[0].id);
  // Ko'chirishdan boshqa hujjatlarda ombor mahsulotlardan keyin (odatda o'zgartirilmaydi)
  if (t.move) head += whF; else tail += whF;
  if (t.move) head += selectField('Qaysi omborga', 'toWarehouseId', whOptions(), d.toWarehouseId || (db.warehouses[1] || db.warehouses[0]).id);
  if (t.statuses) {
    const st = selectField('Holati', 'status', Object.entries(t.statuses), d.status || Object.keys(t.statuses)[0]);
    if (late) after += st; else head += st;
  }
  const cur = t.fx && d.currency === 'USD' ? 'USD' : 'UZS';
  if (t.fx) {
    head += `<div class="field"><span class="field-label">Valyuta</span><div class="seg seg-sm" role="radiogroup">
        <label><input type="radio" name="currency" value="UZS" ${cur === 'UZS' ? 'checked' : ''}><span>So'm</span></label>
        <label><input type="radio" name="currency" value="USD" ${cur === 'USD' ? 'checked' : ''}><span>Dollar ($)</span></label></div></div>
      <label id="rateField" ${cur === 'USD' ? '' : 'hidden'}>Kurs: 1 $ =<span class="money-wrap"><input name="rate" class="money" data-cur="USD" inputmode="decimal" value="${esc(fmtIn(d.rate || usdRate() || '', 'USD'))}"><span class="cur">so'm</span></span></label>`;
  }
  if (isOrder) {
    after = field('Bajarish muddati *', 'deliveryDate', d.deliveryDate, 'type="date" required') + after;
    const names = db.users.map((u) => u.name).filter(Boolean);
    after += `<label>Mas'ul xodim<input name="responsible" list="respList" autocomplete="off" placeholder="Kim bajaradi" value="${esc(d.responsible || '')}">
      <datalist id="respList">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>`;
    head += `<div class="field full"><span class="field-label">Buyurtma turi</span><div class="seg seg-sm" role="radiogroup">
      <label><input type="radio" name="orderKind" value="standard" ${custom ? '' : 'checked'}><span>Standart — mavjud tovarlardan</span></label>
      <label><input type="radio" name="orderKind" value="custom" ${custom ? 'checked' : ''}><span>Nostandart — individual buyurtma</span></label>
    </div></div>`;
    after += addressBlock(d, true, false);
  } else if (t.delivery) {
    const ab = addressBlock(d, !!(d.address || d.addr), true);
    if (late) after += ab; else head += ab;
  }

  let foot = '';
  if (t.money || type === 'order' || type === 'purchaseOrder') {
    if (t.fx) foot += moneyField('Chegirma', 'discount', d.discount || '', cur, 'placeholder="0"');
    // Savdoda chegirma 1 dona uchun yoziladi: jami chegirma = chegirma × hamma mahsulotlar soni
    else {
      const q0 = Math.max(1, d.orderKind === 'custom' ? num(d.cQty) : (d.items || []).reduce((s, it) => s + num(it.qty), 0));
      const per = d.discount ? Math.round(d.discount / q0) : '';
      // Mahsulot qatorlarida o'z chegirmasi bor — umumiy maydon faqat nostandart buyurtmada (yoki eski hujjatda) chiqadi
      const showDoc = !rowDiscDoc(t) || d.discount > 0 || d.orderKind === 'custom';
      foot += `<label id="docDiscWrap" ${showDoc ? '' : 'hidden'} data-legacy="${d.discount > 0 ? 1 : ''}">Chegirma (1 donaga)<span class="money-wrap"><input name="discount" class="money" data-cur="UZS" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(per ? fmtIn(per, 'UZS') : '')}"><span class="cur">so'm</span></span>
        <input type="hidden" name="discountK" value="${q0}"><span class="muted small disc-hint" id="discHint"></span></label>`;
    }
  }
  if (!d.id && t.pay) {
    foot += moneyField(isOrder ? "Oldindan to'lov (zaklad)" : t.pay === 'in' ? "Hozir to'landi" : "Hozir to'ladik", 'payNow', d.payNow ?? '', 'UZS', 'placeholder="0"');
    foot += selectField("To'lov usuli", 'payMethod', Object.entries(PAY_METHODS), 'cash');
    if (t.pay === 'in' && !d.id) foot += `<div class="full receipt-line" id="receiptLine" hidden></div>`;
  }
  if (type === 'sale') {
    // Qarzga sotuv: to'langan summa jamidan kam bo'lsa — qolgan summa, qaytarish sanasi va mas'ul
    const sellers = db.users.filter((u) => u.active !== false).map((u) => [u.name, u.name]);
    const resp = d.debtResponsible || me?.name || '';
    if (resp && !sellers.some(([v]) => v === resp)) sellers.unshift([resp, resp]);
    foot += `<div class="field full debt-block" id="debtBlock" hidden>
      <div class="debt-title">${icon('alert')} <span><b id="debtAmount"></b> qolyapti — qarzga yoziladi</span></div>
      <div class="form-grid">
        ${field('Qachon beradi *', 'debtDue', d.debtDue, 'type="date"')}
        ${selectField("Mas'ul sotuvchi", 'debtResponsible', sellers, resp)}
      </div>
    </div>`;
  }
  let noteHtml = textArea('Izoh', 'note', d.note);
  if (!d.id && t.tgAsk) noteHtml += tgQuestion();

  const stdItems = custom ? [] : d.items || [];
  const items = (stdItems.length ? stdItems : [{}]).map((it) => itemRowHtml(t, it, cur)).join('');
  // Individual buyurtma — katalogda yo'q mebel: tavsifi, o'lchami, rangi va narxi yoziladi
  const ci = (custom && d.items && d.items[0]) || {};
  const customBlock = isOrder || custom ? `<div id="customBlock" ${custom ? '' : 'hidden'}>
      ${!isOrder ? '<input type="hidden" name="orderKind" value="custom">' : ''}
      <h4>Individual buyurtma</h4>
      <div class="form-grid">
        ${field('Buyurtma nomi *', 'cName', ci.name, 'placeholder="Masalan: Oshxona garnituri, 3.2 m"', 'full')}
        ${field("O'lchami (sm)", 'cSize', ci.size, 'placeholder="320 × 60 × 220"')}
        ${field('Rangi', 'cColor', ci.color, 'placeholder="Oq gladkiy / Dub votan"')}
        ${field('Soni', 'cQty', ci.qty || 1, 'type="number" inputmode="numeric" min="1"')}
        ${moneyField('Narxi (donasi)', 'cPrice', ci.price ?? '', 'UZS')}
        ${textArea('Tavsifi: material, furnitura, qo\'shimcha talablar', 'cSpec', ci.spec)}
      </div>
    </div>` : '';
  return `<div class="form-grid">${head}</div>
    ${customBlock}
    <div id="stdBlock" class="${hidesCost(t) ? 'no-cost' : ''}" ${custom ? 'hidden' : ''}>
    <h4>Mahsulotlar</h4>
    <div class="table-wrap"><table class="items-table doc-items">
      <thead><tr><th>Mahsulot</th><th class="num">Omborda</th><th>Soni</th><th>Narxi</th><th class="num">Summa</th><th></th></tr></thead>
      <tbody id="itemRows">${items}</tbody>
    </table></div>
    <button type="button" class="small" id="addItemRow">${icon('plus')}Qator qo'shish</button>
    </div>
    ${moneyBox(foot, d, t, late)}
    <div class="form-grid" style="margin-top:12px">${after}${tail}${noteHtml}</div>
    ${late ? '' : totalLine(d, t)}`;
}

// Jami: mahsulotlar summasi, chegirma (ayriladi) va to'lanadigan summa
const totalLine = (d, t) => `<div class="total-line" id="totalLine" data-paid="${prevPaid(d)}" ${hidesCost(t) ? 'hidden' : ''}>
    <span id="docBreak" class="muted"></span>Jami: <b id="docTotal">0</b><span id="docRest"></span></div>`;

// Savdoda pul bilan bog'liq hamma narsa (chegirma, jami, to'lov, qarz) mahsulotlardan keyin bitta blokda
function moneyBox(foot, d, t, late) {
  if (!late) return `<div class="form-grid" style="margin-top:12px">${foot}</div>`;
  return `<div class="money-box"><h4>${icon('wallet')}To'lov</h4>${totalLine(d, t)}<div class="form-grid">${foot}</div></div>`;
}

function bindPartyLookup(kind) {
  const phone = $('#partyPhone');
  const sel = $('#partySel');
  const nameField = $('#newPartyName').closest('label');
  const hint = $('#partyHint');
  const list = () => db.counterparties.filter((c) => c.id !== 'retail' && (c.kind === kind || c.kind === 'both'));
  const pick = (c) => {
    sel.value = c.id;
    phone.value = c.phone || '';
    if (c.phone) formatPhoneInput(phone);
    nameField.hidden = true;
    hint.innerHTML = `<span class="ok">${icon('check')} Topildi: <b>${esc(c.name)}</b>${c.address ? ` · ${esc(c.address)}` : ''}</span>`;
  };
  const lookup = () => {
    const key = fieldPhoneDigits(phone.value);
    nameField.hidden = true;
    if (key.length < 3) { hint.innerHTML = ''; return; }
    const found = list().filter((c) => phoneKey(c.phone).includes(key));
    if (key.length === 9) {
      const exact = found.find((c) => phoneKey(c.phone) === key);
      if (exact) return pick(exact);
      // Yangi raqam — yangi mijoz (ta'minotchi qo'shishga ruxsat bo'lmasa — faqat xabar)
      if (![...sel.options].some((o) => o.value === '__new')) { hint.innerHTML = `<span class="muted">Bu raqam bilan ${kind === 'supplier' ? "ta'minotchi" : 'mijoz'} topilmadi.</span>`; return; }
      sel.value = '__new';
      nameField.hidden = false;
      hint.innerHTML = `<span class="muted">Bu raqam bilan ${kind === 'supplier' ? "ta'minotchi" : 'mijoz'} topilmadi — ismini yozing, saqlanganda yangi ${kind === 'supplier' ? "ta'minotchi" : 'mijoz'} qo'shiladi.</span>`;
      return;
    }
    hint.innerHTML = found.length
      ? found.slice(0, 6).map((c) => `<button type="button" class="chip party-pick" data-id="${c.id}">${esc(c.name)} · ${esc(c.phone)}</button>`).join('')
      : '<span class="muted">Mos keladigan raqam yo\'q</span>';
  };
  phone.addEventListener('input', lookup);
  hint.addEventListener('click', (e) => {
    const b = e.target.closest('.party-pick');
    if (b) pick(party(b.dataset.id));
  });
  sel.addEventListener('change', () => {
    const c = party(sel.value);
    nameField.hidden = sel.value !== '__new';
    if (c && c.id !== 'retail') pick(c);
    else if (sel.value === '__new') { hint.innerHTML = ''; $('#newPartyName').focus(); }
    else { phone.value = ''; hint.innerHTML = ''; }
  });
  if (party(sel.value) && sel.value !== 'retail') pick(party(sel.value));
}

function customerTypeField(value, label = 'Mijoz turi') {
  const types = db.customerTypes.slice();
  if (value && !types.includes(value)) types.push(value);
  const cur = value || types[0] || '';
  return `<label>${label}<select name="customerType" class="ctype-sel">${[...types.map((x) => [x, x]), ['__new', '+ Yangi tur...']]
    .map(([v, x]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
    <input name="ctypeNew" class="ctype-new" placeholder="Yangi mijoz turi" hidden></label>`;
}

// "+ Yangi tur..." tanlansa — nom yoziladigan katak chiqadi
document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('ctype-sel')) return;
  const fresh = e.target.parentElement.querySelector('.ctype-new');
  fresh.hidden = e.target.value !== '__new';
  if (!fresh.hidden) fresh.focus();
});

function readCustomerType(d) {
  const v = d.customerType === '__new' ? (d.ctypeNew || '').trim() : d.customerType;
  if (v && !db.customerTypes.includes(v)) db.customerTypes.push(v);
  return v || '';
}

// ---------- Yetkazish manzili ----------
const regionOf = (name) => db.regions.find((r) => r.name === name);
const placeOf = (region, name) => regionOf(region)?.places.find((p) => p.name === name);
const optList = (names, value, newLabel) => [...names.map((n) => [n, n]), ['__new', newLabel]]
  .map(([v, x]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(x)}</option>`).join('');

// withDate — sotuvda yetkazish sanasi ham shu blok ichida (buyurtmada u "Bajarish muddati")
function addressBlock(d, enabled, withDate) {
  const a = d.addr || {};
  const region = a.region || db.regions[0]?.name || '';
  const place = a.place || regionOf(region)?.places[0]?.name || '';
  return `<div class="field full addr-block" id="addrBlock">
    ${withDate ? `<label class="check-line"><input type="checkbox" name="needDelivery" id="needDelivery" ${enabled ? 'checked' : ''}> ${icon('truck')} Yetkazib beriladi</label>` : `<input type="hidden" name="needDelivery" value="on"><span class="field-label">${icon('truck')} Yetkazish manzili</span>`}
    <div class="addr-grid" id="addrGrid" ${enabled ? '' : 'hidden'}>
      <label>Viloyat<select name="aRegion" id="aRegion">${optList(db.regions.map((r) => r.name), region, '+ Yangi viloyat...')}</select>
        <input name="aRegionNew" class="addr-new" placeholder="Viloyat nomi" hidden></label>
      <label>Shahar / tuman<select name="aPlace" id="aPlace">${optList((regionOf(region)?.places || []).map((x) => x.name), place, '+ Yangi shahar/tuman...')}</select>
        <input name="aPlaceNew" class="addr-new" placeholder="Shahar yoki tuman nomi" hidden></label>
      <label>Mahalla / joy<input name="aSpot" id="aSpot" list="aSpotList" autocomplete="off" placeholder="Masalan: Joydam" value="${esc(a.spot || '')}">
        <datalist id="aSpotList">${(placeOf(region, place)?.spots || []).map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
      ${withDate ? field('Yetkazish sanasi', 'deliveryDate', d.deliveryDate, 'type="date"') : ''}
      ${withDate && (db.drivers || []).length ? `<label>Shofyor (Telegramga yuboriladi)<select name="driverId"><option value="">— o'zi olib ketadi / tanlanmagan —</option>${db.drivers.map((x) => `<option value="${esc(x.id)}" ${x.id === d.driverId ? 'selected' : ''}>${esc(x.name)}${driverChat(x.id) ? '' : ' (Telegram ulanmagan)'}</option>`).join('')}</select></label>` : ''}
      ${field("Aniq manzil: ko'cha, uy, mo'ljal", 'aDetail', a.detail ?? (d.addr ? '' : d.address || ''), 'placeholder="Mustaqillik ko\'chasi 12, maktab yonida"', 'full')}
    </div>
  </div>`;
}

function bindAddressBlock() {
  const region = $('#aRegion');
  if (!region) return;
  const place = $('#aPlace');
  const spots = () => {
    $('#aSpotList').innerHTML = (placeOf(region.value, place.value)?.spots || []).map((x) => `<option value="${esc(x)}">`).join('');
  };
  const toggleNew = (sel) => {
    const input = sel.parentElement.querySelector('.addr-new');
    input.hidden = sel.value !== '__new';
    if (!input.hidden) input.focus();
  };
  region.addEventListener('change', () => {
    toggleNew(region);
    place.innerHTML = optList((regionOf(region.value)?.places || []).map((x) => x.name), regionOf(region.value)?.places[0]?.name, '+ Yangi shahar/tuman...');
    toggleNew(place);
    spots();
  });
  place.addEventListener('change', () => { toggleNew(place); spots(); });
  $('#needDelivery')?.addEventListener('change', (e) => {
    $('#addrGrid').hidden = !e.target.checked;
    // Sotuvda: yetkazilmasa (mijoz o'zi olib ketdi) — darhol «Yetkazildi», yetkazilsa — «Yetkazilishi kerak»
    const st = $('#modalBody [name=status]');
    if (st && st.querySelector('option[value=delivered]')) st.value = e.target.checked ? (st.value === 'delivered' ? 'pending' : st.value) : 'delivered';
  });
}

// Mijoz tanlanganda uning saqlangan manzili blokka qo'yiladi
function fillAddress(addr) {
  if (!addr || !$('#aRegion')) return;
  const region = $('#aRegion');
  if (![...region.options].some((o) => o.value === addr.region)) region.insertAdjacentHTML('afterbegin', `<option>${esc(addr.region)}</option>`);
  region.value = addr.region;
  region.dispatchEvent(new Event('change'));
  const place = $('#aPlace');
  if (addr.place && ![...place.options].some((o) => o.value === addr.place)) place.insertAdjacentHTML('afterbegin', `<option>${esc(addr.place)}</option>`);
  place.value = addr.place || place.value;
  place.dispatchEvent(new Event('change'));
  $('#modalBody [name=aSpot]').value = addr.spot || '';
  $('#modalBody [name=aDetail]').value = addr.detail || '';
}

// Formadagi manzilni o'qiydi; yangi viloyat/tuman/mahallani ro'yxatga qo'shadi
function readAddress(data) {
  if (!data.aRegion || !data.needDelivery) return null;
  const region = (data.aRegion === '__new' ? data.aRegionNew : data.aRegion || '').trim();
  const placeName = (data.aPlace === '__new' ? data.aPlaceNew : data.aPlace || '').trim();
  const spot = (data.aSpot || '').trim();
  const detail = (data.aDetail || '').trim();
  if (!region) return null;
  let r = regionOf(region);
  if (!r) { r = { name: region, places: [] }; db.regions.push(r); }
  if (placeName) {
    let pl = r.places.find((x) => x.name === placeName);
    if (!pl) { pl = { name: placeName, spots: [] }; r.places.push(pl); }
    if (spot && !pl.spots.includes(spot)) pl.spots.push(spot);
  }
  const addr = { region, place: placeName, spot, detail };
  return { addr, text: [region, placeName, spot, detail].filter(Boolean).join(', ') };
}

function bindCustomerLookup() {
  const phone = $('#partyPhone');
  const name = $('#partyName');
  const idInput = $('#partyId');
  const box = $('#partySuggest');
  const hint = $('#partyHint');
  const typeSel = $('#modalBody [name=customerType]');
  const customers = () => db.counterparties.filter((c) => c.id !== 'retail' && (c.kind === 'customer' || c.kind === 'both'));

  const status = () => {
    const c = party(idInput.value);
    if (c) hint.innerHTML = `<span class="ok">${icon('check')} Saqlangan mijoz: <b>${esc(c.name)}</b>${seesParties() && c.ctype ? ` · ${esc(c.ctype)}` : ''}${seesParties() && c.address ? ` · ${esc(c.address)}` : ''}</span>`;
    else if (name.value.trim()) hint.innerHTML = '<span class="muted">Yangi mijoz — saqlanganda bazaga qo\'shiladi.</span>';
    else if (fieldPhoneDigits(phone.value)) hint.innerHTML = '<span class="muted">Mijoz ismini yozing yoki ro\'yxatdan tanlang.</span>';
    else hint.innerHTML = '<span class="muted">Ism va telefon bo\'sh qolsa — Chakana xaridor.</span>';
  };

  const pick = (c) => {
    idInput.value = c.id;
    name.value = c.name;
    // Xodimga saqlangan mijozning telefoni ko'rsatilmaydi (o'zi yozgan raqam qoladi)
    if (seesParties()) {
      phone.value = c.phone || '';
      if (c.phone) formatPhoneInput(phone);
    }
    if (c.ctype && typeSel) {
      if (![...typeSel.options].some((o) => o.value === c.ctype)) typeSel.insertAdjacentHTML('afterbegin', `<option>${esc(c.ctype)}</option>`);
      typeSel.value = c.ctype;
    }
    if (c.addr) fillAddress(c.addr);
    box.hidden = true;
    status();
  };

  // Ro'yxat: telefon raqamining boshidan mos keladiganlar va/yoki ismida yozilgan so'z borlar
  const suggest = () => {
    const digits = fieldPhoneDigits(phone.value);
    const q = name.value.trim().toLowerCase();
    if (!digits && !q) { box.hidden = true; return; }
    const list = customers().filter((c) => (!digits || phoneKey(c.phone).startsWith(digits)) && (!q || c.name.toLowerCase().includes(q)));
    box.innerHTML = list.length
      ? list.slice(0, 8).map((c) => `<button type="button" class="suggest-row" data-id="${c.id}"><b>${esc(c.name)}</b>
          <span>${esc(seesParties() ? c.phone || '—' : maskPhone(c.phone) || '—')}${c.ctype && seesParties() ? ` · ${esc(c.ctype)}` : ''}</span></button>`).join('')
        + (list.length > 8 ? `<div class="suggest-more muted small">yana ${list.length - 8} ta — raqamni davom ettiring</div>` : '')
      : '<div class="suggest-more muted small">Mos mijoz yo\'q — yangi mijoz sifatida saqlanadi</div>';
    box.hidden = false;
  };

  phone.addEventListener('input', () => {
    const digits = fieldPhoneDigits(phone.value);
    const exact = digits.length === 9 && customers().find((c) => phoneKey(c.phone) === digits);
    if (exact) { pick(exact); return; }
    // Raqam o'zgarib, tanlangan mijozga mos kelmay qolsa — tanlov bekor
    const c = party(idInput.value);
    if (c && !phoneKey(c.phone).startsWith(digits)) idInput.value = '';
    suggest();
    status();
  });
  name.addEventListener('input', () => {
    idInput.value = '';
    suggest();
    status();
  });
  name.addEventListener('focus', suggest);
  box.addEventListener('mousedown', (e) => e.preventDefault()); // bosilganda ro'yxat yopilib qolmasin
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.suggest-row');
    if (row) pick(party(row.dataset.id));
  });
  [phone, name].forEach((el) => el.addEventListener('blur', () => setTimeout(() => {
    if (![phone, name].includes(document.activeElement)) box.hidden = true;
  }, 150)));
  status();
}

// ---------- Mahsulot tanlash ----------
// Katakka bosilganda: kategoriya → tur → mahsulot. Yozilsa: artikul yoki nom bo'yicha qidiruv.
const picker = { input: null, cat: null, type: null };

function pickerPanel() {
  let panel = $('#pickPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pickPanel';
    panel.className = 'pick-panel';
    panel.hidden = true;
    panel.addEventListener('mousedown', (e) => e.preventDefault()); // katak fokusini yo'qotmasin
    panel.addEventListener('click', (e) => {
      const el = e.target.closest('[data-pick]');
      if (!el) return;
      const { pick, value } = el.dataset;
      if (pick === 'cat') { picker.cat = value; picker.type = null; }
      else if (pick === 'type') picker.type = value;
      else if (pick === 'back') { if (picker.type !== null) picker.type = null; else picker.cat = null; }
      else if (pick === 'product') return choosePickedProduct(product(value));
      else if (pick === 'quickNew') {
        const row = picker.input.closest('tr');
        const name = picker.input.value.trim();
        closePicker();
        return quickEntry({ name, row });
      }
      picker.input.value = '';
      renderPicker();
      picker.input.focus();
    });
  }
  return panel;
}

const activeProducts = () => db.products.filter((p) => !p.archived);
// Hujjatda tanlash mumkin bo'lgan mahsulotlar: komplekt faqat savdoda (xarid va kirimda — alohida mahsulotlar)
let pickKits = true;
const pickProducts = () => activeProducts().filter((p) => pickKits || !isKit(p));

function searchProducts(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const words = s.split(/\s+/);
  return pickProducts()
    .map((p) => {
      const code = (p.code || '').toLowerCase();
      const hay = [p.name, p.code, p.category, p.type, p.color, p.size, ...Object.values(p.attrs || {})].join(' ').toLowerCase();
      const score = code === s ? 0 : code.startsWith(s) ? 1 : words.every((w) => hay.includes(w)) ? 2 : 9;
      return { p, score };
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

function productRow(p) {
  // Sotuvda: omborda borligi ko'rinadi; yo'q bo'lsa — tanlanganda kirim oynasi o'zi ochiladi
  let stockTag = '';
  if (docFormCtx?.quick && !isKit(p)) {
    const q = qtyIn(ctx.stock || {}, p.id, docFormCtx.warehouseId?.());
    stockTag = q > 0 ? `<span class="pick-stock">${q} ta</span>` : `<span class="pick-stock none">yo'q · + kirim</span>`;
  }
  return `<button type="button" class="pick-row" data-pick="product" data-value="${p.id}">
    <span class="pick-ic">${icon(productIcon(p))}</span><span><b>${esc(p.name)}</b>${p.code ? ` <span class="pick-code">${esc(p.code)}</span>` : ''}<span class="pick-sub">${esc(productPath(p))}${p.size ? ' · ' + esc(p.size) : ''}</span></span>
    <span class="pick-price">${priceLabel(p)}${stockTag}</span></button>`;
}

function renderPicker() {
  const panel = pickerPanel();
  const q = picker.input.value;
  const chosen = product(picker.input.closest('.it-pick').querySelector('.it-product').value);
  let html;
  if (q.trim() && q !== productLabel(chosen)) {
    const found = searchProducts(q);
    html = found.length ? found.slice(0, 30).map(productRow).join('') : '<div class="pick-empty">Topilmadi — artikul yoki nomni tekshiring</div>';
    if (docFormCtx?.quick && can('enter') && canAddProducts()) {
      html += `<button type="button" class="pick-row pick-quick" data-pick="quickNew"><span class="pick-ic">${icon('plus')}</span><span><b>«${esc(q.trim())}» — yangi mahsulot sifatida kirim qilish</b><span class="pick-sub">Sotuvdan chiqmasdan omborga kiritiladi</span></span></button>`;
    }
  } else {
    const list = pickProducts();
    const crumbs = [picker.cat, picker.type].filter((x) => x !== null && x !== undefined);
    const head = crumbs.length ? `<button type="button" class="pick-back" data-pick="back">‹ ${esc(['Barcha kategoriyalar', ...crumbs].join(' › '))}</button>` : '';
    const count = (arr, key) => arr.reduce((m, p) => { const k = key(p); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());
    const group = (label, n, pick, value, ic) => `<button type="button" class="pick-row pick-group" data-pick="${pick}" data-value="${esc(value)}">
      <span class="pick-ic">${icon(ic)}</span><span><b>${esc(label)}</b></span><span class="pick-count">${n} ›</span></button>`;
    if (picker.cat === null) {
      const cats = count(list, (p) => p.category || '');
      const order = [...db.categories.filter((c) => cats.has(c)), ...[...cats.keys()].filter((c) => !db.categories.includes(c))];
      html = order.map((c) => group(c || 'Kategoriyasiz', cats.get(c), 'cat', c, categoryIcon(c))).join('') || '<div class="pick-empty">Mahsulot yo\'q</div>';
    } else {
      const inCat = list.filter((p) => (p.category || '') === picker.cat);
      if (picker.type === null) {
        const types = count(inCat, (p) => p.type || '');
        const known = db.categoryTypes[picker.cat] || [];
        const order = [...known.filter((x) => types.has(x)), ...[...types.keys()].filter((x) => x && !known.includes(x))];
        html = head + order.map((x) => group(x, types.get(x), 'type', x, typeIcon(picker.cat, x))).join('')
          + inCat.filter((p) => !p.type).map(productRow).join('');
      } else {
        html = head + inCat.filter((p) => (p.type || '') === picker.type).map(productRow).join('');
      }
    }
  }
  panel.innerHTML = html;
  // Ro'yxat maydonning o'zi ostida ochiladi (ekran tepasida emas)
  const anchor = picker.input.closest('.it-sw') || picker.input;
  if (panel.previousElementSibling !== anchor) anchor.after(panel);
  panel.hidden = false;
}

function choosePickedProduct(p) {
  if (!p) return;
  const td = picker.input.closest('.it-pick');
  const hidden = td.querySelector('.it-product');
  hidden.value = p.id;
  picker.input.value = productLabel(p);
  td.querySelector('.it-path').textContent = productPath(p);
  closePicker();
  hidden.dispatchEvent(new Event('change', { bubbles: true }));
  const tr = td.closest('tr');
  // Sotuvda omborda yo'q mahsulot tanlansa — shu yerning o'zida kirim qilish oynasi ochiladi
  if (docFormCtx?.quick && !isKit(p) && tr) {
    const have = qtyIn(computeStock(), p.id, docFormCtx.warehouseId?.());
    const need = num(tr.querySelector('.it-qty')?.value) || 1;
    if (have < need) return quickEntry({ productId: p.id, qty: need - have, row: tr });
  }
  if (!isTouch()) tr?.querySelector('.it-qty')?.focus();
}

function closePicker() {
  const panel = $('#pickPanel');
  if (panel) panel.hidden = true;
}

document.addEventListener('focusin', (e) => {
  if (!e.target.classList?.contains('it-search')) return;
  picker.input = e.target;
  picker.cat = null;
  picker.type = null;
  const p = product(e.target.closest('.it-pick').querySelector('.it-product').value);
  if (p) { picker.cat = p.category || ''; picker.type = p.type || null; }
  e.target.select();
  renderPicker();
  // Telefonda: maydon tepaga chiqsin — ostidagi ro'yxat klaviatura ustida ko'rinsin
  if (window.innerWidth <= 700) setTimeout(() => picker.input?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
});
document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('it-search')) renderPicker();
});
document.addEventListener('keydown', (e) => {
  if (!e.target.classList?.contains('it-search')) return;
  // Esc faqat ro'yxatni yopsin — butun oynani (va kiritilganlarni) emas
  if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const found = searchProducts(e.target.value);
  const exact = found.find((p) => (p.code || '').toLowerCase() === e.target.value.trim().toLowerCase());
  if (exact || found.length === 1) choosePickedProduct(exact || found[0]);
});
document.addEventListener('focusout', (e) => {
  if (!e.target.classList?.contains('it-search')) return;
  setTimeout(() => {
    if (document.activeElement !== e.target) {
      // Boshqa mahsulot maydoniga o'tilgan bo'lsa, uning ro'yxati ochiq qolsin
      if (!document.activeElement?.classList?.contains('it-search')) closePicker();
      // Tanlanmagan matn qolsa — avvalgi tanlovni qaytaramiz
      const p = product(e.target.closest('.it-pick').querySelector('.it-product').value);
      e.target.value = productLabel(p);
    }
  }, 150);
});
$('#modal').addEventListener('close', () => { closePicker(); docFormCtx = null; });
$('#modal').addEventListener('cancel', (e) => {
  const panel = $('#pickPanel');
  if (panel && !panel.hidden) { e.preventDefault(); closePicker(); }
});

function bindDocForm(type, editingId) {
  const t = DOC_TYPES[type];
  // Yangi sotuv yetkazilmasa — mijoz olib ketdi: «Yetkazildi»
  if (type === 'sale' && !editingId && $('#needDelivery') && !$('#needDelivery').checked) {
    const st = $('#modalBody [name=status]');
    if (st) st.value = 'delivered';
  }
  pickKits = t.price === 'sale';
  // Sotuv va buyurtmada: mahsulot yetmasa — shu yerning o'zida kirim qilish tugmasi
  const quick = (type === 'sale' || type === 'order') && can('enter');
  bindAddressBlock();
  if (t.party === 'customer') bindCustomerLookup();
  else if (t.party) bindPartyLookup(t.party);
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
    if (hidesCost(t)) return '';
    const cur = curOf();
    if (cur === 'USD' && p.priceCurrency === 'USD' && p.buyPrice) return p.buyPrice;
    const som = ctx.cost[p.id] || toUZS(p.buyPrice || 0, p.priceCurrency);
    return cur === 'USD' ? (rateOf() ? round2(som / rateOf()) : 0) : Math.round(som);
  };

  const recalc = () => {
    let sum = 0;
    let rowDisc = 0;
    $$('tr', body).forEach((tr) => {
      const p = product($('.it-product', tr).value);
      const priceEl = $('.it-price', tr);
      const discEl = $('.it-disc', tr);
      const dOne = discEl ? num(discEl.value) : 0;
      const final = num(priceEl.value) - dOne;
      const line = num($('.it-qty', tr).value) * final;
      rowDisc += num($('.it-qty', tr).value) * dOne;
      sum += line;
      $('.it-sum', tr).textContent = p ? fmtIn(round2(line), curOf()) : '';
      const avail = p ? qtyIn(stock, p.id, whSel.value) : '';
      const short = quick && p && !isKit(p) && avail < num($('.it-qty', tr).value);
      // Faqat o'zgarganda yozamiz — aks holda bosilayotgan «Kirim» tugmasi almashib, bosish yo'qoladi
      const availHtml = p ? `${avail}${short ? ` <button type="button" class="small it-enter" title="Shu yerning o'zida omborga kirim qilish">${icon('plus')}Kirim</button>` : ''}` : '';
      const availCell = $('.it-avail', tr);
      if (availCell.dataset.html !== availHtml) { availCell.innerHTML = availHtml; availCell.dataset.html = availHtml; }
      // Savdoda: sotuvchi eng kam narxni ko'radi, undan pastga tushsa ogohlantiriladi
      const min = p && t.price === 'sale' && type !== 'salesReturn' ? minPriceUZS(p) : 0;
      const low = !!min && final < min;
      $('.it-min', tr).innerHTML = (dOne > 0 ? `Sotish narxi: <b>${fmt(final)}</b>` : '')
        + (min ? `${dOne > 0 ? ' · ' : ''}eng kami: ${fmt(min)}` : '')
        + (low && dOne > 0 ? `<br><b class="debt">Chegirma juda katta! Ko'pi bilan ${fmt(Math.max(0, num(priceEl.value) - min))}</b>` : '');
      priceEl.classList.toggle('below-min', low && !dOne);
      discEl?.classList.toggle('below-min', low && dOne > 0);
    });
    if (isCustom()) sum = num($('#modalBody [name=cQty]').value) * num($('#modalBody [name=cPrice]').value);
    // Chegirma 1 donaga: mahsulotlar soniga ko'paytiriladi
    const kEl = $('#modalForm [name=discountK]');
    let units = 1;
    if (kEl) {
      units = Math.max(1, isCustom() ? num($('#modalBody [name=cQty]')?.value) : readItems().reduce((s, it) => s + num(it.qty), 0));
      kEl.value = units;
    }
    const disc = discountOf({ discount: discount?.value, discountK: kEl?.value });
    const hint = $('#discHint');
    if (hint) {
      const maxD = t.price === 'sale' && type !== 'salesReturn' && !isCustom() ? maxDiscount(readItems()) : Infinity;
      const over = disc > maxD;
      const perMax = Math.floor(maxD / units);
      hint.innerHTML = disc ? `${fmt(num(discount.value))} × ${units} dona = <b>${money(disc)}</b>${over ? ` <b class="debt">— juda katta! 1 donaga ko'pi bilan ${money(perMax)}</b>` : ''}` : '';
      discount?.classList.toggle('below-min', over);
    }
    const total = Math.max(0, sum - disc);
    const brk = $('#docBreak');
    const allDisc = Math.min(disc, sum) + rowDisc;
    if (brk) brk.innerHTML = allDisc && curOf() === 'UZS' ? `${money(sum + rowDisc)} − chegirma ${money(allDisc)} = ` : '';
    $('#docTotal').innerHTML = curOf() === 'USD'
      ? `${fmtUsd(total)} <span class="muted">≈ ${money(total * rateOf())}</span>`
      : money(total);
    // Sotuvda "Hozir to'landi" jami summa bilan o'zi to'lib turadi (kassir o'zgartirmaguncha)
    const payNowEl = $('#modalBody [name=payNow]');
    if (type === 'sale' && payNowEl && !payTouched) {
      payNowEl.value = Math.max(0, total - num($('#totalLine').dataset.paid)) || '';
      formatMoneyInput(payNowEl);
    }
    // Mijoz to'lovi: oldin to'langan + hozir (zaklad) → qolgan summa
    if (t.pay === 'in' && curOf() === 'UZS') {
      const paid = num($('#totalLine').dataset.paid) + num($('#modalBody [name=payNow]')?.value);
      $('#docRest').innerHTML = paid || type === 'order'
        ? ` <span class="rest">· ${type === 'order' ? 'Zaklad' : "To'langan"}: <b>${money(paid)}</b> · Qolgan to'lov: <b class="${total - paid > 0 ? 'debt' : 'ok'}">${money(Math.max(0, total - paid))}</b></span>`
        : '';
      const debtBlock = $('#debtBlock');
      if (debtBlock) {
        const rest = Math.max(0, total - paid);
        debtBlock.hidden = rest <= 0;
        $('#debtAmount').textContent = money(rest);
      }
    }
  };
  const isCustom = () => orderKindOf() === 'custom';
  let payTouched = !!editingId || num($('#modalBody [name=payNow]')?.value) > 0;

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
    const enterBtn = e.target.closest('.it-enter');
    if (enterBtn) {
      const tr = enterBtn.closest('tr');
      const pid = $('.it-product', tr).value;
      return quickEntry({ productId: pid, qty: num($('.it-qty', tr).value) - qtyIn(stock, pid, whSel.value), row: tr });
    }
    if (!e.target.classList.contains('it-remove')) return;
    const chosen = product($('.it-product', e.target.closest('tr')).value);
    if (chosen && !confirm(`«${chosen.name}» ro'yxatdan olib tashlansinmi?`)) return;
    if ($$('tr', body).length > 1) e.target.closest('tr').remove();
    else {
      $('.it-product', e.target.closest('tr')).value = '';
      $('.it-search', e.target.closest('tr')).value = '';
      $('.it-path', e.target.closest('tr')).textContent = '';
    }
    recalc();
  });
  $('#addItemRow').addEventListener('click', () => body.insertAdjacentHTML('beforeend', itemRowHtml(t, {}, curOf())));
  // Valyuta almashtirilsa — narxlar joriy kurs bo'yicha qayta hisoblanadi
  curRadios.forEach((r) => r.addEventListener('change', () => {
    const cur = curOf();
    const rate = rateOf();
    $('#rateField').hidden = cur !== 'USD';
    [...$$('.it-price, .it-disc', body), discount].filter(Boolean).forEach((el) => {
      const v = num(el.value);
      if (v && rate) el.value = cur === 'USD' ? round2(v / rate) : Math.round(v * rate);
      setMoneyCurrency(el, cur);
    });
    recalc();
  }));
  rateInput?.addEventListener('input', recalc);
  // Standart / nostandart buyurtma
  $$('#modalBody [name=orderKind]').forEach((r) => r.addEventListener('change', () => {
    $('#customBlock').hidden = !isCustom();
    $('#stdBlock').hidden = isCustom();
    const w = $('#docDiscWrap');
    if (w && rowDiscDoc(t)) w.hidden = !isCustom() && !w.dataset.legacy;
    recalc();
  }));
  $('#customBlock')?.addEventListener('input', recalc);
  $('#modalBody [name=payNow]')?.addEventListener('input', () => { payTouched = true; recalc(); renderReceiptLine(); });
  // Naqd bo'lmagan to'lov tanlansa — chek suratini olish oynasi ochiladi
  receiptFiles = [];
  const payMethodSel = $('#modalBody [name=payMethod]');
  if ($('#receiptLine') && payMethodSel) {
    payMethodSel.addEventListener('change', () => {
      renderReceiptLine();
      if (NEEDS_RECEIPT.includes(payMethodSel.value) && num($('#modalBody [name=payNow]')?.value) > 0 && !receiptFiles.length) openReceiptPicker();
    });
    $('#receiptLine').addEventListener('click', (e) => { if (e.target.closest('#receiptOpen')) openReceiptPicker(); });
    renderReceiptLine();
  }
  // "Xarid qildi" ↔ "Buyurtma berdi": kiritilganlarni saqlab, oynani boshqa turga o'tkazamiz
  $$('#modalBody [name=saleMode]').forEach((r) => r.addEventListener('change', () => {
    const f = Object.fromEntries(new FormData($('#modalForm')).entries());
    const items = readItems();
    openDoc(r.value, null, {
      date: f.date,
      counterpartyId: f.counterpartyId || (f.partyName ? '' : 'retail'),
      warehouseId: f.warehouseId,
      addr: f.needDelivery && f.aRegion && f.aRegion !== '__new' ? { region: f.aRegion, place: f.aPlace !== '__new' ? f.aPlace : '', spot: f.aSpot, detail: f.aDetail } : undefined,
      deliveryDate: f.deliveryDate,
      discount: discountOf(f),
      // Avtomatik qo'yilgan to'liq summa zakladga o'tib ketmasin — faqat kassir yozgani
      payNow: payTouched ? num(f.payNow) || '' : '',
      note: f.note,
      items: items.length ? items : undefined,
      draftParty: { phone: f.partyPhone, name: f.partyName, ctype: f.customerType },
    });
  }));
  whSel.addEventListener('change', recalc);
  if (discount) discount.addEventListener('input', recalc);
  recalc();
  docFormCtx = {
    quick,
    warehouseId: () => whSel.value,
    // Tezkor kirimdan keyin: qoldiqni qayta hisoblab, qatorlarni yangilaymiz
    refresh: () => {
      const st = computeStock(editingId);
      Object.keys(stock).forEach((k) => delete stock[k]);
      Object.assign(stock, st);
      recalc();
    },
  };
  return stock;
}

// Hujjat bo'yicha avval to'langan summa (buyurtmadan sotuvda — buyurtmaga berilgan zaklad)
function prevPaid(d) {
  if (d.id) return docPaid(d);
  const order = d.orderId && doc(d.orderId);
  return order ? docPaid(order) : 0;
}

// Buyurtma turi: tanlangan radio yoki (individual buyurtmadan sotuvda) yashirin maydon
const orderKindOf = () => $$('#modalBody [name=orderKind]').find((r) => r.type === 'hidden' || r.checked)?.value || 'standard';

function readItems() {
  // Individual (nostandart) buyurtma — bitta qator, katalogdagi mahsulotga bog'lanmagan
  if (orderKindOf() === 'custom') {
    const name = $('#modalBody [name=cName]').value.trim();
    if (!name) return [];
    return [{
      productId: null,
      name,
      size: $('#modalBody [name=cSize]').value.trim(),
      color: $('#modalBody [name=cColor]').value.trim(),
      spec: $('#modalBody [name=cSpec]').value.trim(),
      qty: Math.max(1, num($('#modalBody [name=cQty]').value)),
      price: num($('#modalBody [name=cPrice]').value),
    }];
  }
  const items = [];
  $$('#itemRows tr').forEach((tr) => {
    const productId = $('.it-product', tr).value;
    if (!productId) return;
    const it = { productId, qty: Math.max(1, num($('.it-qty', tr).value)), price: num($('.it-price', tr).value) };
    // Qatordagi chegirma: saqlanadigan narx — sotish narxi (narx − chegirma), etiketka narxi va chegirma ham yoziladi
    const dOne = num($('.it-disc', tr)?.value);
    if (dOne > 0) Object.assign(it, { listPrice: it.price, disc: dOne, price: it.price - dOne });
    // Komplekt tarkibidagi qator: komplekt belgisi saqlanadi (mahsulot almashtirilmagan bo'lsa)
    const k = tr.dataset.kitId && product(tr.dataset.kitId);
    if (k && kitParts(k).some((c) => c.productId === productId)) Object.assign(it, { kitId: k.id, kitName: tr.dataset.kitName, kitQty: num(tr.dataset.kitQty) || undefined });
    items.push(it);
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
    if (existing.delivered?.photos?.length) extra.push({ label: `📸 Yetkazish surati (${existing.delivered.photos.length})`, onClick: () => showReceipts(existing.delivered.photos.map((fileId) => ({ fileId }))) });
    if (isOpenSale(existing)) {
      extra.push({ label: '✅ Yetkazildi', cls: 'primary-soft', onClick: () => { closeModal(); closeSale(existing.id); } });
      if (existing.driverId) extra.push({ label: '🚚 Shofyorga qayta yuborish', onClick: () => sendToDriver(existing.id, existing.driverId) });
    }
    const rcs = db.payments.filter((p) => p.docId === existing.id).flatMap((p) => p.receipts || []);
    if (rcs.length) extra.push({ label: `🧾 Chek (${rcs.length})`, onClick: () => showReceipts(rcs) });
    if (type === 'order') extra.push({ label: 'Shartnoma', cls: 'primary-soft', onClick: () => printContract(existing.id) });
    if (!hidesCost(t)) extra.push({ label: 'Chop etish', onClick: () => printDoc(existing.id) });
    if (['receipt', 'enter'].includes(type)) extra.push({ label: 'Etiketkalar', onClick: () => docLabels(existing.id) });
    if (t.pay && (can('money') || (t.pay === 'in' && can('sale')))) extra.push({ label: "To'lov", onClick: () => newPayment(t.pay, { counterpartyId: existing.counterpartyId, docId: existing.id }) });
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

const canUseDoc = (type) => can(DOC_PERM[type]);
const canEditDoc = (d) => isAdmin() || (canUseDoc(d.type) && d.userId === me?.id);

async function saveDoc(type, existing, preset, data, stock) {
  const t = DOC_TYPES[type];
  let items = readItems();
  if (!items.length) {
    alert(data.orderKind === 'custom' ? 'Individual buyurtma nomini kiriting.' : 'Kamida bitta mahsulot tanlang.');
    return false;
  }
  const currency = t.fx && data.currency === 'USD' ? 'USD' : 'UZS';
  if (currency === 'USD' && !(num(data.rate) > 0)) {
    alert('Dollar kursini kiriting.');
    return false;
  }
  if (!existing && t.tgAsk && !tgAnswered(data)) return false;
  // Qarzga sotuv: qolgan summa bo'lsa — qaytarish sanasi va aniq mijoz kerak
  let debtRest = 0;
  if (type === 'sale') {
    const total = Math.max(0, items.reduce((sum, it) => sum + it.qty * it.price, 0) - discountOf(data));
    debtRest = total - prevPaid(existing || preset) - num(data.payNow);
    if (debtRest > 0) {
      if (!data.debtDue) {
        alert(`${money(debtRest)} qarz qolyapti. Mijoz qachon berishini kiriting.`);
        $('#modalBody [name=debtDue]')?.focus();
        return false;
      }
      if (!(data.partyName || '').trim() && !data.counterpartyId) {
        alert("Qarzga sotish uchun mijoz ismi va telefon raqamini kiriting.");
        $('#partyPhone')?.focus();
        return false;
      }
    }
  }
  if (type === 'order' && !data.deliveryDate) {
    alert('Buyurtmani bajarish muddatini kiriting.');
    $('#modalBody [name=deliveryDate]')?.focus();
    return false;
  }

  // Eng kam narxdan arzon sotish: sotuvchiga ruxsat yo'q, administrator tasdiqlaydi
  if (t.price === 'sale' && type !== 'salesReturn') {
    const low = items.map((it) => ({ it, p: product(it.productId) }))
      .filter(({ it, p }) => p && minPriceUZS(p) && it.price < minPriceUZS(p))
      .map(({ it, p }) => `${p.name}: ${fmt(it.price)} < eng kami ${fmt(minPriceUZS(p))} so'm`);
    if (low.length) {
      if (!can('costs')) {
        alert("Narx eng kam narxdan past:\n" + low.join('\n') + "\n\nChegirmani kamaytiring (yoki narxni oshiring) — yoki administratorga murojaat qiling.");
        return false;
      }
      if (!confirm("Narx eng kam narxdan past:\n" + low.join('\n') + "\n\nBaribir saqlansinmi?")) return false;
    }
  }
  // Chegirma mahsulotlarning eng kam narxidan pastga tushirmasin
  if (t.price === 'sale' && type !== 'salesReturn' && discountOf(data) > 0 && data.orderKind !== 'custom') {
    const maxD = maxDiscount(items);
    if (discountOf(data) > maxD) {
      const units = Math.max(1, num(data.discountK) || 1);
      const msg = `Chegirma juda katta: 1 donaga ${money(num(data.discount))} (jami ${money(discountOf(data))}).\nEng kam narx bo'yicha 1 donaga ko'pi bilan ${money(Math.floor(maxD / units))} chegirma qilish mumkin.`;
      if (!isAdmin()) { alert(msg + '\n\nSotish mumkin emas — chegirmani kamaytiring.'); $('#modalBody [name=discount]')?.focus(); return false; }
      if (!confirm(msg + '\n\nBaribir saqlansinmi? (faqat administrator)')) return false;
    }
  }
  if (t.move && data.warehouseId === data.toWarehouseId) {
    alert('Omborlar har xil bo\'lishi kerak.');
    return false;
  }
  // Komplekt qatorlari tarkibidagi mahsulotlarga yoyiladi (narx va eng kam narx yuqorida tekshirildi)
  if (items.some((it) => isKit(product(it.productId)))) items = expandKits(items, t);

  const delivery = t.delivery ? readAddress(data) : null;
  let counterpartyId = data.counterpartyId && data.counterpartyId !== '__new' ? data.counterpartyId : null;
  if (t.party === 'customer') {
    const digits = fieldPhoneDigits(data.partyPhone);
    const phone = digits.length === 9 ? fmtPhone(digits) : '';
    const name = (data.partyName || '').trim();
    const ctype = readCustomerType(data);
    let c = counterpartyId && party(counterpartyId);
    if (!c && phone) c = db.counterparties.find((x) => x.id !== 'retail' && phoneKey(x.phone) === digits);
    if (c && c.id !== 'retail') {
      if (phone && !c.phone) c.phone = phone;
      if (ctype && c.ctype !== ctype) c.ctype = ctype;
      // Mijozning manzili yangilanadi — keyingi safar o'zi to'ladi
      if (delivery) Object.assign(c, { addr: delivery.addr, address: delivery.text });
    } else if (name) {
      c = { id: uid(), name, kind: 'customer', ctype, phone, address: delivery?.text || '', addr: delivery?.addr, inn: '', note: '', created: today() };
      db.counterparties.push(c);
    } else if (digits) {
      alert('Mijoz ismini kiriting.');
      $('#partyName')?.focus();
      return false;
    } else {
      c = party('retail');
    }
    counterpartyId = c.id;
  } else if (t.party) {
    const phone = fieldPhoneDigits(data.partyPhone).length === 9 ? fmtPhone(fieldPhoneDigits(data.partyPhone)) : '';
    if (!counterpartyId && data.newPartyName.trim()) {
      const c = { id: uid(), name: data.newPartyName.trim(), kind: t.party, phone, address: data.address?.trim() || '', inn: '', note: '', created: today() };
      db.counterparties.push(c);
      counterpartyId = c.id;
    }
    if (!counterpartyId) {
      alert(phone ? `Yangi ${t.party === 'supplier' ? "ta'minotchi" : 'mijoz'} ismini kiriting.` : (t.party === 'supplier' ? "Ta'minotchini tanlang." : 'Mijozni tanlang yoki telefon raqamini kiriting.'));
      $('#newPartyName')?.focus();
      return false;
    }
    // Tanlangan mijozning raqami bo'lmasa — kiritilgan raqamni unga yozib qo'yamiz
    const chosen = party(counterpartyId);
    if (phone && chosen && chosen.id !== 'retail' && !chosen.phone) chosen.phone = phone;
  }

  // Ombordan chiqarishda yetarli qoldiq borligini tekshiramiz
  if (t.stock < 0 || t.move) {
    const need = {};
    items.filter((it) => it.productId).forEach((it) => { need[it.productId] = (need[it.productId] || 0) + it.qty; });
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
    deliveryDate: t.delivery && (delivery || type === 'order') ? data.deliveryDate : undefined,
    address: t.delivery ? delivery?.text || '' : undefined,
    addr: t.delivery ? delivery?.addr : undefined,
    discount: discountOf(data),
    note: data.note.trim(),
    items,
    currency: t.fx ? currency : undefined,
    rate: currency === 'USD' ? num(data.rate) : undefined,
    debtDue: type === 'sale' && debtRest > 0 ? data.debtDue : undefined,
    debtResponsible: type === 'sale' && debtRest > 0 ? data.debtResponsible : undefined,
    orderKind: type === 'order' || data.orderKind === 'custom' ? (data.orderKind === 'custom' ? 'custom' : 'standard') : d.orderKind,
    responsible: type === 'order' ? (data.responsible || '').trim() : d.responsible,
    driverId: type === 'sale' ? (delivery && data.driverId) || undefined : d.driverId,
  });

  if (!existing) {
    const pay = num(data.payNow);
    // Karta / terminal / perechisleniye: chek surati Telegramga yuboriladi
    let receipts;
    if (pay > 0 && t.pay === 'in' && NEEDS_RECEIPT.includes(data.payMethod)) {
      if (!receiptFiles.length) {
        if (!confirm(`${PAY_METHODS[data.payMethod]} orqali to'lov — chek surati qo'shilmagan.\n\nChek suratisiz saqlansinmi?`)) { openReceiptPicker(); return false; }
      } else {
        try {
          const who = party(counterpartyId);
          receipts = await sendReceipts(`🧾 Chek · ${t.one} ${d.no}\n💰 ${money(pay)} · ${PAY_METHODS[data.payMethod]}\n👥 Mijoz: ${who?.name || ''}${who?.phone ? ' ' + who.phone : ''}\n📅 ${fmtDate(d.date)}`);
        } catch (e) {
          if (!confirm(`Chek Telegramga yuborilmadi: ${e.message}\n\nChek suratisiz saqlansinmi? («Bekor» — qayta urinish uchun)`)) return false;
        }
      }
    }
    db.docs.push(d);
    if (pay > 0) {
      db.payments.push({
        id: uid(), no: await nextNo(t.pay === 'in' ? 'payIn' : 'payOut'), dir: t.pay, date: d.date, counterpartyId, docId: d.id,
        amount: pay, method: data.payMethod, purpose: t.pay === 'in' ? PAY_PURPOSES_IN[0] : PAY_PURPOSES_OUT[0], note: '', userId: me?.id,
        receipts: receipts?.length ? receipts : undefined,
      });
    }
    // Asos hujjat holatini yangilaymiz
    const base = preset.baseId && doc(preset.baseId);
    if (base?.type === 'order') base.status = 'shipped';
    if (base?.type === 'purchaseOrder') base.status = 'received';
  }
  const prevDriver = existing ? existing.driverSentTo : null;
  save();
  if (!existing && t.tgAsk && data.tgPost === 'yes') telegramOnStockIn(d);
  // Shofyor tanlangan bo'lsa — buyurtma uning Telegramiga yuboriladi (yangi yoki shofyor almashtirilgan)
  if (type === 'sale' && d.driverId && isOpenSale(d) && prevDriver !== d.driverId) {
    sendToDriver(d.id, d.driverId); // server sotuvga driverSentTo ni o'zi yozadi
  }
}

function createFrom(id) {
  const base = doc(id);
  const t = DOC_TYPES[base.type];
  const preset = {
    date: today(),
    counterpartyId: base.counterpartyId,
    warehouseId: base.warehouseId,
    address: base.address,
    addr: base.addr,
    deliveryDate: base.deliveryDate,
    discount: base.discount,
    currency: base.currency,
    rate: base.rate,
    orderKind: base.orderKind,
    responsible: base.responsible,
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
    const p = product(it.productId) || { name: it.name, size: it.size, color: it.color };
    return `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}<br><small>${esc([it.kitName ? 'Komplekt: ' + it.kitName : '', p.size, p.color].filter(Boolean).join(', '))}</small></td><td>${it.qty} ${esc(p.unit || '')}</td><td>${fmtIn(it.price, d.currency)}</td><td>${fmtIn(Math.round(it.qty * it.price * 100) / 100, d.currency)}</td></tr>`;
  }).join('');
  const paid = t.pay ? docPaid(d) : 0;
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.one)} ${esc(d.no)}</title>
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
    </body></html>`);
}

// Chop etish: yashirin ichki oyna orqali — telefonga o'rnatilgan ilovada ham ishlaydi
function printHtml(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(frame);
  const fdoc = frame.contentDocument;
  fdoc.open();
  fdoc.write(html);
  fdoc.close();
  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      alert("Chop etib bo'lmadi: " + e.message);
    }
    setTimeout(() => frame.remove(), 60000);
  }, 300);
}

const DEFAULT_CONTRACT_TERMS = [
  'Sotuvchi buyurtmani shartnomada ko\'rsatilgan muddatda va kelishilgan sifatda bajaradi.',
  "Xaridor qolgan to'lovni buyurtma topshirilayotganda to'liq to'laydi.",
  "Individual (nostandart) buyurtmaning o'lchami, rangi va materiali xaridor bilan kelishilgan; ishlab chiqarish boshlangandan keyin ularni o'zgartirish qo'shimcha haq evaziga amalga oshiriladi.",
  "Xaridor buyurtmani qabul qilayotganda ko'zdan kechiradi; ko'rinadigan kamchiliklar haqida shu vaqtning o'zida aytadi.",
  "Mebelga kafolat muddati — 12 oy. Noto'g'ri foydalanish va mexanik shikastlanish kafolatga kirmaydi.",
].join('\n');

// Buyurtma bo'yicha ikki tomonlama shartnoma: bitta varaqda ikki nusxa (sotuvchi va xaridor uchun)
function contractHtml(d) {
  const c = party(d.counterpartyId) || {};
  const co = db.company;
  const total = docTotal(d);
  const paid = docPaid(d);
  const rest = Math.max(0, total - paid);
  const custom = d.orderKind === 'custom';
  const rows = d.items.map((it, i) => {
    const p = product(it.productId) || {};
    const size = it.size || p.size;
    const color = it.color || p.color;
    return `<tr><td>${i + 1}</td><td><b>${esc(itemName(it))}</b>${size || color ? `<br><small>${esc([size && size + ' sm', color].filter(Boolean).join(', '))}</small>` : ''}${it.spec ? `<br><small>${esc(it.spec)}</small>` : ''}</td>
      <td class="r">${it.qty}</td><td class="r">${fmt(it.price)}</td><td class="r">${fmt(it.qty * it.price)}</td></tr>`;
  }).join('');
  const terms = String(co.contractTerms || DEFAULT_CONTRACT_TERMS).split('\n').map((x) => x.trim()).filter(Boolean);
  const copy = (label) => `<section class="copy">
    <div class="top"><div><b>${esc(co.name)}</b><br>${esc([co.address, co.phone].filter(Boolean).join(' · '))}</div><div class="r small">${label}</div></div>
    <h1>BUYURTMA SHARTNOMASI № ${esc(d.no)}</h1>
    <div class="c small">${fmtDate(d.date)}</div>
    <table class="parties"><tr>
      <td><b>Sotuvchi:</b> ${esc(co.name)}${d.responsible ? `<br>Mas'ul: ${esc(d.responsible)}` : ''}</td>
      <td><b>Xaridor:</b> ${esc(c.name || '')}${c.phone ? `<br>Tel: ${esc(c.phone)}` : ''}${d.address || c.address ? `<br>Manzil: ${esc(d.address || c.address)}` : ''}</td>
    </tr></table>
    <p><b>1. Buyurtma.</b> ${custom ? 'Individual (nostandart) buyurtma' : 'Standart mahsulotlar'}:</p>
    <table><tr><th>№</th><th>Nomi</th><th class="r">Soni</th><th class="r">Narxi</th><th class="r">Summa</th></tr>${rows}</table>
    <p><b>2. Narx va to'lov.</b> Umumiy summa: <b>${money(total)}</b>${d.discount ? ` (chegirma ${money(d.discount)})` : ''}.
      Oldindan to'lov (zaklad): <b>${money(paid)}</b>. Qolgan to'lov: <b>${money(rest)}</b>.</p>
    <p><b>3. Muddat.</b> Buyurtma <b>${fmtDate(d.deliveryDate) || '______'}</b> gacha bajariladi${d.address ? `, yetkazish manzili: ${esc(d.address)}` : ''}.</p>
    <p><b>4. Shartlar.</b></p>
    <ol>${terms.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    <table class="sign"><tr>
      <td>Sotuvchi: ____________________<br><small>${esc(d.responsible || co.name)}</small></td>
      <td>Xaridor: ____________________<br><small>${esc(c.name || '')} — shartlar bilan tanishdim</small></td>
    </tr></table>
  </section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shartnoma ${esc(d.no)}</title>
    <style>
      @page { size: A4; margin: 10mm; }
      body { font-family: Arial, sans-serif; font-size: 10.5px; color: #000; margin: 0; }
      .copy { break-inside: avoid; page-break-inside: avoid; padding: 2mm 0 4mm; }
      .cut { border-top: 1px dashed #777; margin: 3mm 0; text-align: center; font-size: 9px; color: #555; }
      .top { display: flex; justify-content: space-between; gap: 10px; }
      h1 { font-size: 14px; text-align: center; margin: 4px 0 0; }
      .c { text-align: center; } .r { text-align: right; } .small { font-size: 9px; }
      table { width: 100%; border-collapse: collapse; margin: 4px 0; }
      th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
      .parties td, .sign td { border: none; width: 50%; padding: 4px 0; }
      .sign td { padding-top: 14px; }
      p { margin: 4px 0; } ol { margin: 2px 0 4px 16px; padding: 0; } li { margin: 1px 0; }
    </style></head><body>
    ${copy('1-nusxa — sotuvchi uchun')}
    <div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>
    ${copy('2-nusxa — xaridor uchun')}
  </body></html>`;
}

function printContract(id) {
  const d = doc(id);
  if (!d) return;
  printHtml(contractHtml(d));
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
        <td><input class="inv-fact" type="number" inputmode="numeric" min="0" value="${q}"></td><td class="num inv-diff">0</td></tr>`;
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
  if (dir === 'out' && !can('money')) return alert("Chiqim to'lovlari uchun ruxsatingiz yo'q.");
  if (dir === 'in' && !can('money') && !can('sale')) return alert("To'lov qabul qilish uchun ruxsatingiz yo'q.");
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
        ${moneyField('Summa *', 'amount', rest || '', 'UZS', 'required')}
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

// ---------- Interfeys: bo'limlar va tablar tartibi ----------
// Administrator tugmalar ketma-ketligini o'zgartiradi — hamma xodimlarda shu tartib bo'ladi.
function viewLayout() {
  const secs = orderBy(SECTIONS.filter((s) => !s.hideInNav), db.uiOrder?.sections, (s) => s.id);
  const arrows = (kind, sec, i, n) => `<span class="lo-arrows">
      <button type="button" class="small icon-only" data-act="loMove" data-kind="${kind}" data-sec="${sec}" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} title="Yuqoriga">▲</button>
      <button type="button" class="small icon-only" data-act="loMove" data-kind="${kind}" data-sec="${sec}" data-i="${i}" data-d="1" ${i === n - 1 ? 'disabled' : ''} title="Pastga">▼</button></span>`;
  const open = filterVal('layout.open');
  return `<div class="card narrow"><h3>Tugmalar tartibi</h3>
    <p class="muted small">▲ ▼ bilan bo'limlar (asosiy menyu) va ularning ichidagi tablar ketma-ketligini o'zgartiring. O'zgarish darhol saqlanadi va barcha xodimlarda ko'rinadi. Birinchi bo'lim — dastur ochilganda chiqadigan sahifa.</p>
    <div class="lo-list">${secs.map((s, i) => {
      const views = s.views ? orderBy(s.views.slice(), db.uiOrder?.tabs?.[s.id], (v) => v[0]) : [];
      return `<div class="lo-sec">
        <div class="lo-row"><span class="lo-ic">${icon(s.icon)}</span><b>${esc(s.title)}</b>
          ${views.length > 1 ? `<button type="button" class="small lo-tabs-btn" data-act="loOpen" data-sec="${s.id}" title="Ichidagi tablar tartibi">${open === s.id ? '▴ yopish' : `▾ ${views.length} tab`}</button>` : '<span></span>'}
          ${arrows('sec', '', i, secs.length)}</div>
        ${open === s.id ? `<div class="lo-tabs">${views.map((v, j) => `<div class="lo-row lo-tab"><span class="lo-ic"></span><span>${esc(viewTitle(v))}</span><span></span>${arrows('tab', s.id, j, views.length)}</div>`).join('')}</div>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="toolbar" style="margin-top:12px"><button data-act="loReset">Asl tartibga qaytarish</button></div></div>`;
}

function moveLayout({ kind, sec, i, d }) {
  const o = (db.uiOrder = Object.assign({ sections: [], tabs: {} }, db.uiOrder));
  let ids;
  if (kind === 'sec') ids = orderBy(SECTIONS.filter((s) => !s.hideInNav), o.sections, (s) => s.id).map((s) => s.id);
  else ids = orderBy(SECTIONS.find((s) => s.id === sec).views.slice(), o.tabs?.[sec], (v) => v[0]).map((v) => v[0]);
  const a = +i;
  const b = a + +d;
  if (b < 0 || b >= ids.length) return;
  [ids[a], ids[b]] = [ids[b], ids[a]];
  if (kind === 'sec') o.sections = ids;
  else o.tabs = Object.assign({}, o.tabs, { [sec]: ids });
  save();
}

// ---------- Xarajatlar ----------
// Xarajat — kontragentga bog'liq bo'lmagan chiqim to'lovi (expense: true). Kassadan ayiriladi
// va «Foyda va zarar» hisobotida xarajat sifatida olinadi.
const isExpense = (p) => p.dir === 'out' && !p.counterpartyId && (p.expense || EXPENSE_PURPOSES.includes(p.purpose));
const expenseCat = (name) => (db.expenseCats || []).find((c) => c.name === name);
const expenseEmoji = (name) => expenseCat(name)?.emoji || (isSalaryCat(name) ? '👷' : '📦');

const expenseCatsList = () => (db.expenseCats?.length ? db.expenseCats : DEFAULT_EXPENSE_CATS);
const salaryCat = () => expenseCatsList().find((c) => isSalaryCat(c.name));
// Modda ichidagi tugmalar (oylikda — xodimlar: moddadagi ro'yxat + avvalgi «Oylik oladigan xodimlar»)
function expenseSubs(c) {
  if (!c) return [];
  const list = isSalaryCat(c.name) ? [...(c.subs || []), ...(db.staffNames || [])] : (c.subs || []);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}
const salarySubs = () => expenseSubs(salaryCat());
const hasSubs = (c) => !!c?.subsOn;

// Xarajatlar sahifasida modda bosilganda: ichida tugmalar bo'lsa — avval ular chiqadi
function openExpenseSubs(name) {
  const c = expenseCat(name);
  if (!hasSubs(c)) return newExpense(name);
  const salary = isSalaryCat(c.name);
  const subs = expenseSubs(c);
  openModal({
    title: `${c.emoji || '📦'} ${c.name}`,
    body: `<p class="muted small">${salary ? 'Kimga oylik berilyapti?' : 'Nima uchun?'}</p>
      <div class="exp-quick exp-subs">${subs.map((x) => `<button type="button" class="exp-tile" data-sub="${esc(x)}"><span>${esc(x)}</span></button>`).join('')}
        <button type="button" class="exp-tile exp-new" data-sub-new="1"><span class="exp-emoji">➕</span><span>${salary ? 'Yangi xodim qo\'shish' : 'Yangi qo\'shish'}</span></button>
        <button type="button" class="exp-tile exp-other" data-sub=""><span>${salary ? 'Ro\'yxatda yo\'q' : 'Boshqa (tanlamasdan)'}</span></button></div>`,
    onOpen: () => {
      $('#modalBody .exp-subs').addEventListener('click', async (e) => {
        const b = e.target.closest('.exp-tile');
        if (!b) return;
        let sub = b.dataset.sub;
        if (b.dataset.subNew) {
          sub = (prompt(salary ? 'Yangi xodim ismi:' : 'Yangi tugma nomi:') || '').trim();
          if (!sub) return;
          // Administrator qo'shgani ro'yxatda saqlanadi — keyingi safar tugma bo'lib chiqadi
          if (isAdmin() && !subs.some((x) => x.toLowerCase() === sub.toLowerCase())) {
            c.subs = [...(c.subs || []), sub];
            if (!db.expenseCats?.length) db.expenseCats = JSON.parse(JSON.stringify(DEFAULT_EXPENSE_CATS));
            commit(true);
          }
        }
        newExpense(c.name, sub);
      });
    },
  });
}

// Oylik oladigan xodimlar: Moddalar sahifasidagi ro'yxat + dastur foydalanuvchilari + avval oylik berilganlar
function staffNames() {
  const names = [...salarySubs(), ...db.users.filter((u) => u.active !== false).map((u) => u.name),
    ...db.payments.filter((p) => p.employee).map((p) => p.employee)];
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function newExpense(catName, sub = '') {
  if (!can('money') && !can('expenses')) return alert("Xarajat kiritish uchun ruxsatingiz yo'q.");
  const cats = expenseCatsList();
  const cat = catName || cats[0].name;
  const staff = staffNames();
  if (sub && isSalaryCat(cat) && !staff.includes(sub)) staff.push(sub);
  const subOpts = (name, chosen) => {
    const c = expenseCat(name);
    const list = hasSubs(c) && !isSalaryCat(name) ? expenseSubs(c) : [];
    if (chosen && list.length && !list.includes(chosen)) list.push(chosen);
    return list.length ? `<option value="">—</option>${list.map((x) => `<option ${x === chosen ? 'selected' : ''}>${esc(x)}</option>`).join('')}` : '';
  };
  openModal({
    title: 'Yangi xarajat',
    body: `<div class="form-grid">
        ${selectField('Moddasi', 'purpose', cats.map((c) => [c.name, `${c.emoji || '📦'} ${c.name}`]), cat, 'full')}
        ${moneyField('Summa *', 'amount', '', 'UZS', 'required')}
        ${field('Sana', 'date', today(), 'type="date" required')}
        ${selectField("To'lov usuli", 'method', Object.entries(PAY_METHODS), 'cash')}
        <label class="full" id="subLbl" ${subOpts(cat, sub) ? '' : 'hidden'}>Nima uchun<select name="sub">${subOpts(cat, sub)}</select></label>
        <div class="full salary-box" id="salaryBox" ${isSalaryCat(cat) ? '' : 'hidden'}>
          <div class="form-grid">
            ${staff.length ? `<label>Xodim<select name="employeeSel"><option value="">— ro'yxatdan tanlang —</option>${staff.map((n) => `<option ${n === sub && isSalaryCat(cat) ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new">+ Yangi xodim...</option></select></label>` : ''}
            <label id="empNewLbl" ${staff.length ? 'hidden' : ''}>${staff.length ? 'Yangi xodim ismi' : 'Xodim'}<input name="employee" autocomplete="off" placeholder="Ism familiya"></label>
            ${field('Qaysi oy uchun', 'forMonth', today().slice(0, 7), 'type="month"')}
          </div>
        </div>
        ${textArea('Izoh', 'note', '')}
      </div>`,
    onOpen: () => {
      const sel = $('#modalBody [name=purpose]');
      sel.addEventListener('change', () => {
        $('#salaryBox').hidden = !isSalaryCat(sel.value);
        const o = subOpts(sel.value, '');
        $('#modalBody [name=sub]').innerHTML = o;
        $('#subLbl').hidden = !o;
      });
      $('#modalBody [name=employeeSel]')?.addEventListener('change', (e) => {
        $('#empNewLbl').hidden = e.target.value !== '__new';
        if (e.target.value === '__new') $('#modalBody [name=employee]').focus();
      });
      setTimeout(() => $('#modalBody [name=amount]')?.focus(), 50);
    },
    onSubmit: async (d) => {
      const amount = num(d.amount);
      if (amount <= 0) { alert('Summani kiriting.'); return false; }
      const salary = isSalaryCat(d.purpose);
      if (d.employeeSel && d.employeeSel !== '__new') d.employee = d.employeeSel;
      if (salary && !d.employee.trim()) { alert('Oylik kimga berilganini kiriting.'); $('#modalBody [name=employee]').focus(); return false; }
      db.payments.push({
        id: uid(), no: await nextNo('payOut'), dir: 'out', expense: true, date: d.date, amount, method: d.method,
        purpose: d.purpose, counterpartyId: null, docId: null, note: d.note.trim(), userId: me?.id,
        employee: salary ? d.employee.trim() : undefined, forMonth: salary ? d.forMonth : undefined,
        sub: !salary && d.sub ? d.sub : undefined,
      });
      // Yangi xodim ismi oylik moddasining tugmalariga yoziladi (administrator) — keyingi safar tanlanadi
      const sc = salaryCat();
      if (salary && sc && isAdmin() && !salarySubs().includes(d.employee.trim())) {
        if (!db.expenseCats?.length) db.expenseCats = JSON.parse(JSON.stringify(DEFAULT_EXPENSE_CATS));
        const c = salaryCat();
        c.subs = [...(c.subs || []), d.employee.trim()];
      }
      await save();
    },
  });
}

function viewExpenses() {
  const cat = filterVal('expenses.cat');
  const q = filterVal('expenses.q').toLowerCase();
  const all = db.payments.filter((p) => isExpense(p) && inPeriod('expenses', p.date));
  const list = all
    .filter((p) => !cat || p.purpose === cat)
    .filter((p) => !q || [p.no, p.purpose, p.sub, p.note, p.employee].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.no).localeCompare(String(a.no)));
  const byCat = {};
  all.forEach((p) => { byCat[p.purpose] = (byCat[p.purpose] || 0) + p.amount; });
  const total = all.reduce((s, p) => s + p.amount, 0);
  const shown = list.reduce((s, p) => s + p.amount, 0);
  const max = Math.max(1, ...Object.values(byCat));
  const cats = expenseCatsList();
  const admin = isAdmin();
  const quick = `<div class="exp-quick">${cats.map((c) => `<button type="button" class="exp-tile" data-act="expTile" data-cat="${esc(c.name)}"><span class="exp-emoji">${c.emoji || '📦'}</span><span>${esc(c.name)}${hasSubs(c) ? ' ›' : ''}</span></button>`).join('')}</div>`;
  const summary = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([name, sum]) => `
    <button type="button" class="exp-row ${cat === name ? 'on' : ''}" data-act="expFilter" data-cat="${esc(name)}">
      <span class="exp-emoji">${expenseEmoji(name)}</span><span class="exp-name">${esc(name)}</span><b>${money(sum)}</b>
      <span class="exp-bar"><i style="width:${Math.round((sum / max) * 100)}%"></i></span></button>`).join('');
  const rows = list.map((p) => `<tr>
      <td>${fmtDate(p.date)}<div class="muted small">${esc(p.no || '')}</div></td>
      <td>${expenseEmoji(p.purpose)} ${esc(p.purpose)}${p.sub ? ` › <b>${esc(p.sub)}</b>` : ''}${p.employee ? `<div class="small"><b>${esc(p.employee)}</b>${p.forMonth ? ` · ${esc(p.forMonth)} oy uchun` : ''}</div>` : ''}</td>
      <td>${esc(p.note || '')}<div class="muted small">${esc(userName(p.userId))}</div></td>
      <td>${esc(PAY_METHODS[p.method] || '')}</td>
      <td class="num"><b>${money(p.amount)}</b></td>
      <td class="actions">${admin ? `<button class="small danger icon-only" data-act="deletePayment" data-id="${p.id}" title="O'chirish">${icon('trash')}</button>` : ''}</td></tr>`).join('');
  return `<p class="muted small exp-hint">Xarajat turini tanlang — summani kiriting:</p>${quick}`
    + toolbar('expenses', { extra: periodInputs('expenses'), buttons: `<button class="primary" data-act="newExpense">${icon('plus')}Xarajat</button>` })
    + `<div class="stats"><div class="stat"><div class="label">Davr bo'yicha jami xarajat</div><div class="value">${money(total)}</div></div>
        <div class="stat"><div class="label">Xarajatlar soni</div><div class="value">${all.length}</div></div></div>`
    + (summary ? `<div class="card"><h3>Moddalar bo'yicha${cat ? ` · <a href="javascript:void 0" data-act="expFilter" data-cat="">hammasini ko'rsatish</a>` : ''}</h3><div class="exp-sum">${summary}</div></div>` : '')
    + `<div class="card"><div class="table-wrap"><table><thead><tr><th>Sana</th><th>Moddasi</th><th>Izoh</th><th>Usul</th><th class="num">Summa</th><th></th></tr></thead>
      <tbody>${rows || emptyRow(6, "Bu davrda xarajat yo'q")}</tbody>
      ${list.length ? `<tfoot><tr><td colspan="4">Jami${cat ? ` (${esc(cat)})` : ''}</td><td class="num">${money(shown)}</td><td></td></tr></tfoot>` : ''}</table></div></div>`;
}

function viewExpenseCats() {
  const cats = db.expenseCats || [];
  return `<div class="card narrow ec-page"><h3>Xarajat moddalari</h3>
    <p class="muted small">Xarajatlar sahifasidagi tugmalar shu ro'yxatdan olinadi. «Ichida tugmalar» yoqilsa — modda bosilganda avval uning ichidagi tugmalar chiqadi (masalan, Kommunal → Elektr, Gaz). Oylik moddasida ichki tugmalar — xodimlar ismlari. Har bir o'zgarish o'zi saqlanadi.</p>
    <div class="exp-cats">${cats.map((c, i) => `<div class="ec-row" data-i="${i}">
      <div class="ec-head"><input class="ec-emoji" value="${esc(c.emoji || '')}" maxlength="4" aria-label="Belgi">
        <input class="ec-name" value="${esc(c.name)}" aria-label="Nomi">
        <button class="small danger icon-only" data-act="ecDel" data-i="${i}" title="O'chirish">${icon('trash')}</button></div>
      <label class="check ec-on"><input type="checkbox" class="ec-subs-on" ${c.subsOn ? 'checked' : ''}> Ichida tugmalar${isSalaryCat(c.name) ? ' (xodimlar)' : ''}</label>
      <div class="ec-subs" ${c.subsOn ? '' : 'hidden'}>${chipEditor(expenseSubs(c), isSalaryCat(c.name) ? "+ Xodim qo'shish (Enter)" : "+ Tugma qo'shish (Enter)")}</div>
    </div>`).join('')}</div>
    <div class="toolbar" style="margin-top:10px"><button data-act="ecAdd">${icon('plus')}Modda qo'shish</button><span id="ecSaved" class="lists-saved"></span><button class="primary" data-act="ecSave">Saqlash</button></div>
    <p class="muted small">Moddani yoki tugmani o'chirish, nomini o'zgartirish avval kiritilgan xarajatlarga ta'sir qilmaydi.</p></div>`;
}

function readExpenseCats() {
  const cats = $$('.exp-cats .ec-row').map((row) => {
    const name = $('.ec-name', row).value.trim();
    const subsOn = $('.ec-subs-on', row).checked;
    const subs = $$('.ec-subs .chip', row).map((c) => c.dataset.v);
    return { emoji: $('.ec-emoji', row).value.trim(), name, ...(subsOn || subs.length ? { subsOn, subs } : {}) };
  }).filter((c) => c.name);
  const names = new Set();
  const out = cats.filter((c) => !names.has(c.name) && names.add(c.name));
  // Avvalgi «Oylik oladigan xodimlar» ro'yxati endi oylik moddasining ichida
  if (out.some((c) => isSalaryCat(c.name))) db.staffNames = [];
  return out;
}

// Moddalar sahifasida har bir o'zgarishdan keyin o'zi saqlanadi
let ecTimer = null;
function scheduleEcSave() {
  if (!$('.ec-page') || !isAdmin()) return;
  clearTimeout(ecTimer);
  ecTimer = setTimeout(() => {
    ecTimer = null;
    if ($$('.ec-page .ec-name').some((i) => !i.value.trim())) return;
    db.expenseCats = readExpenseCats();
    commit(true);
    const el = $('#ecSaved');
    if (el) { el.textContent = '✓ Saqlandi'; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1800); }
  }, 700);
}
document.addEventListener('change', (e) => {
  if (!e.target.closest?.('.ec-page')) return;
  if (e.target.classList.contains('ec-subs-on')) $('.ec-subs', e.target.closest('.ec-row')).hidden = !e.target.checked;
  scheduleEcSave();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest?.('.ec-page .chip-add')) setTimeout(scheduleEcSave); });
document.addEventListener('click', (e) => { if (e.target.closest?.('.ec-page [data-act=chipRemove]')) setTimeout(scheduleEcSave); });
window.addEventListener('hashchange', () => { if (ecTimer) { clearTimeout(ecTimer); ecTimer = null; if ($('.ec-page') && !$$('.ec-page .ec-name').some((i) => !i.value.trim())) { db.expenseCats = readExpenseCats(); commit(true); } } }, true);

// ---------- Telegram ----------

function stockLine(p) {
  const total = qtyIn(computeStock(), p.id);
  if (total > 0) return db.telegram.showQty ? `✅ Omborda bor (${total} ${p.unit || 'dona'})` : '✅ Omborda bor';
  return "❌ Omborda yo'q (buyurtma asosida)";
}

// Telegram xabaridagi qatorlar — administrator Sozlamalar → Telegram da yoqib/o'chiradi
const TG_FIELDS = [
  ['type', 'Turi'], ['code', 'Kod (artikul)'], ['price', 'Narxi'], ['size', "O'lchami"], ['color', 'Rangi'],
  ['attrs', 'Xususiyatlar (material, mexanizm...)'], ['origin', 'Ishlab chiqarilgan joyi'], ['stock', "Omborda bor / yo'q"],
  ['note', 'Izoh'], ['phone', 'Kompaniya telefoni'], ['tags', 'Heshteglar (#kategoriya)'],
];
const tgShow = (k) => !db.telegram.hide?.[k];
// Belgi o'zgarsa — namuna xabar darhol yangilanadi (saqlash «Saqlash» tugmasi bilan)
document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('tg-field')) return;
  db.telegram.hide = Object.fromEntries($$('.tg-field').filter((c) => !c.checked).map((c) => [c.dataset.k, true]));
  const sample = db.products.find((p) => p.photos?.length) || db.products[0];
  const box = $('.tg-preview > div');
  if (box && sample) box.innerHTML = telegramCaption(sample).replace(/\n/g, '<br>');
});

function telegramCaption(p) {
  const lines = [`🛋 <b>${esc(p.name)}</b>`];
  if (p.type && tgShow('type')) lines.push(`🪑 Turi: ${esc(p.type)}`);
  if (p.code && tgShow('code')) lines.push(`🔖 Kod: ${esc(p.code)}`);
  if (tgShow('price')) lines.push(`💰 Narxi: <b>${priceLabel(p)}</b>`);
  if (p.size && tgShow('size')) lines.push(`📐 O'lchami: ${esc(p.size)} sm`);
  if (p.color && tgShow('color')) lines.push(`🎨 Rangi: ${esc(p.color)}`);
  if (tgShow('attrs')) productAttrs(p).forEach(([k, v]) => lines.push(`▫️ ${esc(k)}: ${esc(v)}`));
  if ((p.origin || p.maker) && tgShow('origin')) lines.push(`🏭 Ishlab chiqarilgan: ${esc([p.origin, p.maker].filter(Boolean).join(', '))}`);
  if (tgShow('stock')) lines.push(`📦 ${stockLine(p)}`);
  if (p.note && tgShow('note')) lines.push('', esc(p.note));
  if (db.company.phone && tgShow('phone')) lines.push('', `📞 ${esc(db.company.phone)}`);
  const tag = (t) => '#' + t.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  if ((p.category || p.type) && tgShow('tags')) lines.push([p.category, p.type].filter(Boolean).map(tag).join(' '));
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

// Temali (forum) guruh: har bir kategoriya o'z temasiga joylanadi. Tema bo'lmasa, bot uni o'zi yaratadi
// (botga «Mavzularni boshqarish» huquqi kerak). Tema raqamlari sozlamalarda saqlanadi.
// Tema nomi oldida kategoriyaga mos smaylik (oddiy emoji — hech qanday cheklov yo'q)
const TOPIC_TITLE_EMOJI = {
  bed: '🛏', mattress: '🛌', crib: '🧸', sofa: '🛋', armchair: '🛋', pouf: '🛋', tvStand: '📺',
  kitchen: '🍳', dining: '🍽', table: '🍽', chair: '🪑', officeChair: '💺', desk: '💼', bookshelf: '📚',
  wardrobe: '🚪', dresser: '🗄', mirror: '🪞', lamp: '💡', safe: '🔐', box: '📦',
};
const topicKey = (p) => p.category || 'Boshqa mahsulotlar';
function topicTitle(category) {
  const key = category === KIT_CATEGORY ? 'box' : category === 'Mehmonxona' ? 'sofa' : categoryIcon(category);
  return `${TOPIC_TITLE_EMOJI[key] || '🏠'} ${category}`.slice(0, 128);
}
// Tema ikonkasi: Telegram botlarga ruxsat bergan ikonkalardan kategoriyaga eng mosi (Premium shart emas).
// Ro'yxat getForumTopicIconStickers dan olinadi; birinchi mos kelgani tanlanadi.
const TOPIC_EMOJI = {
  bed: ['🛏', '🛌', '😴', '🏠'], mattress: ['🛏', '😴', '💤', '🏠'], crib: ['👶', '🧸', '🍼', '🏠'],
  sofa: ['🛋', '📺', '🏠'], armchair: ['🛋', '🏠'], pouf: ['🛋', '🏠'], tvStand: ['📺', '🛋', '🏠'],
  kitchen: ['🍽', '☕', '🍳', '🏠'], dining: ['🍽', '☕', '🏠'], table: ['🍽', '☕', '🏠'], chair: ['🪑', '🍽', '🏠'],
  officeChair: ['💼', '💻', '🏢'], desk: ['💼', '💻', '🏢'], bookshelf: ['📚', '📖', '🏠'],
  wardrobe: ['👔', '👗', '🧳', '👜', '🏠'], dresser: ['👜', '👔', '🏠'], mirror: ['💄', '💅', '🏠'],
  lamp: ['💡', '⚡', '🏠'], safe: ['🔒', '💰', '💎'], box: ['📦', '🛒', '🛍', '📁'],
};
let topicIconCache = null;
async function topicIconFor(category) {
  try {
    if (!topicIconCache) {
      const res = await telegramCall('getForumTopicIconStickers', {});
      topicIconCache = new Map(res.result.map((st) => [String(st.emoji || '').replace(/\uFE0F/g, ''), st.custom_emoji_id]));
    }
    const key = category === KIT_CATEGORY ? 'box' : categoryIcon(category);
    for (const e of [...(TOPIC_EMOJI[key] || []), '🏠', '📁']) {
      const id = topicIconCache.get(e.replace(/\uFE0F/g, ''));
      if (id) return id;
    }
  } catch (e) { /* ikonkasiz ham ishlaydi */ }
  return null;
}

// Mavjud temalarga ham ikonka qo'yish (Sozlamalar → Telegram)
async function tgTopicIcons() {
  tgReadForm();
  const topics = Object.entries(db.telegram.topics || {});
  if (!topics.length) return alert("Hali tema yo'q — avval «Temalarni hozir yaratish» ni bosing.");
  const errors = [];
  for (const [name, thread] of topics) {
    const icon_custom_emoji_id = await topicIconFor(name);
    try {
      await telegramCall('editForumTopic', Object.assign({ chat_id: db.telegram.chatId, message_thread_id: thread, name: topicTitle(name) }, icon_custom_emoji_id ? { icon_custom_emoji_id } : {}));
    } catch (e) {
      if (!/TOPIC_NOT_MODIFIED/i.test(e.message)) errors.push(`${name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  alert(errors.length ? 'Ba\'zilari o\'zgarmadi:\n' + errors.join('\n') : 'Temalar yangilandi: ikonka va smaylik qo\'yildi.');
}

async function telegramTopic(p, fresh = false) {
  const tg = db.telegram;
  if (!tg.useTopics) return null;
  tg.topics = tg.topics || {};
  const name = topicKey(p);
  if (tg.topics[name] && !fresh) return tg.topics[name];
  const icon = await topicIconFor(p.category || '');
  const res = await telegramCall('createForumTopic', Object.assign({ chat_id: tg.chatId, name: topicTitle(name) }, icon ? { icon_custom_emoji_id: icon } : {}));
  tg.topics[name] = res.result.message_thread_id;
  telegramLog(`Tema yaratildi: ${name}`, true);
  commit();
  return tg.topics[name];
}

async function telegramSend(p) {
  try {
    const thread = await telegramTopic(p);
    return { thread, msgIds: await telegramSendTo(p, thread) };
  } catch (e) {
    // Tema guruhda o'chirilgan bo'lsa — yangisini yaratib, qayta yuboramiz
    if (!db.telegram.useTopics || !/thread|topic/i.test(e.message)) throw e;
    const thread = await telegramTopic(p, true);
    return { thread, msgIds: await telegramSendTo(p, thread) };
  }
}

// E'lon «izi»: matn + rasmlar + guruh. Bir xil bo'lsa — qayta joylanmaydi
function postHash(p) {
  const str = [db.telegram.chatId, telegramCaption(p), ...(p.photos || []).map((ph) => ph.path)].join('|');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function deleteTgPost(post) {
  for (const id of post?.msgIds || []) {
    await telegramCall('deleteMessage', { chat_id: post.chat, message_id: id }).catch(() => {});
  }
}

async function telegramSendTo(p, thread) {
  const chatId = db.telegram.chatId;
  const th = thread ? { message_thread_id: thread } : {};
  const caption = telegramCaption(p);
  const fits = caption.length <= 1024; // rasm izohi chegarasi
  const blobs = [];
  for (const ph of (p.photos || []).slice(0, 10)) {
    const b = await backend.photoBlob(ph.path).catch(() => null);
    if (b) blobs.push(await toJpeg(b));
  }
  const ids = [];
  const take = (res) => (Array.isArray(res.result) ? res.result : [res.result]).forEach((m) => m?.message_id && ids.push(m.message_id));
  if (!blobs.length) {
    take(await telegramCall('sendMessage', { chat_id: chatId, ...th, text: caption, parse_mode: 'HTML' }));
    return ids;
  }
  const fd = new FormData();
  fd.append('chat_id', chatId);
  if (thread) fd.append('message_thread_id', thread);
  if (blobs.length === 1) {
    fd.append('photo', blobs[0], 'photo.jpg');
    if (fits) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    take(await telegramCall('sendPhoto', fd));
  } else {
    fd.append('media', JSON.stringify(blobs.map((b, i) => Object.assign(
      { type: 'photo', media: `attach://p${i}` },
      i === 0 && fits ? { caption, parse_mode: 'HTML' } : {},
    ))));
    blobs.forEach((b, i) => fd.append(`p${i}`, b, `p${i}.jpg`));
    take(await telegramCall('sendMediaGroup', fd));
  }
  if (!fits) take(await telegramCall('sendMessage', { chat_id: chatId, ...th, text: caption, parse_mode: 'HTML' }));
  return ids;
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
  let sent = 0;
  let same = 0;
  let wait = false;
  for (const id of list) {
    const p = product(id);
    if (!p) continue;
    // Bir xil rasm va matnli e'lon ikkinchi marta joylanmaydi
    const hash = postHash(p);
    const old = p.tgPost;
    if (old && old.hash === hash && old.chat === String(tg.chatId)) {
      const force = manual && list.length === 1 && confirm(`«${p.name}» shu ko'rinishda guruhda allaqachon bor.\n\nEskisini o'chirib, qayta joylansinmi?`);
      if (!force) { same++; continue; }
    }
    // Guruhga daqiqasiga ~20 xabardan ko'p yuborib bo'lmaydi
    if (wait) await new Promise((r) => setTimeout(r, 3500));
    wait = true;
    try {
      const { thread, msgIds } = await telegramSend(p);
      // Yangisi joylangach — avvalgi e'lon o'chiriladi (guruhda faqat bittasi qoladi)
      if (old?.msgIds?.length) await deleteTgPost(old);
      p.tgPost = { chat: String(tg.chatId), thread: thread || null, msgIds, hash, at: new Date().toISOString() };
      sent++;
      telegramLog(`${old ? 'Yangilandi' : 'Yuborildi'}: ${p.name}`, true);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      telegramLog(`Xato: ${p.name} — ${e.message}`, false);
    }
  }
  commit();
  if (errors.length) alert("Telegramga yuborilmadi:\n" + errors.join('\n'));
  else if (manual) alert(sent ? `Telegramga yuborildi: ${sent} ta.${same ? ` O'zgarmagan ${same} tasi qayta joylanmadi.` : ''}` : `Hammasi guruhda allaqachon bor — o'zgarmagani qayta joylanmadi (${same} ta).`);
}

function telegramOnStockIn(d) {
  telegramPostProducts(d.items.map((it) => it.productId), true);
}

// ---------- Telefonda tanlash ro'yxatlari (select) — butun ekranda ----------
// Android/iPhone'ning o'z tanlash oynasi ba'zan juda kichik ochiladi (2-3 qator ko'rinadi).
// Telefonda har qanday ro'yxat o'rniga dasturning o'z oynasi ochiladi: hamma variantlar ko'rinadi,
// uzun ro'yxatda qidiruv bor. Tanlangach select qiymati o'zgaradi va «change» hodisasi yuboriladi.
function selectLabel(sel) {
  const lbl = sel.closest('label');
  if (lbl) {
    const t = [...lbl.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (t) return t;
  }
  return sel.getAttribute('aria-label') || sel.title || 'Tanlang';
}

function openSelectSheet(sel) {
  let dlg = $('#selSheet');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'selSheet';
    dlg.className = 'sel-sheet';
    dlg.innerHTML = `<div class="ss-head"><b class="ss-title"></b><button type="button" class="ss-close" aria-label="Yopish">×</button></div>
      <input class="ss-search" type="search" placeholder="Qidirish..." autocomplete="off" hidden>
      <div class="ss-list" role="listbox"></div>`;
    document.body.appendChild(dlg);
  }
  const list = $('.ss-list', dlg);
  const search = $('.ss-search', dlg);
  const opts = [...sel.querySelectorAll('option')];
  $('.ss-title', dlg).textContent = selectLabel(sel);
  const draw = (q = '') => {
    const s = q.trim().toLowerCase();
    let html = '';
    let group = null;
    for (const o of opts) {
      if (o.hidden || (s && !o.textContent.toLowerCase().includes(s))) continue;
      const g = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
      if (g !== group) { group = g; if (g) html += `<div class="ss-group">${esc(g)}</div>`; }
      html += `<button type="button" class="ss-opt ${o.selected ? 'on' : ''}" data-i="${opts.indexOf(o)}" ${o.disabled ? 'disabled' : ''} role="option">${esc(o.textContent)}${o.selected ? icon('check') : ''}</button>`;
    }
    list.innerHTML = html || '<div class="ss-empty muted">Topilmadi</div>';
  };
  search.hidden = opts.length <= 8;
  search.value = '';
  draw();
  search.oninput = () => draw(search.value);
  list.onclick = (e) => {
    const b = e.target.closest('.ss-opt');
    if (!b || b.disabled) return;
    const o = opts[+b.dataset.i];
    dlg.close();
    if (sel.value !== o.value || !o.selected) {
      sel.value = o.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  $('.ss-close', dlg).onclick = () => dlg.close();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); }; // fon bosilsa yopiladi
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); // klaviatura yopilsin
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => list.querySelector('.ss-opt.on')?.scrollIntoView({ block: 'center' }));
}

(function bindSelectSheets() {
  const usable = (sel) => sel && !sel.multiple && !sel.disabled && !sel.closest('fieldset[disabled]') && isTouch() && sel.options.length > 0;
  let start = null;
  document.addEventListener('touchstart', (e) => {
    const sel = e.target.closest?.('select');
    start = usable(sel) ? { sel, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const moved = Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10;
    const sel = start.sel;
    start = null;
    if (moved) return; // barmoq surilgan — sahifa aylantirilmoqda
    e.preventDefault(); // tizimning kichik oynasi ochilmasin
    openSelectSheet(sel);
  }, { passive: false });
  // Sichqoncha bilan (kichik ekranli kompyuter) — ham shu oyna
  document.addEventListener('mousedown', (e) => {
    const sel = e.target.closest?.('select');
    if (!usable(sel) || e.sourceCapabilities?.firesTouchEvents) return;
    e.preventDefault();
    openSelectSheet(sel);
  });
})();

// ---------- Shtrix-kod / QR skaner (kamera) ----------
// Telefonda: Chrome/Android'da brauzerning o'z BarcodeDetector'i, qolganlarida (iPhone) — ZXing kutubxonasi.
// Etiketkalarda shtrix-kod va QR ichida mahsulot artikuli yozilgan; zavod shtrix-kodlari (EAN) ham o'qiladi.
let zxingLoad = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  zxingLoad = zxingLoad || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/zxing.min.js';
    sc.onload = res;
    sc.onerror = () => { zxingLoad = null; rej(new Error("Skaner kutubxonasi yuklanmadi")); };
    document.head.appendChild(sc);
  });
  return zxingLoad;
}

async function makeDecoder() {
  const formats = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'upc_e', 'itf', 'data_matrix'];
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const det = new window.BarcodeDetector({ formats: formats.filter((f) => supported.includes(f)) });
      return async (video) => (await det.detect(video))[0]?.rawValue || '';
    } catch (e) { /* ZXing ga o'tamiz */ }
  }
  await loadZxing();
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.ITF, Z.BarcodeFormat.DATA_MATRIX]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return '';
    const scale = Math.min(1, 960 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decode(bmp).getText();
    } catch (e) {
      return '';
    } finally {
      reader.reset();
    }
  };
}

// Kamerani ochib, kodni o'qiydi. Natija — matn (bekor qilinsa null).
function scanCode(title = 'Shtrix-kod yoki QR-kodni ramkaga to\'g\'rilang') {
  return new Promise((resolve) => {
    let dlg = $('#scanner');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'scanner';
      dlg.className = 'scanner';
      dlg.innerHTML = `<video playsinline muted autoplay></video><div class="sc-frame"><i></i></div>
        <div class="lb-top"><span class="sc-title"></span><span class="lb-gap"></span>
          <button type="button" class="lb-btn sc-torch" title="Chiroq" hidden>💡</button>
          <button type="button" class="lb-btn sc-close" title="Yopish">×</button></div>
        <div class="sc-msg"></div>
        <div class="sc-manual"><input class="sc-input" placeholder="yoki kodni qo'lda yozing" autocomplete="off"><button type="button" class="sc-ok">OK</button></div>`;
      document.body.appendChild(dlg);
    }
    const video = $('video', dlg);
    const msg = $('.sc-msg', dlg);
    $('.sc-title', dlg).textContent = title;
    $('.sc-input', dlg).value = '';
    msg.textContent = 'Kamera yoqilmoqda...';
    let stream = null;
    let done = false;
    let timer = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      if (dlg.open) dlg.close();
      resolve(val ? String(val).trim() : null);
    };
    dlg.onclose = () => finish(null);
    $('.sc-close', dlg).onclick = () => finish(null);
    $('.sc-ok', dlg).onclick = () => finish($('.sc-input', dlg).value);
    $('.sc-input', dlg).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(e.target.value); } };
    dlg.showModal();
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Bu qurilmada kamera ishlamaydi — kodni pastga qo'lda yozing."; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        msg.textContent = /denied|NotAllowed/i.test(e.name + e.message)
          ? "Kameraga ruxsat berilmagan. Telefon sozlamalarida brauzerga kamera ruxsatini bering."
          : 'Kamera ochilmadi: ' + e.message;
        return;
      }
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const torchBtn = $('.sc-torch', dlg);
      torchBtn.hidden = !track.getCapabilities?.().torch;
      let torch = false;
      torchBtn.onclick = () => { torch = !torch; track.applyConstraints({ advanced: [{ torch }] }).catch(() => {}); };
      let decode;
      try { decode = await makeDecoder(); } catch (e) { msg.textContent = e.message; return; }
      msg.textContent = 'Qidirilmoqda...';
      const tick = async () => {
        if (done) return;
        const val = await decode(video).catch(() => '');
        if (val) {
          if (navigator.vibrate) navigator.vibrate(60);
          return finish(val);
        }
        timer = setTimeout(tick, 120);
      };
      tick();
    })();
  });
}

// O'qilgan kod bo'yicha mahsulot: artikul (katta-kichik harf farqsiz), so'ng nomi
function productByScan(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const list = db.products.filter((p) => !p.archived);
  return list.find((p) => (p.code || '').trim().toLowerCase() === t)
    || list.find((p) => p.name.trim().toLowerCase() === t)
    || null;
}

// Hujjat va komplekt qatorlaridagi 📷 tugma: skanerlab, mahsulotni qatorga qo'yadi
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.it-scan');
  if (!btn || btn.dataset.act) return;
  e.preventDefault();
  if (btn.classList.contains('code-scan')) {
    // Mahsulot kartochkasi: zavod shtrix-kodini artikul maydoniga yozish
    const field = btn.parentElement.querySelector('input');
    const code = await scanCode('Mahsulotdagi shtrix-kodni ramkaga to\'g\'rilang');
    if (code) { field.value = code; field.dispatchEvent(new Event('input', { bubbles: true })); }
    return;
  }
  const input = btn.closest('.it-pick').querySelector('.it-search');
  const code = await scanCode();
  if (!code) return;
  const p = productByScan(code);
  picker.input = input;
  if (p && (pickKits || !isKit(p))) {
    choosePickedProduct(p);
  } else {
    // Topilmadi — kod qidiruvga yoziladi: o'xshashlari yoki «yangi mahsulot sifatida kirim» chiqadi
    input.focus();
    input.value = code;
    renderPicker();
  }
});

// ---------- Yetkazib berish: yopilmagan sotuvlar, shofyorlar, pul topshirish ----------
// Sotuv «Yetkazilishi kerak» yoki «Yo'lda» bo'lsa — u hali yopilmagan: ro'yxatda rang bilan ajraladi,
// sotuvchi va administratorga eslatma chiqadi. Mijozga yetib borgach «Yetkazildi» qilinadi
// (shofyor bot orqali belgilasa — avtomatik).
const OPEN_STATUSES = ['pending', 'onway'];
const isOpenSale = (d) => d.type === 'sale' && OPEN_STATUSES.includes(d.status);
const daysSince = (date) => Math.floor((Date.parse(today()) - Date.parse(date)) / 864e5);
// Muddati o'tgan: yetkazish sanasi o'tgan, sanasi bo'lmasa — 2 kundan ko'p
const isOverdueSale = (d) => isOpenSale(d) && (d.deliveryDate ? d.deliveryDate < today() : daysSince(d.date) > 2);
const openSales = () => db.docs.filter(isOpenSale).sort((a, b) => (a.deliveryDate || a.date).localeCompare(b.deliveryDate || b.date));
const driver = (id) => (db.drivers || []).find((x) => x.id === id);
const driverChat = (id) => (db.driverChats || []).find((x) => x.driver_id === id);
// Shofyor olgan, lekin hali kassaga topshirilmagan pul
const pendingHandovers = () => db.payments.filter((p) => p.handover?.status === 'pending');
const myHandovers = () => pendingHandovers().filter((p) => isAdmin() || p.handover.to === me?.id);

function openSalesCard() {
  if (!can('sale')) return '';
  const list = openSales();
  if (!list.length) return '';
  return `<div class="card open-sales"><h3>${icon('clock')}Yopilmagan sotuvlar <span class="badge-count">${list.length}</span></h3>
    <p class="muted small">Mijozga yetib borgach «Yetkazildi» qiling — shundagina sotuv to'liq yopiladi.</p>
    <div class="table-wrap"><table><thead><tr><th>Hujjat</th><th>Mijoz</th><th>Holati</th><th>Qoldi</th><th></th></tr></thead><tbody>
    ${list.map((d) => {
      const rest = Math.max(0, docTotal(d) - docPaid(d));
      const late = isOverdueSale(d);
      return `<tr class="click sale-${d.status} ${late ? 'sale-late' : ''}" data-act="openDoc" data-id="${d.id}">
        <td><b>${esc(d.no)}</b><div class="muted small">${fmtDate(d.date)} · ${esc(userName(d.userId))}</div></td>
        <td>${esc(party(d.counterpartyId)?.name || '')}<div class="muted small">${esc(d.address || '')}</div></td>
        <td>${badge(DELIVERY_STATUSES[d.status], d.status)}${late ? `<div class="debt small">⚠ ${d.deliveryDate ? `muddat ${fmtDate(d.deliveryDate)}` : `${daysSince(d.date)} kun`}</div>` : d.deliveryDate ? `<div class="muted small">${fmtDate(d.deliveryDate)}</div>` : ''}${d.driverId ? `<div class="muted small">🚚 ${esc(driver(d.driverId)?.name || '')}</div>` : ''}</td>
        <td class="num">${rest ? money(rest) : badge("To'langan", 'done')}</td>
        <td class="actions"><button class="small primary" data-act="closeSale" data-id="${d.id}">${icon('check')}Yetkazildi</button></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}

function handoverCard() {
  const list = myHandovers();
  if (!list.length) return '';
  return `<div class="card handover-card"><h3>${icon('cash')}Shofyordan pul qabul qilish</h3>
    ${list.map((p) => `<div class="ho-row"><span>🚚 <b>${esc(p.handover.driverName || 'Shofyor')}</b> ${isAdmin() && p.handover.to && p.handover.to !== me.id ? `${esc(userName(p.handover.to))}ga` : 'sizga'} <b>${money(p.amount)}</b> topshiradi
      <span class="muted small">· ${esc(doc(p.docId)?.no || '')} · ${esc(party(p.counterpartyId)?.name || '')}</span></span>
      <button class="small primary" data-act="acceptHandover" data-id="${p.id}">${icon('check')}Qabul qildim</button></div>`).join('')}</div>`;
}

// Har bir sahifa tepasidagi eslatma
function renderAlertBanner() {
  const el = $('#alertBanner');
  if (!el) return;
  const parts = [];
  const ho = me ? myHandovers() : [];
  if (ho.length) parts.push(`💵 Shofyordan qabul qilinadigan pul: <b>${money(ho.reduce((s, p) => s + p.amount, 0))}</b>`);
  if (me && can('sale')) {
    const open = openSales();
    const late = open.filter(isOverdueSale).length;
    if (open.length) parts.push(`⏳ Yopilmagan sotuv: <b>${open.length}</b>${late ? ` · <span class="late">muddati o'tgan: ${late}</span>` : ''}`);
  }
  el.hidden = !parts.length;
  el.classList.toggle('urgent', parts.some((x) => x.includes('late')) || ho.length > 0);
  el.innerHTML = parts.length ? `<a href="#dashboard">${parts.join(' &nbsp;·&nbsp; ')} — <u>ko'rish</u></a>` : '';
}

async function closeSale(id) {
  const d = doc(id);
  if (!d) return;
  const rest = Math.max(0, docTotal(d) - docPaid(d));
  if (!confirm(`${d.no}: mijozga yetkazib berildimi? Sotuv yopiladi.${rest ? `\n\nMijozdan olinadigan: ${money(rest)} — keyingi oynada to'lovni kiriting.` : ''}`)) return;
  d.status = 'delivered';
  d.delivered = Object.assign({ at: new Date().toISOString(), by: me?.id }, d.delivered);
  await save();
  if (rest) newPayment('in', { counterpartyId: d.counterpartyId, docId: d.id });
}

async function acceptHandover(pid) {
  const p = db.payments.find((x) => x.id === pid);
  if (!p) return;
  if (!confirm(`Shofyor ${p.handover.driverName || ''}dan ${money(p.amount)} qabul qildingizmi?`)) return;
  try {
    if (backend.kind === 'supabase') await backend.acceptHandover(pid);
    p.handover = Object.assign({}, p.handover, { status: 'received', receivedAt: new Date().toISOString(), receivedBy: me?.id });
    await save();
  } catch (e) {
    alert('Xato: ' + e.message);
  }
}

// Sotuvni shofyorga Telegram orqali yuborish (server bot)
async function sendToDriver(docId, driverId, quiet = false) {
  if (backend.kind !== 'supabase') return quiet || alert("Shofyorga Telegram orqali yuborish faqat server rejimida ishlaydi.");
  try {
    await commitQueue; // sotuv avval serverga yozilsin
    await backend.botCall({ action: 'send', docId, driverId });
    if (!quiet) alert(`Buyurtma shofyor ${driver(driverId)?.name || ''}ga Telegram orqali yuborildi.`);
    return true;
  } catch (e) {
    alert(`Shofyorga yuborilmadi: ${e.message}`);
    return false;
  }
}

// --- Sozlamalar → Shofyorlar ---
function driverLink(d) {
  const bot = db.telegram.botUsername;
  return bot ? `https://t.me/${bot}?start=d_${d.id}` : '';
}

function viewDrivers() {
  const list = db.drivers || [];
  const server = backend.kind === 'supabase';
  const ready = server && db.telegram.webhook && db.telegram.botUsername;
  return `<div class="card narrow"><h3>${icon('truck')}Shofyorlar</h3>
    <p class="muted small">Sotuvda «Yetkazib beriladi» belgilanib shofyor tanlansa — buyurtma ma'lumotlari (mijoz, telefon, manzil, mahsulotlar, olinadigan pul) shofyorning Telegramiga boradi. Shofyor botda «Yetkazib berdim» ni bosib, <b>majburiy surat</b> yuboradi va olgan pulini belgilaydi — sotuv o'zi yopiladi, pul esa mas'ul xodimga «qabul qilib ol» deb ko'rsatiladi.</p>
    ${!server ? `<p class="debt">Bu imkoniyat faqat server rejimida ishlaydi.</p>`
      : !db.telegram.token ? `<p class="debt">Avval Sozlamalar → Telegram da bot tokenini kiriting.</p>`
      : `<div class="toolbar"><button class="${ready ? '' : 'primary'}" data-act="botSetup">${icon('send')}${ready ? `Bot ulangan: @${esc(db.telegram.botUsername)} (qayta ulash)` : 'Botni shofyorlar uchun ulash'}</button></div>`}
    <table class="drv-table"><tbody>${list.map((d) => {
      const ch = driverChat(d.id);
      const link = driverLink(d);
      return `<tr><td><b>${esc(d.name)}</b><div class="muted small">${esc(d.phone || '')}${d.car ? ' · ' + esc(d.car) : ''}</div></td>
        <td>${ch ? badge('Telegram ulangan', 'done') + `<div class="muted small">${esc(ch.tg_name || '')}</div>` : badge('Ulanmagan', 'cancel')}</td>
        <td class="actions">${link && !ch ? `<button class="small" data-act="drvLink" data-id="${d.id}">${icon('share')}Havola</button>` : ''}
          <button class="small icon-only" data-act="drvEdit" data-id="${d.id}" title="Tahrirlash">${icon('edit')}</button>
          <button class="small danger icon-only" data-act="drvDel" data-id="${d.id}" title="O'chirish">${icon('trash')}</button></td></tr>`;
    }).join('') || emptyRow(3, "Shofyor qo'shilmagan")}</tbody></table>
    <div class="toolbar" style="margin-top:10px"><button class="primary" data-act="drvEdit">${icon('plus')}Shofyor qo'shish</button></div>
    <ol class="muted small"><li>Shofyorni qo'shing (ism, telefon).</li><li>«Havola» ni bosib, uni shofyorga yuboring (Telegram yoki SMS orqali).</li><li>Shofyor havolani ochib <b>START</b> ni bosadi — «Telegram ulangan» bo'ladi.</li></ol></div>`;
}

function editDriver(id) {
  const d = id ? driver(id) : null;
  openModal({
    title: d ? 'Shofyor' : "Yangi shofyor",
    body: `<div class="form-grid">${field('Ism familiya *', 'name', d?.name, 'required', 'full')}${phoneField('Telefon', 'phone', d?.phone || '')}${field('Mashina', 'car', d?.car, 'placeholder="Masalan: Labo, 01 A 123 BC"')}</div>`,
    onSubmit: async (f) => {
      db.drivers = db.drivers || [];
      const x = d || { id: uid() };
      Object.assign(x, { name: f.name.trim(), phone: f.phone.trim(), car: f.car.trim() });
      if (!d) db.drivers.push(x);
      await save();
      if (!d && driverLink(x)) setTimeout(() => shareDriverLink(x.id), 200);
    },
  });
}

async function shareDriverLink(id) {
  const d = driver(id);
  const link = driverLink(d);
  if (!link) return alert("Avval «Botni shofyorlar uchun ulash» tugmasini bosing.");
  const text = `Assalomu alaykum, ${d.name}! KAO Mebel yetkazish buyurtmalari Telegramingizga kelishi uchun shu havolani oching va START ni bosing:\n${link}`;
  try {
    if (navigator.share) return await navigator.share({ text });
  } catch (e) { /* bekor qilindi */ }
  try { await navigator.clipboard.writeText(link); alert("Havola nusxalandi — shofyorga yuboring:\n" + link); } catch (e) { prompt('Havolani nusxalang:', link); }
}

async function botSetup() {
  showLoading(true, 'Bot ulanmoqda...');
  try {
    const r = await backend.botCall({ action: 'setup' });
    Object.assign(db.telegram, { webhook: true, botUsername: r.botUsername });
    await save();
    alert(`Bot ulandi: @${r.botUsername}. Endi shofyorlarga havola yuboring.`);
  } catch (e) {
    alert('Xato: ' + e.message);
  } finally {
    showLoading(false);
  }
}

// Bot webhook rejimida getUpdates ishlamaydi — chatlar server jadvalidan olinadi
async function botUpdates() {
  if (backend.kind === 'supabase' && db.telegram.webhook) {
    const rows = await backend.botChats();
    return rows.reverse().map((r) => ({ message: { chat: { id: Number(r.chat_id), type: r.type, title: r.title, first_name: r.title, is_forum: r.is_forum } } }));
  }
  const res = await fetch(`https://api.telegram.org/bot${db.telegram.token}/getUpdates`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description);
  return json.result;
}

// ---------- Ko'rinishlar (sahifalar) ----------

// Uchinchi element 'A' — faqat administrator ko'radi
const SECTIONS = [
  { id: 'dashboard', icon: 'dashboard', title: "Ko'rsatkichlar" },
  { id: 'purchases', icon: 'truck', title: 'Xaridlar', views: [['purchaseOrder', '', 'purchase'], ['receipt', '', 'purchase'], ['purchaseReturn', '', 'purchase']] },
  { id: 'sales', icon: 'bag', title: 'Savdo', views: [['order', '', 'sale'], ['sale', '', 'sale'], ['salesReturn', '', 'sale']] },
  { id: 'goods', icon: 'sofa', title: 'Tovarlar', views: [['products', 'Mahsulotlar'], ['kits', 'Komplektlar'], ['stock', 'Qoldiqlar'], ['enter', '', 'enter'], ['writeoff', '', 'stockOps'], ['move', '', 'stockOps'], ['inventory', '', 'stockOps'], ['warehouses', 'Omborlar', 'A'], ['labels', 'Etiketkalar'], ['labelDesign', 'Etiketka dizayni', 'A']] },
  { id: 'parties', icon: 'users', title: 'Kontragentlar', views: [['customers', 'Mijozlar', 'sale|money'], ['suppliers', "Ta'minotchilar", 'purchase|products|money'], ['debts', 'Qarzlar', 'money']] },
  { id: 'money', icon: 'wallet', title: 'Pul', views: [['payments', "To'lovlar", 'sale|money'], ['cash', 'Kassa va hisoblar', 'money']] },
  { id: 'expenses', icon: 'arrowOut', title: 'Xarajatlar', views: [['expenses', 'Xarajatlar', 'money|expenses'], ['expenseCats', 'Moddalar', 'A']] },
  { id: 'reports', icon: 'chart', title: 'Hisobotlar', views: [['profit', 'Foyda va zarar', 'reports'], ['top', 'Savdo tahlili', 'reports']] },
  { id: 'install', icon: 'phone', title: "Telefonga o'rnatish", hideInNav: true },
  { id: 'settings', icon: 'settings', title: 'Sozlamalar', views: [['users', 'Foydalanuvchilar', 'A'], ['currency', 'Valyuta kursi', 'A'], ['server', 'Server', 'A'], ['telegram', 'Telegram', 'A'], ['company', 'Kompaniya', 'A'], ['categories', "Ro'yxatlar", 'A'], ['backup', 'Zaxira nusxa', 'A'], ['drivers', 'Shofyorlar', 'A'], ['layout', 'Interfeys', 'A'], ['profile', 'Profil']] },
];

function viewTitle(v) {
  return v[1] || DOC_TYPES[v[0]].list;
}

const canView = (need) => !need || isAdmin() || (need !== 'A' && need.split('|').some(can));
// Administrator belgilagan tartib (Sozlamalar → Interfeys); ro'yxatda yo'qlari oxirida, asl tartibida
function orderBy(list, keys, keyOf) {
  if (!keys?.length) return list;
  const pos = (x) => { const i = keys.indexOf(keyOf(x)); return i < 0 ? keys.length : i; };
  return list.map((x, i) => [x, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(([x]) => x);
}
const visibleViews = (s) => s.views && orderBy(s.views.filter((v) => canView(v[2])), db.uiOrder?.tabs?.[s.id], (v) => v[0]);
const visibleSections = () => orderBy(SECTIONS.filter((s) => (s.admin ? isAdmin() : !s.views || visibleViews(s).length)), db.uiOrder?.sections, (s) => s.id);

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

const SCAN_VIEWS = ['products', 'stock', 'labels', 'kits'];
function toolbar(view, { search = true, buttons = '', extra = '' } = {}) {
  return `<div class="toolbar">
    ${search ? `<input data-filter="${view}.q" placeholder="Qidirish..." value="${esc(filterVal(view + '.q'))}">` : ''}
    ${search && SCAN_VIEWS.includes(view) ? `<button type="button" class="icon-only it-scan" data-act="scanFilter" data-view="${view}" title="Shtrix-kod / QR bilan qidirish" aria-label="Skaner">${icon('scan')}</button>` : ''}
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
  const stockValue = db.products.filter((p) => !isKit(p)).reduce((s, p) => s + Math.max(0, qtyIn(ctx.stock, p.id)) * ctx.cost[p.id], 0);
  const activeOrders = db.docs.filter((d) => d.type === 'order' && RESERVING.includes(d.status));

  const mySales = sales.filter((d) => d.date.startsWith(month) && d.userId === me.id);
  const cards = (can('money') && can('costs')) ? [
    ['Bugungi savdo', money(daySales), `${sales.filter((d) => d.date === t).length} ta sotuv`],
    ['Shu oy savdosi', money(monthTotal), `${monthSales.length} ta sotuv`],
    ['Shu oy yalpi foydasi', money(gross), 'savdo − tannarx'],
    ['Pul qoldig\'i', money(cashTotal(cash)), `kassa ${fmt(cash.cash || 0)} · karta ${fmt(cash.card || 0)} · terminal ${fmt(cash.terminal || 0)} · hisob ${fmt(cash.bank || 0)}`],
    ['Bizga qarzlar', money(receivable), 'debitorlik', 'debt'],
    ['Bizning qarzlar', money(payable), 'kreditorlik', 'warn'],
    ['Ombordagi tovar', money(stockValue), `${db.products.length} xil mahsulot`],
    ['Faol buyurtmalar', activeOrders.length, `${money(sumOf(activeOrders))}`],
  ] : [
    ...(can('sale') ? [
      ['Bugungi savdo', money(daySales), `${sales.filter((d) => d.date === t).length} ta sotuv`],
      ['Mening savdom (shu oy)', money(sumOf(mySales)), `${mySales.length} ta sotuv`],
      ['Faol buyurtmalar', activeOrders.length, `${money(sumOf(activeOrders))}`],
      ['Mijozlar qarzi', money(receivable), 'undirilishi kerak', 'debt'],
    ] : []),
    ...(can('money') ? [['Pul qoldig\'i', money(cashTotal(cash)), `kassa ${fmt(cash.cash || 0)} · karta ${fmt(cash.card || 0)} · terminal ${fmt(cash.terminal || 0)} · hisob ${fmt(cash.bank || 0)}`], ['Bizning qarzlar', money(payable), 'kreditorlik', 'warn']] : []),
    ...(can('costs') ? [['Ombordagi tovar', money(stockValue), `${db.products.length} xil mahsulot`]] : []),
    ...(!can('sale') ? [['Mahsulotlar', db.products.filter((p) => !p.archived).length, 'faol mahsulot']] : []),
  ];
  const quick = [
    ['sale', 'Sotish', 'bag', 'primary'], ['order', 'Buyurtma', 'receipt'], ['receipt', 'Qabul qilish', 'truck'], ['enter', 'Kirim qilish', 'arrowIn'],
  ].filter(([type]) => canUseDoc(type))
    .map(([type, label, ic, cls]) => `<button class="${cls || ''}" data-act="newDoc" data-type="${type}">${icon(ic)}${label}</button>`).join('') +
    (canAddProducts() ? `<button data-act="newProduct">${icon('sofa')}Mahsulot</button>` : '') +
    (can('sale') || can('money') ? `<button data-act="newPayment" data-dir="in">${icon('arrowIn')}Kirim to'lovi</button>` : '') +
    (can('money') ? `<button data-act="newPayment" data-dir="out">${icon('arrowOut')}Xarajat</button>` : '');

  const low = db.products.filter((p) => !p.archived && !isKit(p) && qtyIn(ctx.stock, p.id) - qtyIn(ctx.reserve, p.id) <= (p.minQty || 0));
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
  // Brauzer ilova qilib o'rnatishni taklif qilsa — bosh sahifada bitta tugma
  const installCard = installPrompt && !isStandalone()
    ? `<div class="card install-card">${icon('download')}<div><b>Biznes Tizim'ni kompyuterga ilova qilib o'rnating</b>
        <div class="muted small">Ish stolida ikonka paydo bo'ladi, dastur alohida oynada ochiladi.</div></div>
        <button class="primary" data-act="installApp">${icon('download')}O'rnatish</button></div>` : '';

  // Zaxira eskirgan bo'lsa — administratorga eslatma
  const age = backupAgeDays();
  const backupWarn = isAdmin() && age > 2
    ? `<div class="card warn-card backup-warn">${icon('alert')}<span>${age === Infinity ? "Hali birorta ham zaxira nusxa olinmagan." : `Oxirgi zaxira nusxa ${Math.floor(age)} kun oldin olingan.`} Ma'lumot yo'qolmasligi uchun zaxira oling${db.telegram.backupChatId ? '' : ' yoki har kungi avtomatik zaxirani yoqing'}.</span>
        <button class="small primary" data-act="backup">${icon('download')}Zaxira olish</button><a href="#settings/backup">Sozlash</a></div>` : '';
  return installCard + backupWarn + usageWarn + handoverCard() + openSalesCard() + `<div class="stats">${cards.map(([l, v, h, cls]) => `<div class="stat">
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
    ${(() => {
      // Sotuvchi faqat o'zi mas'ul bo'lgan qarzlarni ko'radi
      const mine = saleDebts().filter(({ d }) => can('money') || d.debtResponsible === me.name || (!d.debtResponsible && d.userId === me.id));
      if (!mine.length) return '';
      const late = mine.filter(({ d }) => d.debtDue && d.debtDue < today());
      return `<div class="card"><h3>${icon('alert')}Qarz muddatlari — ${mine.length} ta, ${money(mine.reduce((s, x) => s + x.rest, 0))}${late.length ? ` <span class="badge cancel">${late.length} tasi muddati o'tgan</span>` : ''}</h3>
        <div class="table-wrap"><table><thead><tr><th>Mijoz</th><th>Sotuv</th><th class="num">Qarz</th><th>Qachon beradi</th><th>Mas'ul</th><th></th></tr></thead>
        <tbody>${debtRows(mine.slice(0, 8))}</tbody></table></div></div>`;
    })()}
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
    .filter((d) => !q || [d.no, party(d.counterpartyId)?.name, party(d.counterpartyId)?.phone, d.note, ...d.items.map(itemName)].join(' ').toLowerCase().includes(q) || phoneMatch(party(d.counterpartyId)?.phone, q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no));

  const statusFilter = t.statuses
    ? `<select data-filter="${type}.status"><option value="">Barcha holatlar</option>${Object.entries(t.statuses).map(([k, v]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${v}</option>`).join('')}</select>`
    : '';
  const cols = ['№', 'Sana', t.party ? 'Kontragent' : 'Ombor', 'Mahsulotlar', 'Summa'];
  const isOrder = type === 'order';
  if (t.pay) cols.push(isOrder ? "Zaklad / qolgan" : "To'langan");
  if (isOrder) cols.push('Muddat', "Mas'ul");
  if (t.statuses) cols.push('Holati');
  if (isOrder) cols.push('');
  // Inventarizatsiyada summa yo'q; tannarx ruxsati yo'q xodimga kirim summasi ko'rsatilmaydi
  const noSum = type === 'inventory' || hidesCost(t);
  const total = list.reduce((s, d) => s + (noSum ? 0 : docTotal(d)), 0);

  const rows = list.map((d) => {
    const paid = t.pay ? docPaid(d) : 0;
    const where = t.party ? esc(party(d.counterpartyId)?.name) : esc(warehouse(d.warehouseId)?.name) + (t.move ? ' → ' + esc(warehouse(d.toWarehouseId)?.name) : '');
    return `<tr class="click ${isOpenSale(d) ? `sale-${d.status}` : ''} ${isOverdueSale(d) ? 'sale-late' : ''}" data-act="openDoc" data-id="${d.id}">
      <td>${esc(d.no)}${isOverdueSale(d) ? '<div class="debt small">⚠ yopilmagan</div>' : ''}</td><td>${fmtDate(d.date)}${d.userId ? `<div class="muted small">${esc(userName(d.userId))}</div>` : ''}</td><td>${where}</td>
      <td class="items-cell">${d.items.slice(0, 3).map((it) => `${esc(itemName(it))} × ${it.qty}`).join('<br>')}${d.items.length > 3 ? `<br><span class="muted">yana ${d.items.length - 3} ta</span>` : ''}</td>
      <td class="num">${noSum ? '' : money(docTotal(d))}${d.currency === 'USD' ? `<div class="muted small">${fmtUsd(docTotalCur(d))} · ${fmtRate(d.rate)}</div>` : ''}</td>
      ${t.pay ? (isOrder
        ? `<td class="num">${fmt(paid)}<div class="small ${docTotal(d) - paid > 0 ? 'debt' : 'ok'}">qoldi ${fmt(Math.max(0, docTotal(d) - paid))}</div></td>`
        : `<td class="num">${paid >= docTotal(d) && paid > 0 ? badge("To'langan", 'done') : paid > 0 ? fmt(paid) : badge("To'lanmagan", 'cancel')}</td>`) : ''}
      ${isOrder ? `<td class="${d.deliveryDate && d.deliveryDate < today() && RESERVING.includes(d.status) ? 'debt' : ''}">${fmtDate(d.deliveryDate)}${d.orderKind === 'custom' ? '<div class="muted small">individual</div>' : ''}</td><td>${esc(d.responsible || '')}</td>` : ''}
      ${t.statuses ? `<td>${badge(t.statuses[d.status] || '', d.status)}</td>` : ''}
      ${isOrder ? `<td class="actions"><button class="small icon-only" data-act="contract" data-id="${d.id}" title="Shartnomani chop etish">${icon('file')}</button></td>` : ''}
    </tr>`;
  }).join('');

  return toolbar(type, {
    extra: periodInputs(type) + statusFilter,
    buttons: `<button class="primary" data-act="newDoc" data-type="${type}">${icon('plus')}${esc(t.add || t.one)}</button>${isAdmin() ? `<button data-act="exportDocs" data-type="${type}">${icon('download')}CSV</button>` : ''}`,
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th class="${i === 4 || i === 5 ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
    <tbody>${rows || emptyRow(cols.length, "Tanlangan davrda hujjat yo'q")}</tbody>
    ${list.length && type !== 'inventory' ? `<tfoot><tr><td colspan="4">Jami: ${list.length} ta</td><td class="num">${noSum ? '' : money(total)}</td><td colspan="${cols.length - 5}"></td></tr></tfoot>` : ''}
    </table></div></div>`;
}

function exportDocs(type) {
  const t = DOC_TYPES[type];
  const rows = [['№', 'Sana', 'Kontragent', 'Ombor', 'Mahsulot', 'Soni', 'Narxi', 'Summa', 'Holati']];
  db.docs.filter((d) => d.type === type).forEach((d) => d.items.forEach((it) => rows.push([
    d.no, d.date, party(d.counterpartyId)?.name, warehouse(d.warehouseId)?.name, itemName(it), it.qty, it.price, it.qty * it.price, t.statuses ? t.statuses[d.status] : '',
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
    .filter((p) => !ptype || nameKey(p.type) === nameKey(ptype))
    .filter((p) => !q || [p.name, p.code, p.type, p.material, p.color, p.origin, p.maker, p.size, ...Object.values(p.attrs || {})].join(' ').toLowerCase().includes(q));

  const admin = isAdmin();
  const showCost = can('costs');
  // Xodimlarga (mahsulotlarni boshqarish huquqi bo'lmasa) ro'yxatda sotish narxi ko'rsatilmaydi
  const showPrice = admin || can('products');
  const rows = list.map((p) => {
    const st = qtyIn(ctx.stock, p.id);
    const rs = qtyIn(ctx.reserve, p.id);
    return `<tr>
      ${thumbCell(p)}
      <td class="click" data-act="editProduct" data-id="${p.id}"><b>${esc(p.name)}</b><div class="muted small prod-path">${icon(productIcon(p))}${esc([p.code, p.category, p.type].filter(Boolean).join(' · '))}</div>
        ${p.size || p.color || productAttrs(p).length ? `<div class="prod-meta">${p.size ? `<span class="dt">${esc(p.size)} sm</span>` : ''}${p.color ? `<span>${esc(p.color)}</span>` : ''}${productAttrs(p).map(([k, v]) => `<span title="${esc(k)}">${esc(v)}</span>`).join('')}</div>` : ''}
        ${p.origin || p.maker ? `<div class="muted small prod-origin">${icon('warehouse')}${esc([p.maker, p.origin].filter(Boolean).join(', '))}</div>` : ''}</td>
      ${showCost ? `<td class="num">${money(ctx.cost[p.id])}</td>` : ''}
      ${showPrice ? `<td class="num">${priceLabel(p)}${p.priceCurrency === 'USD' ? `<div class="muted small">${fmtUsd(p.salePrice)}</div>` : ''}${p.minPrice ? `<div class="muted small">eng kami: ${priceLabel(p, 'minPrice')}</div>` : ''}</td>` : ''}
      <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}${rs ? `<div class="muted small">rezerv ${rs}</div>` : ''}</td>
      <td class="actions"><button class="small icon-only" data-act="labelOne" data-id="${p.id}" title="Etiketka chop etish">${icon('tag')}</button>${admin ? `
        <button class="small icon-only" data-act="tgProduct" data-id="${p.id}" title="Telegram guruhga yuborish">${icon('send')}</button>
        ${p.archived ? `<button class="small" data-act="unarchive" data-id="${p.id}">Tiklash</button>` : `<button class="small danger icon-only" data-act="deleteProduct" data-id="${p.id}" title="O'chirish">${icon('trash')}</button>`}` : ''}
      </td>
    </tr>`;
  }).join('');

  return toolbar('products', {
    extra: `<select data-filter="products.arch"><option value="">Faol</option><option value="1" ${arch ? 'selected' : ''}>Arxiv</option></select>`,
    buttons: (canAddProducts() ? `<button class="primary" data-act="newProduct">${icon('plus')}Mahsulot</button>` : '') + (can('products') ? `<button data-act="exportProducts">${icon('download')}CSV</button>` : ''),
  }) + categoryBar('products.cat', db.products.filter((p) => !!p.archived === arch))
    + (cat ? typeBar('products.type', cat, db.products.filter((p) => !!p.archived === arch && p.category === cat)) : '')
    + `<div class="card"><div class="table-wrap"><table><thead><tr><th></th><th>Mahsulot</th>
    ${showCost ? '<th class="num">Tannarx</th>' : ''}${showPrice ? '<th class="num">Sotish narxi</th>' : ''}<th class="num">Qoldiq</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(6, "Mahsulot yo'q")}</tbody></table></div></div>`;
}

// Ro'yxatlardagi mahsulot rasmi: bosilsa barcha rasmlari katta ochiladi
function thumbCell(p) {
  return `<td class="thumb">${p.photos?.length
    ? `<button type="button" class="thumb-btn" data-act="photoView" data-id="${p.id}" title="Rasmlarni kattalashtirish"><img data-photo="${esc(p.photos[0].thumb)}" alt="${esc(p.name)}" loading="lazy">${p.photos.length > 1 ? `<span class="ph-count">${p.photos.length}</span>` : ''}</button>`
    : `<span class="thumb-empty">${icon('camera')}</span>`}</td>`;
}

function exportProducts() {
  const rows = [['Kod', 'Nomi', 'Kategoriya', 'Turi', "O'lchami", 'Rangi', 'Ishlab chiqarilgan', 'Ishlab chiqaruvchi', "Tannarx (so'm)", 'Narx valyutasi', 'Sotish narxi', 'Eng kam narx', "Sotish narxi (so'm)", "Eng kam narx (so'm)", 'Qoldiq', 'Rezerv']];
  db.products.forEach((p) => rows.push([p.code, p.name, p.category, p.type, p.size, p.color, p.origin, p.maker, can('costs') ? Math.round(ctx.cost[p.id]) : '',
    p.priceCurrency === 'USD' ? 'USD' : "so'm", p.salePrice, p.minPrice || '', salePriceUZS(p), minPriceUZS(p) || '', qtyIn(ctx.stock, p.id), qtyIn(ctx.reserve, p.id)]));
  download(`mahsulotlar-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

// --- Qoldiqlar ---

function viewStock() {
  const wh = filterVal('stock.wh');
  const cat = filterVal('stock.cat');
  const q = filterVal('stock.q').toLowerCase();
  const onlyPos = filterVal('stock.pos') === '1';
  const admin = can('costs');
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
      return `<tr class="click" data-act="productHistory" data-id="${p.id}">${thumbCell(p)}<td><b>${esc(p.name)}</b><div class="muted small prod-path">${icon(productIcon(p))}${esc([p.code, p.category, p.type].filter(Boolean).join(' · '))}</div></td>
        <td class="num ${st - rs <= (p.minQty || 0) ? 'debt' : ''}">${st}</td><td class="num">${rs || ''}</td><td class="num">${st - rs}</td>
        ${admin ? `<td class="num">${fmt(cost)}</td><td class="num">${fmt(st * cost)}</td>` : ''}<td class="num">${fmt(sale)}</td><td class="num">${fmt(st * sale)}</td></tr>`;
    }).join('');
  return toolbar('stock', {
    extra: `<select data-filter="stock.wh"><option value="">Barcha omborlar</option>${db.warehouses.map((w) => `<option value="${w.id}" ${w.id === wh ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <select data-filter="stock.pos"><option value="">Hammasi</option><option value="1" ${onlyPos ? 'selected' : ''}>Faqat bor</option></select>`,
    buttons: `<button data-act="print">${icon('print')}Chop etish</button>`,
  }) + categoryBar('stock.cat', activeProducts()) + `<div class="card"><div class="table-wrap"><table><thead><tr><th></th><th>Nomi</th><th class="num">Qoldiq</th><th class="num">Rezerv</th><th class="num">Mavjud</th>
    ${admin ? '<th class="num">Tannarx</th><th class="num">Tannarx summa</th>' : ''}<th class="num">Sotish narxi</th><th class="num">Sotish summa</th></tr></thead>
    <tbody>${rows || emptyRow(9, "Ma'lumot yo'q")}</tbody>
    <tfoot><tr><td colspan="2">Jami</td><td class="num">${tq}</td><td colspan="2"></td>${admin ? `<td></td><td class="num">${fmt(tc)}</td>` : ''}<td></td><td class="num">${fmt(ts)}</td></tr></tfoot></table></div></div>`;
}

// --- Kontragentlar ---

// fixed — «Mijozlar» yoki «Ta'minotchilar» sahifasi (har biri alohida ro'yxat)
function viewParties(fixed = '') {
  const q = filterVal('parties.q').toLowerCase();
  // Faqat bitta turdagi kontragentlarni ko'radigan xodimga — o'shalar
  const kinds = partyKinds().map(([k]) => k);
  const kind = fixed || (isAdmin() || kinds.length > 1 ? filterVal('parties.kind') : kinds[0] === 'supplier' ? 'supplier' : 'customer');
  const ctype = kind === 'supplier' ? '' : filterVal('parties.ctype');
  const list = db.counterparties
    .filter((c) => !kind || c.kind === kind || c.kind === 'both')
    .filter((c) => !ctype || c.ctype === ctype)
    .filter((c) => !q || [c.name, c.phone, c.address, c.inn].join(' ').toLowerCase().includes(q) || phoneMatch(c.phone, q));
  const rows = list.map((c) => {
    const b = partyBalance(c.id);
    const full = seesParties();
    const money_ = can('money');
    return `<tr class="click" data-act="editParty" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.note && full ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td><td>${esc(KINDS[c.kind])}${c.ctype && full ? `<div class="muted small">${esc(c.ctype)}</div>` : ''}</td>
      <td class="dt">${esc(full ? c.phone : maskPhone(c.phone))}</td><td>${full ? esc(c.address) : '—'}</td><td class="num ${b > 0 ? 'debt' : b < 0 ? 'warn' : ''}">${b && (full || money_) ? money(b) : '—'}</td>
      <td class="actions">${full || money_ ? `<button class="small" data-act="statement" data-id="${c.id}">${icon('receipt')}Hisob-kitob</button>` : ''}${isAdmin() ? `<button class="small danger icon-only" data-act="deleteParty" data-id="${c.id}" title="O'chirish">${icon('trash')}</button>` : ''}</td></tr>`;
  }).join('');
  return toolbar('parties', {
    extra: (fixed || !(isAdmin() || kinds.length > 1) ? '' : `<select data-filter="parties.kind"><option value="">Hammasi</option><option value="customer" ${kind === 'customer' ? 'selected' : ''}>Mijozlar</option><option value="supplier" ${kind === 'supplier' ? 'selected' : ''}>Ta'minotchilar</option></select>`)
      + (kind === 'supplier' ? '' : `<select data-filter="parties.ctype"><option value="">Barcha mijoz turlari</option>${db.customerTypes.map((x) => `<option ${x === ctype ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`),
    buttons: canAddParty() ? `<button class="primary" data-act="newParty" data-kind="${fixed}">${icon('plus')}${fixed === 'supplier' ? "Ta'minotchi" : fixed === 'customer' ? 'Mijoz' : 'Kontragent'}</button>` : '',
  }) + `<div class="card"><div class="table-wrap"><table><thead><tr><th>Nomi</th><th>Turi</th><th>Telefon</th><th>Manzil</th><th class="num">Balans</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(6, "Kontragent yo'q")}</tbody></table></div>
    <p class="muted small">Balans: qizil — kontragent bizga qarzdor, sariq — biz qarzdormiz.</p></div>`;
}

// Qarzga qilingan sotuvlar: qolgan summa, qaytarish sanasi va mas'ul
function saleDebts() {
  return db.docs.filter((d) => d.type === 'sale')
    .map((d) => ({ d, rest: docTotal(d) - docPaid(d) }))
    .filter((x) => x.rest > 0.5)
    .sort((a, b) => (a.d.debtDue || '9999').localeCompare(b.d.debtDue || '9999'));
}

function debtRows(list, withPay = true) {
  const t = today();
  return list.map(({ d, rest }) => {
    const c = party(d.counterpartyId) || {};
    const late = d.debtDue && d.debtDue < t;
    return `<tr class="click" data-act="openDoc" data-id="${d.id}">
      <td><b>${esc(c.name)}</b><div class="muted small dt">${esc(c.phone || '')}</div></td>
      <td>${esc(d.no)}<div class="muted small">${fmtDate(d.date)}</div></td>
      <td class="num debt">${money(rest)}</td>
      <td class="${late ? 'debt' : ''}">${d.debtDue ? fmtDate(d.debtDue) + (late ? '<div class="small">muddati o\'tgan</div>' : '') : '<span class="muted">—</span>'}</td>
      <td>${esc(d.debtResponsible || userName(d.userId))}</td>
      ${withPay ? `<td class="actions"><button class="small" data-act="debtPay" data-id="${d.id}">${icon('arrowIn')}To'lov</button></td>` : ''}
    </tr>`;
  }).join('');
}

function viewDebts() {
  const rows = db.counterparties.map((c) => ({ c, b: partyBalance(c.id) })).filter((x) => x.b);
  const recv = rows.filter((x) => x.b > 0).sort((a, b) => b.b - a.b);
  const pay = rows.filter((x) => x.b < 0).sort((a, b) => a.b - b.b);
  const table = (list, cls) => list.length ? list.map(({ c, b }) => `<tr class="click" data-act="statement" data-id="${c.id}"><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td class="num ${cls}">${money(Math.abs(b))}</td></tr>`).join('') : emptyRow(3, "Qarz yo'q");
  const sum = (list) => list.reduce((s, x) => s + Math.abs(x.b), 0);
  const sales = saleDebts();
  return `<div class="card"><h3>${icon('clock')}Qarzga sotuvlar — qaytarish muddati bilan</h3>
      <div class="table-wrap"><table><thead><tr><th>Mijoz</th><th>Sotuv</th><th class="num">Qarz</th><th>Qachon beradi</th><th>Mas'ul</th><th></th></tr></thead>
      <tbody>${debtRows(sales) || emptyRow(6, "Qarzga sotuv yo'q")}</tbody></table></div></div>
    <div class="grid2">
    <div class="card"><h3>Bizga qarzdorlar — ${money(sum(recv))}</h3><table><thead><tr><th>Kontragent</th><th>Telefon</th><th class="num">Qarz</th></tr></thead><tbody>${table(recv, 'debt')}</tbody></table></div>
    <div class="card"><h3>Bizning qarzlarimiz — ${money(sum(pay))}</h3><table><thead><tr><th>Kontragent</th><th>Telefon</th><th class="num">Qarz</th></tr></thead><tbody>${table(pay, 'warn')}</tbody></table></div>
  </div>`;
}

// --- Pul ---

function viewPayments() {
  const q = filterVal('payments.q').toLowerCase();
  const admin = can('money');
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
      <td>${esc(PAY_METHODS[p.method] || '')}${p.receipts?.length ? ` <button type="button" class="small rc-show" data-act="showReceipt" data-id="${p.id}" title="Chek surati">🧾</button>` : ''}</td><td class="num">${money(p.amount)}</td><td>${esc(p.note)}</td>
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
  const atDrivers = pendingHandovers().reduce((s, p) => s + p.amount, 0);
  return handoverCard() + `<div class="stats">${Object.entries(PAY_METHODS).map(([k, v]) => `<div class="stat"><div class="label">${v}</div><div class="value">${money(b[k] || 0)}</div></div>`).join('')}
    ${atDrivers ? `<div class="stat"><div class="label">Shofyorlarda (topshirilmagan)</div><div class="value warn">${money(atDrivers)}</div></div>` : ''}
    <div class="stat"><div class="label">Jami</div><div class="value">${money(cashTotal(b))}</div></div></div>
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
      const key = it.productId || 'custom:' + it.name;
      const a = (acc[key] = acc[key] || { qty: 0, revenue: 0, cost: 0, name: it.name });
      a.qty += sign * it.qty;
      a.revenue += sign * it.qty * it.price * k;
      a.cost += sign * it.qty * (ctx.cost[it.productId] || 0);
    });
  });
  return Object.entries(acc).map(([pid, a]) => ({ p: product(pid) || { name: a.name ? `${a.name} (individual)` : "(o'chirilgan)" }, ...a, profit: a.revenue - a.cost }));
}

function viewProfit() {
  const rows = profitRows((d) => inPeriod('profit', d)).sort((a, b) => b.profit - a.profit);
  const tot = rows.reduce((s, r) => ({ qty: s.qty + r.qty, revenue: s.revenue + r.revenue, cost: s.cost + r.cost, profit: s.profit + r.profit }), { qty: 0, revenue: 0, cost: 0, profit: 0 });
  const exp = {};
  db.payments.filter((p) => isExpense(p) && inPeriod('profit', p.date)).forEach((p) => { exp[p.purpose] = (exp[p.purpose] || 0) + p.amount; });
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
  const byCtype = {};
  db.docs.filter((d) => (d.type === 'sale' || d.type === 'salesReturn') && inPeriod('top', d.date)).forEach((d) => {
    const k = party(d.counterpartyId)?.ctype || (d.counterpartyId === 'retail' ? 'Chakana xaridor' : 'Turi belgilanmagan');
    const x = (byCtype[k] = byCtype[k] || { count: 0, sum: 0 });
    if (d.type === 'sale') x.count++;
    x.sum += (d.type === 'sale' ? 1 : -1) * docTotal(d);
  });
  const sellers = {};
  db.docs.filter((d) => (d.type === 'sale' || d.type === 'salesReturn') && inPeriod('top', d.date)).forEach((d) => {
    const s = (sellers[d.userId || ''] = sellers[d.userId || ''] || { count: 0, sum: 0 });
    if (d.type === 'sale') s.count++;
    s.sum += (d.type === 'sale' ? 1 : -1) * docTotal(d);
  });
  return toolbar('top', { search: false, extra: periodInputs('top') }) + `
    <div class="card"><h3>${icon('users')}Mijoz turlari bo'yicha</h3><table><thead><tr><th>Mijoz turi</th><th class="num">Sotuvlar</th><th class="num">Savdo summasi</th></tr></thead><tbody>
      ${Object.entries(byCtype).sort((a, b) => b[1].sum - a[1].sum).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="num">${x.count}</td><td class="num">${money(x.sum)}</td></tr>`).join('') || emptyRow(3, "Davrda savdo yo'q")}
    </tbody></table></div>
    <div class="card"><h3>Sotuvchilar bo'yicha</h3><table><thead><tr><th>Sotuvchi</th><th class="num">Sotuvlar</th><th class="num">Savdo summasi</th></tr></thead><tbody>
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

// ---------- Telefonga o'rnatish ----------

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const hostedUrl = () => (location.protocol === 'https:' && !/claude\.ai|claudeusercontent/.test(location.host) ? location.origin + location.pathname : '');
const siteUrl = () => hostedUrl() || window.BT_CONFIG?.siteUrl || '';

// Android Chrome "o'rnatish" oynasini keyinroq tugma bilan chaqirish uchun saqlab qo'yamiz
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (me) render();
});
window.addEventListener('appinstalled', () => { installPrompt = null; if (me) render(); });

function qrSvg(text) {
  if (!window.qrcode || !text) return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}

function viewInstall() {
  const url = siteUrl();
  const step = (ic, html) => `<li><span class="step-ic">${icon(ic)}</span><span>${html}</span></li>`;
  return `<div class="install-grid">
    <div class="card install-qr">
      <h3>${icon('phone')}Telefon kamerasi bilan skanerlang</h3>
      ${url ? `<div class="qr">${qrSvg(url)}</div><div class="install-url"><code>${esc(url)}</code></div>`
        : '<p class="muted">Dastur hali internet saytga joylanmagan.</p>'}
      ${isStandalone() ? `<p class="ok">${icon('check')} Dastur shu qurilmada ilova sifatida ochilgan.</p>` : ''}
      <p class="muted small">Versiya: <b>${esc(APP_VERSION)}</b>. Yangilash: ekranni pastga torting yoki ilovani qayta oching.</p>
    </div>
    <div class="card">
      <h3>${icon('share')}iPhone / iPad</h3>
      <ol class="install-steps">
        ${step('camera', 'Kamerani QR-kodga qarating va chiqqan havolani bosing — sayt <b>Safari</b>da ochiladi.')}
        ${step('share', "Pastdagi <b>Ulashish</b> tugmasini bosing (strelkali kvadrat).")}
        ${step('homeAdd', "Ro'yxatni pastga suring va <b>«Bosh ekranga qo'shish»</b> (Add to Home Screen) ni tanlang.")}
        ${step('check', "<b>Qo'shish</b> ni bosing — bosh ekranda divan belgili <b>Biznes Tizim</b> paydo bo'ladi.")}
      </ol>
      <p class="muted small">Faqat Safari orqali o'rnatiladi (iPhone'dagi Chrome buni qila olmaydi).</p>
    </div>
    ${installPrompt ? `<div class="card"><h3>${icon('download')}Shu qurilmaga o'rnatish</h3>
      <p class="muted">Bitta tugma — dastur ilova bo'lib o'rnatiladi.</p>
      <button class="primary" data-act="installApp">${icon('download')}Hozir o'rnatish</button></div>` : ''}
    <div class="card">
      <h3>${icon('download')}Android</h3>
      ${installPrompt ? `<p class="muted">Yuqoridagi "Hozir o'rnatish" tugmasini bosing.</p>` : `<ol class="install-steps">
        ${step('camera', 'QR-kodni skanerlang — sayt <b>Chrome</b>da ochiladi.')}
        ${step('more', "Yuqoridagi <b>⋮</b> menyu → <b>«Ilovani o'rnatish»</b> (yoki «Bosh ekranga qo'shish»).")}
      </ol>`}
    </div>
  </div>`;
}

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
    <p class="muted"><b>Administrator</b> — hamma bo'limlar va sozlamalar. Boshqa xodimlarga (sotuvchi, ta'minot xodimi) qaysi funksiyalar ochiqligini siz belgilaysiz: «Tahrirlash» → ruxsatlar. Administratordan boshqa hech kim hujjat va to'lovlarni o'chira olmaydi, sozlamalar va foydalanuvchilarni ko'rmaydi, o'zgalar hujjatlarini o'zgartira olmaydi.</p>
    <table><thead><tr><th>Ism</th><th>Login</th><th>Roli</th><th>Ruxsatlar</th><th>Holati</th><th></th></tr></thead><tbody>
    ${db.users.map((u) => `<tr><td>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(siz)</span>' : ''}</td><td>${esc(u.login)}</td>
      <td>${badge(ROLES[u.role] || u.role, u.role === 'admin' ? 'admin' : '')}</td>
      <td class="small">${u.role === 'admin' ? 'Hammasi' : esc(permsOf(u).map((k) => PERMS[k]?.[0]).filter(Boolean).join(', ') || "— yo'q")}</td><td>${u.active === false ? badge('Bloklangan', 'cancel') : badge('Faol', 'done')}</td>
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
      ${field('Login *', 'login', u.login, `required autocapitalize="none" autocomplete="off" placeholder="masalan: sardor" ${server && id ? 'disabled' : ''}`)}
      ${selectField('Roli', 'role', Object.entries(ROLES), u.role, '', `id="userRole" ${self ? 'disabled' : ''}`)}
      ${selectField('Holati', 'active', [['1', 'Faol'], ['0', 'Bloklangan']], u.active === false ? '0' : '1', '', self ? 'disabled' : '')}
      ${canSetPassword
        ? field(id ? "Yangi parol (o'zgartirmaslik uchun bo'sh qoldiring)" : 'Parol * (kamida 6 belgi)', 'password', '', `type="password" autocomplete="new-password" ${id ? '' : 'required'}`, 'full')
        : '<p class="muted small full">Parolni foydalanuvchining o\'zi o\'zgartiradi (yuqoridagi ismi ustiga bosib). Unutgan bo\'lsa — uni bloklab, yangi email bilan qayta qo\'shing.</p>'}
      <div class="field full perm-box" id="permBox">
        <span class="field-label">Ruxsatlar — qaysi funksiyalar ochiq</span>
        ${Object.entries(PERMS).map(([k, [title, hint]]) => `<label class="perm-row"><input type="checkbox" name="perm_${k}" value="1" ${permsOf(u).includes(k) ? 'checked' : ''} ${self ? 'disabled' : ''}>
          <span><b>${esc(title)}</b><small>${esc(hint)}</small></span></label>`).join('')}
        <p class="muted small">Etiketka chop etish, mahsulotlar va qoldiqlarni ko'rish — hammaga ochiq. Rol tanlanganda uning odatiy ruxsatlari qo'yiladi, keyin xohlaganingizcha o'zgartirasiz.</p>
      </div>
      <p class="muted small full" id="permAdminNote">Administrator hamma funksiyalardan foydalanadi.</p>
    </div>`,
    onOpen: () => {
      const role = $('#userRole');
      const sync = () => {
        const admin = role.value === 'admin';
        $('#permBox').hidden = admin;
        $('#permAdminNote').hidden = !admin;
      };
      // Rol almashtirilsa — o'sha rolning odatiy ruxsatlari belgilanadi
      role.addEventListener('change', () => {
        $$('#permBox input[type=checkbox]').forEach((c) => { c.checked = (ROLE_PERMS[role.value] || []).includes(c.name.slice(5)); });
        sync();
      });
      sync();
    },
    onSubmit: async (d) => {
      const password = d.password || '';
      // Login: lotin harflari, raqamlar, nuqta, chiziqcha (yoki email)
      if (!id && !/^[a-z0-9._-]+(@[a-z0-9.-]+\.[a-z]+)?$/i.test(d.login.trim())) {
        alert("Login faqat lotin harflari, raqamlar, nuqta va chiziqchadan iborat bo'lsin (masalan: sardor yoki sardor.k).");
        return false;
      }
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
        perms: self ? u.perms : d.role === 'admin' ? undefined : Object.keys(PERMS).filter((k) => d['perm_' + k]),
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
      if (!id && server) alert(`Foydalanuvchi qo'shildi. U «${next.login}» login va siz bergan parol bilan kiradi.`);
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
      <li>Botni guruhingizga qo'shing va uni <b>administrator</b> qiling (xabar yuborish huquqi bilan; temali guruhda — <b>«Mavzularni boshqarish»</b> huquqi ham).</li>
      <li>Guruhga istalgan xabar yozing, so'ng "Guruh ID sini aniqlash" tugmasini bosing. Ochiq kanal/guruh uchun <code>@guruh_nomi</code> ham yozish mumkin.</li>
    </ol>
    <div class="form-grid">
      <label class="full">Bot tokeni<input id="tgToken" value="${esc(tg.token)}" placeholder="123456789:AA..." autocomplete="off"></label>
      <label class="full">Guruh / kanal ID<input id="tgChat" value="${esc(tg.chatId)}" placeholder="-1001234567890 yoki @guruh_nomi"></label>
      <div class="full tg-fields"><span class="field-label">Xabarda ko'rsatiladi (belgini olib tashlasangiz — chiqmaydi):</span>
        ${TG_FIELDS.map(([k, label]) => `<label class="check"><input type="checkbox" class="tg-field" data-k="${k}" ${tg.hide?.[k] ? '' : 'checked'}> ${esc(label)}</label>`).join('')}</div>
      <label class="check full"><input type="checkbox" id="tgShowQty" ${tg.showQty ? 'checked' : ''}> Ombordagi sonini ko'rsatish (aks holda faqat "bor / yo'q")</label>
      <label class="check full"><input type="checkbox" id="tgTopics" ${tg.useTopics ? 'checked' : ''}> Temali guruh: har bir kategoriya alohida temaga joylansin</label>
    </div>
    ${tg.useTopics ? `<div class="tg-topics"><p class="muted small">Botga guruhda <b>«Mavzularni boshqarish»</b> (Manage topics) huquqini bering — kategoriya temasi bo'lmasa, bot uni o'zi yaratadi.</p>
      <table><tbody>${db.categories.map((c) => `<tr><td>${icon(categoryIcon(c))} ${esc(c)}</td><td class="num muted small">${tg.topics?.[c] ? `tema #${tg.topics[c]}` : 'birinchi e\'londa yaratiladi'}</td></tr>`).join('')}</tbody></table>
      <div class="toolbar" style="margin-top:8px"><button data-act="tgTopicsCreate">Temalarni hozir yaratish</button><button data-act="tgTopicIcons">Temalarni bezash (ikonka va smaylik)</button>${Object.keys(tg.topics || {}).length ? '<button data-act="tgTopicsReset">Temalarni qayta bog\'lash</button>' : ''}</div></div>` : ''}
    <div class="toolbar" style="margin-top:12px">
      <button class="primary" data-act="tgSave">Saqlash</button>
      <button data-act="tgDetect">Guruh ID sini aniqlash</button>
      <button data-act="tgTest">Sinov xabari</button>
      <button data-act="tgAll">Barcha mavjud mahsulotlarni yuborish</button>
    </div>
    <p class="muted small">Token faqat administratorga ko'rinadi — sotuvchilar uni ko'rmaydi.</p>
  </div>
  ${sample ? `<div class="card narrow"><h3>Namuna xabar</h3><div class="tg-preview">${sample.photos?.length ? `<img data-photo="${esc(sample.photos[0].path)}" alt="">` : ''}<div>${telegramCaption(sample).replace(/\n/g, '<br>')}</div></div></div>` : ''}
  ${botAnswersCard()}
  <div class="card narrow"><h3>Yuborish jurnali</h3><table><tbody>
    ${tg.log.length ? tg.log.map((l) => `<tr><td class="muted small">${esc(l.at)}</td><td class="${l.ok ? '' : 'debt'}">${esc(l.text)}</td></tr>`).join('') : emptyRow(2, "Hali yuborilmagan")}
  </tbody></table></div>`;
}

// Guruh manzili: raqamli ID (-100...) yoki ochiq guruh nomi (@nomi). t.me/nomi → @nomi.
// Yopiq guruhning taklif havolasi (t.me/+...) ishlamaydi — uning o'rniga ID aniqlanadi.
function tgChatValue(v) {
  v = v.trim();
  const m = v.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,})\/?$/);
  if (m) return '@' + m[1];
  if (/t\.me\/(\+|joinchat)/.test(v)) return '';
  return v;
}

// Guruhdagi savollarga bot javobi (server: supabase/functions/tg-bot)
const BOT_DEFAULTS = { answer: true, priceDM: true, deleteAfterH: 24, address: '', hours: '', delivery: '', extra: [] };
const botCfg = () => Object.assign({}, BOT_DEFAULTS, db.telegram.bot);

function botAnswersCard() {
  const b = botCfg();
  const ready = backend.kind === 'supabase' && db.telegram.webhook;
  return `<div class="card narrow"><h3>${icon('send')}Guruhdagi savollarga avtomatik javob</h3>
    <p class="muted small">Bot guruhdagi savollarga javob beradi va <b>javob yozishmalarini belgilangan vaqtdan keyin o'chiradi</b>. Narxini so'raganlarga narxni <b>lichkasiga</b> yozadi (guruhda «lichkangizga yozdik» deydi). Mahsulot e'loniga javob qilib yoki artikulini yozib so'ralsa, qaysi mahsulot ekanini o'zi biladi.</p>
    ${ready ? '' : `<p class="debt small">Ishlashi uchun: server rejimi va Sozlamalar → Shofyorlar dagi «Botni ulash» tugmasi bosilgan bo'lishi kerak. Guruhda botga «Xabarlarni o'chirish» huquqini ham bering.</p>`}
    <div class="form-grid">
      <label class="check full"><input type="checkbox" id="tgbAnswer" ${b.answer ? 'checked' : ''}> Guruhdagi savollarga javob berish</label>
      <label class="check full"><input type="checkbox" id="tgbPrice" ${b.priceDM ? 'checked' : ''}> Narxni so'raganlarga lichkada javob berish</label>
      <label>Javob yozishmalarini o'chirish (soatdan keyin)<input id="tgbDel" type="number" inputmode="numeric" min="0" max="168" value="${esc(b.deleteAfterH)}"></label>
      <label class="full">Manzil («qayerdasiz», «manzil» deb so'rashsa)<input id="tgbAddr" value="${esc(b.address || db.company.address || '')}" placeholder="Masalan: Toshkent, Chilonzor, Mebel bozori 2-qator"></label>
      <label class="full">Ish vaqti<input id="tgbHours" value="${esc(b.hours)}" placeholder="Har kuni 9:00 — 19:00"></label>
      <label class="full">Yetkazib berish haqida<input id="tgbDelivery" value="${esc(b.delivery)}" placeholder="Shahar ichida bepul, viloyatlarga kelishilgan narxda"></label>
    </div>
    <h4>Qo'shimcha savol-javoblar</h4>
    <p class="muted small">Kalit so'zlar (vergul bilan) savolda uchrasa — javob yuboriladi.</p>
    <table class="exp-cats bot-faq"><tbody>${(b.extra || []).map((x, i) => `<tr><td><input class="bf-q" value="${esc(x.q)}" placeholder="kredit, nasiya, bo'lib to'lash"></td><td><input class="bf-a" value="${esc(x.a)}" placeholder="Ha, 6 oygacha nasiyaga sotamiz"></td><td class="actions"><button class="small danger icon-only" data-act="bfDel" data-i="${i}">${icon('trash')}</button></td></tr>`).join('')}</tbody></table>
    <div class="toolbar" style="margin-top:8px"><button data-act="bfAdd">${icon('plus')}Savol-javob qo'shish</button><button class="primary" data-act="tgSave">Saqlash</button></div></div>`;
}

function readBotCfg() {
  if (!$('#tgbAnswer')) return;
  db.telegram.bot = {
    answer: $('#tgbAnswer').checked,
    priceDM: $('#tgbPrice').checked,
    deleteAfterH: Math.max(0, Math.min(168, num($('#tgbDel').value))),
    address: $('#tgbAddr').value.trim(),
    hours: $('#tgbHours').value.trim(),
    delivery: $('#tgbDelivery').value.trim(),
    extra: $$('.bot-faq tr').map((tr) => ({ q: $('.bf-q', tr).value.trim(), a: $('.bf-a', tr).value.trim() })).filter((x) => x.q && x.a),
  };
}

function tgReadForm() {
  readBotCfg();
  const raw = $('#tgChat').value.trim();
  const chatId = tgChatValue(raw);
  if (raw && !chatId) {
    $('#tgChat').value = '';
    alert("Bu guruhning taklif havolasi — u orqali bot yubora olmaydi.\n\nGuruhga «/start@kaomebel_uz_bot» yoki istalgan xabar yozing, so'ng «Guruh ID sini aniqlash» tugmasini bosing — ID o'zi yoziladi.");
  }
  Object.assign(db.telegram, {
    token: $('#tgToken').value.trim(),
    chatId,
    showQty: $('#tgShowQty').checked,
    useTopics: $('#tgTopics').checked,
    hide: Object.fromEntries($$('.tg-field').filter((c) => !c.checked).map((c) => [c.dataset.k, true])),
  });
}

// Hamma kategoriyalar uchun temalarni oldindan yaratish
async function tgTopicsCreate() {
  tgReadForm();
  if (!db.telegram.token || !db.telegram.chatId) return alert('Avval token va guruh ID sini kiriting.');
  const made = [];
  try {
    for (const c of db.categories) {
      if (db.telegram.topics?.[c]) continue;
      await telegramTopic({ category: c });
      made.push(c);
      await new Promise((r) => setTimeout(r, 1200));
    }
    await save();
    alert(made.length ? `Yaratildi: ${made.join(', ')}` : 'Barcha kategoriyalar uchun tema bor.');
  } catch (e) {
    await save();
    alert('Xato: ' + e.message + (/rights|not enough|forum|administrator/i.test(e.message)
      ? "\n\nGuruhda «Temalar» yoqilganini va botda «Mavzularni boshqarish» huquqi borligini tekshiring." : ''));
  }
}

async function tgDetect() {
  tgReadForm();
  if (!db.telegram.token) return alert('Avval bot tokenini kiriting.');
  try {
    const updates = await botUpdates();
    const chats = new Map();
    const moved = new Set();
    updates.forEach((u) => {
      const msg = u.message || u.my_chat_member || u.channel_post || {};
      const c = msg.chat;
      // Temalar yoqilganda oddiy guruh superguruhga aylanadi va ID si o'zgaradi
      if (msg.migrate_to_chat_id) moved.add(c.id);
      if (c && c.type !== 'private') chats.set(c.id, { title: c.title, forum: !!c.is_forum });
    });
    moved.forEach((id) => chats.delete(id));
    if (!chats.size) return alert("Guruh topilmadi. Bot guruhga qo'shilganini tekshiring, guruhga «/start@kaomebel_uz_bot» deb yozing va qayta urinib ko'ring.");
    const [id, { title, forum }] = [...chats.entries()].pop();
    $('#tgChat').value = id;
    if (forum) $('#tgTopics').checked = true;
    tgReadForm();
    await save();
    alert(`Topildi: ${title} (${id})${forum ? '. Bu temali guruh — har bir kategoriya o\'z temasiga joylanadi' : ''}. Saqlandi.`);
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
      <label>Telefon<input id="coPhone" class="phone" type="tel" inputmode="tel" placeholder="+998 90 123 45 67" value="${esc(c.phone)}"></label>
      <label>Manzil<input id="coAddress" value="${esc(c.address)}"></label>
      <label class="full">Buyurtma shartnomasining shartlari (har bir qatorga bitta band)
        <textarea id="coTerms" rows="7">${esc(c.contractTerms || DEFAULT_CONTRACT_TERMS)}</textarea></label>
    </div><div class="toolbar" style="margin-top:12px"><button class="primary" data-act="coSave">Saqlash</button></div></div>`;
}

function viewWarehouses() {
  return `<div class="card narrow"><h3>${icon('warehouse')}Omborlar va do'konlar — ${db.warehouses.length} ta</h3>
    <p class="muted">Omborlarni faqat administrator qo'sha, o'zgartira va o'chira oladi. Kirim, sotuv va ko'chirishda kerakli ombor tanlanadi; qoldiqlar har bir ombor bo'yicha alohida hisoblanadi.</p><table><thead><tr><th>Nomi</th><th>Manzil</th><th class="num">Tovar soni</th><th></th></tr></thead><tbody>
    ${db.warehouses.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.address)}</td><td class="num">${db.products.filter((p) => !isKit(p)).reduce((s, p) => s + qtyIn(ctx.stock, p.id, w.id), 0)}</td>
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
  return `<span class="chip on" tabindex="0" data-v="${esc(v)}">${esc(v)}<button type="button" class="chip-x" data-act="chipRemove" title="Olib tashlash" aria-label="${esc(v)} — olib tashlash">×</button></span>`;
}

function chipEditor(values, placeholder) {
  return `<div class="chips chips-edit">${values.map(editChip).join('')}<input class="chip-add" placeholder="${placeholder}" enterkeyhint="done"></div>`;
}

// "Kategoriya" va "Kategoriya › Tur" — xususiyatlar to'plami qayerda ishlashini tanlash uchun
function fsApplyOptions() {
  return db.categories.flatMap((c) => [c, ...(db.categoryTypes[c] || []).map((t) => `${c} › ${t}`)]);
}

function fsFieldRow(f = { name: '', options: [] }) {
  return `<div class="fs-field">
    <div class="cat-head"><input class="fs-fname" value="${esc(f.name)}" placeholder="Maydon nomi (masalan: Krestovina turi)">
      <button type="button" class="small danger icon-only" data-act="fsFieldDel" title="Maydonni olib tashlash">${icon('trash')}</button></div>
    ${chipEditor(f.options || [], "+ Variant qo'shish (Enter)")}
  </div>`;
}

function fsRow(set = { name: '', applies: [], colors: [], fields: [] }) {
  return `<div class="cat-row fs-row" data-id="${esc(set.id || '')}">
    <div class="cat-head"><input class="cat-name fs-name" value="${esc(set.name)}" placeholder="To'plam nomi (masalan: Ofis kreslo va stullar)">
      <button type="button" class="small danger icon-only" data-act="fsDel" title="To'plamni olib tashlash">${icon('trash')}</button></div>
    <span class="field-label">Qaysi kategoriya va turlarda</span>
    <div class="fs-applies"><div class="chips chips-edit">${(set.applies || []).map(editChip).join('')}</div>
      <select class="fs-apply-add"><option value="">+ Kategoriya yoki tur qo'shish...</option>${fsApplyOptions().map((o) => `<option>${esc(o)}</option>`).join('')}</select></div>
    <span class="field-label">Qo'shimcha maydonlar</span>
    <div class="fs-fields">${(set.fields || []).map(fsFieldRow).join('')}</div>
    <button type="button" class="small" data-act="fsFieldAdd">${icon('plus')}Maydon qo'shish</button>
    <label class="fs-ctl">Ranglar qaysi maydonga qarab o'zgaradi
      <select class="fs-ctl-sel"><option value="">— hamma uchun bir xil ranglar</option>${(set.fields || []).map((f, i) => `<option value="${i}" ${f.name === set.colorField ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
    <div class="fs-colorsby">${(() => {
      const ctl = (set.fields || []).find((f) => f.name === set.colorField);
      return ctl ? (ctl.options || []).map((o) => `<div class="fs-cb" data-opt="${esc(o)}"><span class="field-label">${esc(o)} — ranglari</span>${chipEditor(set.colorsBy?.[o] || [], "+ Rang qo'shish (Enter)")}</div>`).join('') : '';
    })()}</div>
    <span class="field-label">${set.colorField ? 'Umumiy ranglar (material tanlanmagan bo\'lsa)' : 'Ranglar'}</span>
    <div class="fs-colors">${chipEditor(set.colors || [], "+ Rang qo'shish (Enter)")}</div>
  </div>`;
}

// Ranglar bog'lanadigan maydon tanlansa — uning har bir varianti uchun rang ro'yxati chiqadi
document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('fs-ctl-sel')) return;
  const row = e.target.closest('.fs-row');
  const field = $$('.fs-field', row)[Number(e.target.value)];
  const keep = Object.fromEntries($$('.fs-cb', row).map((cb) => [cb.dataset.opt, $$('.chip', cb).map((c) => c.dataset.v)]));
  const general = $$('.fs-colors .chip', row).map((c) => c.dataset.v);
  $('.fs-colorsby', row).innerHTML = e.target.value === '' || !field ? '' : $$('.chip', field).map((c) => c.dataset.v)
    .map((o) => `<div class="fs-cb" data-opt="${esc(o)}"><span class="field-label">${esc(o)} — ranglari</span>${chipEditor(keep[o] || general, "+ Rang qo'shish (Enter)")}</div>`).join('');
});

document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('fs-apply-add') || !e.target.value) return;
  const box = $('.chips', e.target.closest('.fs-applies'));
  const v = e.target.value;
  if (!$$('[data-v]', box).some((c) => c.dataset.v === v)) box.insertAdjacentHTML('beforeend', editChip(v));
  e.target.value = '';
});

function catRow(name, types) {
  const chosen = db.categoryIcons?.[name] || '';
  return `<div class="cat-row" data-orig="${esc(name)}" data-icon="${esc(chosen)}">
    <div class="cat-head"><button type="button" class="cat-ic-btn" data-act="catIconOpen" title="Ikonkani tanlash">${icon(chosen || categoryIcon(name))}</button>
      <input class="cat-name" value="${esc(name)}" placeholder="Kategoriya nomi">
      <button type="button" class="small danger icon-only" data-act="catDel" title="Kategoriyani olib tashlash">${icon('trash')}</button></div>
    <div class="cat-ic-grid" hidden>${FURNITURE_ICONS.map((ic) => `<button type="button" class="${ic === (chosen || categoryIcon(name)) ? 'on' : ''}" data-act="catIconSet" data-ic="${ic}">${icon(ic)}</button>`).join('')}</div>
    <div class="cat-types">${chipEditor(types, '+ Tur qo\'shish (Enter)')}</div>
    <span class="field-label cat-col-label">${icon('tag')} Ranglari <span class="muted small">— bo'sh qolsa, pastdagi umumiy ranglar chiqadi</span></span>
    <div class="cat-colors">${chipEditor(db.categoryColors?.[name] || [], "+ Rang qo'shish (Enter)")}</div>
  </div>`;
}

function viewCategories() {
  return `<div class="lists-page"><div class="card narrow"><h3>${icon('tag')}Kategoriyalar va turlar</h3>
      <p class="muted">Har bir kategoriyaning turlari va ranglari mahsulot kartochkasida shu kategoriya tanlanganda chiqadi (masalan, shkafga — LDSP ranglari, divanga — mato ranglari). Qo'shish uchun nomini yozib Enter bosing. O'chirish: × / 🗑 tugmasi, belgilab Delete tugmasi yoki sichqonchaning o'ng tugmasi (telefonda — bosib turing). Stul kabi turlarning o'z material va ranglari pastdagi «Turga xos xususiyatlar» da.</p>
      <div id="catRows">${categoriesAll().map((c) => catRow(c, typesOf(c))).join('')}</div>
      <button type="button" data-act="catAdd">${icon('plus')}Kategoriya qo'shish</button>
    </div>
    <div class="card narrow"><h3>${icon('tag')}Umumiy ranglar</h3>
      <p class="muted">O'z ranglari berilmagan kategoriyalarda mahsulot kartochkasida shu ranglar chiqadi (masalan, Dub beliy, Belaya korona, Oq gladkiy).</p>
      <div id="colorEditor">${chipEditor(db.colors, "+ Rang qo'shish (Enter)")}</div>
    </div>
    <div class="card narrow"><h3>${icon('sofa')}Turga xos xususiyatlar</h3>
      <p class="muted">Tanlangan kategoriya yoki turdagi mahsulot kartochkasida umumiy ranglar o'rniga shu ranglar va qo'shimcha maydonlar chiqadi (masalan, ofis kreslolarida — qoplama materiali, krestovina, mexanizm).</p>
      <div id="fsRows">${(db.featureSets || []).map(fsRow).join('')}</div>
      <button type="button" data-act="fsAdd">${icon('plus')}To'plam qo'shish</button>
    </div>
    <div class="card narrow"><h3>${icon('truck')}Yetkazish manzillari</h3>
      <p class="muted">Viloyatlar va ularning shahar/tumanlari. Birinchi turgan viloyat va uning birinchi shahri savdoda oldindan tanlanadi. Mahallalar savdoda yozilganda o'zi qo'shiladi.</p>
      <div id="regionRows">${db.regions.map((r) => `<div class="cat-row reg-row" data-orig="${esc(r.name)}">
        <div class="cat-head"><input class="cat-name" value="${esc(r.name)}" placeholder="Viloyat nomi">
          <button type="button" class="small danger icon-only" data-act="regDel" title="Viloyatni olib tashlash">${icon('trash')}</button></div>
        ${chipEditor(r.places.map((x) => x.name), "+ Shahar/tuman qo'shish (Enter)")}</div>`).join('')}</div>
      <button type="button" data-act="regAdd">${icon('plus')}Viloyat qo'shish</button>
    </div>
    <div class="card narrow"><h3>${icon('users')}Mijoz turlari</h3>
      <p class="muted">Savdoda mijoz turi shu ro'yxatdan tanlanadi (Mebelchi, Domchi, Optomchi...).</p>
      <div id="ctypeEditor">${chipEditor(db.customerTypes, "+ Mijoz turi qo'shish (Enter)")}</div>
    </div>
    <div class="toolbar lists-bar"><span id="listsSaved" class="lists-saved"></span><button class="primary" data-act="catSave">${icon('check')}Saqlash</button></div></div>`;
}

// Sozlamalar → Ro'yxatlar: kategoriyalar, turlar, ranglar, xususiyatlar, manzillar, mijoz turlari.
// «Saqlash» tugmasi bosilmasa ham har bir o'zgarishdan keyin o'zi saqlanadi (quiet = sahifa qayta chizilmaydi).
function saveLists(quiet = false) {
  if (!$('#catRows')) return;
  // Yozib qo'yilgan, lekin Enter bosilmagan qiymatlar ham saqlanadi
  if (!quiet) $$('.lists-page .chip-add').forEach((inp) => {
    const v = inp.value.trim();
    const box = inp.closest('.chips');
    if (v && !$$('[data-v]', box).some((c) => c.dataset.v.toLowerCase() === v.toLowerCase())) inp.insertAdjacentHTML('beforebegin', editChip(v));
    inp.value = '';
  });
  const categories = [];
  const types = {};
  const colorsByCat = {};
  const renames = [];
  $$('#catRows .cat-row').forEach((row) => {
    const name = $('.cat-name', row).value.trim();
    if (!name || categories.includes(name)) return;
    categories.push(name);
    types[name] = $$('.cat-types .chip', row).map((c) => c.dataset.v);
    const cols = $$('.cat-colors .chip', row).map((c) => c.dataset.v);
    if (cols.length) colorsByCat[name] = cols;
    if (row.dataset.orig && row.dataset.orig !== name) renames.push([row.dataset.orig, name]);
  });
  // Nomi o'zgargan kategoriya mahsulotlarda ham yangilanadi
  renames.forEach(([from, to]) => db.products.forEach((p) => { if (p.category === from) p.category = to; }));
  // Mahsulotlardagi tur boshqacha yozilgan bo'lsa (katta-kichik harf) — ro'yxatdagi yozilishga keltiriladi
  db.products.forEach((p) => {
    const t = (types[p.category] || []).find((x) => nameKey(x) === nameKey(p.type));
    if (t && t !== p.type) p.type = t;
  });
  db.categories = categories;
  db.categoryTypes = types;
  db.categoryColors = colorsByCat;
  // Qo'lda tanlangan ikonkalar (tanlanmagani nomidan o'zi aniqlanadi)
  db.categoryIcons = {};
  $$('#catRows .cat-row').forEach((row) => {
    const name = $('.cat-name', row).value.trim();
    if (name && row.dataset.icon) db.categoryIcons[name] = row.dataset.icon;
  });
  // Turga xos xususiyatlar (kategoriya nomi o'zgargan bo'lsa — bog'lanish ham yangilanadi)
  const renamePath = (a) => renames.reduce((x, [from, to]) => (x === from ? to : x.startsWith(from + ' › ') ? to + x.slice(from.length) : x), a);
  db.featureSets = $$('#fsRows .fs-row').map((row) => ({
    id: row.dataset.id || uid(),
    name: $('.fs-name', row).value.trim() || 'Xususiyatlar',
    applies: $$('.fs-applies .chip', row).map((c) => renamePath(c.dataset.v)),
    colors: $$('.fs-colors .chip', row).map((c) => c.dataset.v),
    fields: $$('.fs-field', row).map((f) => ({ name: $('.fs-fname', f).value.trim(), options: $$('.chip', f).map((c) => c.dataset.v) })),
  })).map((set, i) => {
    // Ranglar bog'langan maydon (tartib raqami bo'yicha — nomi o'zgargan bo'lsa ham)
    const row = $$('#fsRows .fs-row')[i];
    const ctl = set.fields[Number($('.fs-ctl-sel', row).value)];
    const old = (db.featureSets || []).find((x) => x.id === set.id) || {};
    const colorsBy = Object.assign({}, old.colorsBy);
    $$('.fs-cb', row).forEach((cb) => { colorsBy[cb.dataset.opt] = $$('.chip', cb).map((c) => c.dataset.v); });
    return Object.assign(set, {
      fields: set.fields.filter((f) => f.name),
      colorField: $('.fs-ctl-sel', row).value !== '' && ctl?.name ? ctl.name : '',
      colorsBy,
    });
  });
  db.colors = $$('#colorEditor .chip').map((c) => c.dataset.v);
  db.customerTypes = $$('#ctypeEditor .chip').map((c) => c.dataset.v);
  // Viloyatlar: mavjud shahar/tumanlarning mahallalari saqlanib qoladi
  const oldRegions = db.regions;
  db.regions = $$('#regionRows .reg-row').map((row) => {
    const name = $('.cat-name', row).value.trim();
    const old = oldRegions.find((r) => r.name === row.dataset.orig) || { places: [] };
    return { name, places: $$('.chip', row).map((c) => old.places.find((x) => x.name === c.dataset.v) || { name: c.dataset.v, spots: [] }) };
  }).filter((r) => r.name);
  // Keyingi saqlashlar uchun: nomi o'zgargan kategoriya/viloyat va yangi to'plamlar endi shu holatda
  $$('#catRows .cat-row, #regionRows .reg-row').forEach((row) => { const n = $('.cat-name', row).value.trim(); if (n) row.dataset.orig = n; });
  $$('#fsRows .fs-row').forEach((row, i) => { if (db.featureSets[i]) row.dataset.id = db.featureSets[i].id; });
  if (quiet) { commit(true); listsSavedHint(); return; }
  save();
  alert('Saqlandi.');
}

function listsSavedHint() {
  const el = $('#listsSaved');
  if (!el) return;
  el.textContent = '✓ Saqlandi';
  el.classList.add('show');
  clearTimeout(listsSavedHint.t);
  listsSavedHint.t = setTimeout(() => el.classList.remove('show'), 1800);
}

// Ro'yxatlar sahifasidagi har bir o'zgarishdan keyin (bir oz kutib) o'zi saqlaydi
let listsTimer = null;
function scheduleListsSave() {
  if (!$('#catRows') || !isAdmin()) return;
  clearTimeout(listsTimer);
  listsTimer = setTimeout(() => {
    // Endi qo'shilgan, hali nomi yozilmagan qator bo'lsa — nom yozilguncha kutamiz (u yo'qolib qolmasin)
    if ($$('#catRows .cat-name, #regionRows .cat-name').some((i) => !i.value.trim())) return;
    saveLists(true);
  }, 700);
}
document.addEventListener('change', (e) => { if (e.target.closest?.('.lists-page')) scheduleListsSave(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest?.('.lists-page .chip-add')) setTimeout(scheduleListsSave); });
document.addEventListener('click', (e) => {
  const act = e.target.closest?.('.lists-page [data-act]')?.dataset.act;
  if (act && ['chipRemove', 'catDel', 'regDel', 'fsDel', 'fsFieldDel', 'catIconSet'].includes(act)) setTimeout(scheduleListsSave);
});
// Sahifadan chiqib ketilsa yoki dastur yopilsa — kutib turgan saqlash darhol bajariladi
const flushLists = () => { if (listsTimer) { clearTimeout(listsTimer); listsTimer = null; if ($('#catRows') && isAdmin() && !$$('#catRows .cat-name, #regionRows .cat-name').some((i) => !i.value.trim())) saveLists(true); } };
window.addEventListener('hashchange', flushLists, true);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushLists(); });

// ---------- Ro'yxatlar: kategoriya va turni o'chirish / nomini o'zgartirish ----------
// O'chirish tugmasi, klaviaturadagi Delete yoki o'ng tugma (telefonda — bosib turish) menyusi orqali.
// Ichida mahsulot bo'lsa — ularni boshqa joyga ko'chirish, birga o'chirish yoki tegmaslik so'raladi.
const catRowName = (row) => row.dataset.orig || $('.cat-name', row).value.trim();
const catRowsNow = () => $$('#catRows .cat-row').map((r) => ({ row: r, name: $('.cat-name', r).value.trim(), types: $$('.cat-types .chip', r).map((c) => c.dataset.v) })).filter((x) => x.name);

function removeCatEntry(kind, row, chip) {
  if (!row) return;
  const cat = catRowName(row);
  const type = chip?.dataset.v;
  const label = kind === 'type' ? `«${type}» turi` : `«${cat || 'Nomsiz'}» kategoriyasi`;
  const list = cat ? db.products.filter((p) => p.category === cat && (kind !== 'type' || p.type === type)) : [];
  const drop = () => { if (kind === 'type') chip.remove(); else row.remove(); };
  if (!list.length) {
    if (confirm(`${label} o'chirilsinmi?`)) { drop(); scheduleListsSave(); }
    return;
  }
  // Ko'chirish mumkin bo'lgan joylar (sahifadagi joriy holatdan)
  const rows = catRowsNow();
  const opts = [];
  if (kind === 'type') {
    opts.push([JSON.stringify([cat, '']), `${cat} — turi ko'rsatilmagan`]);
    rows.forEach((r) => r.types.forEach((t) => { if (!(r.name === cat && t === type)) opts.push([JSON.stringify([r.name, t]), `${r.name} › ${t}`]); }));
  } else {
    rows.filter((r) => r.row !== row).forEach((r) => {
      opts.push([JSON.stringify([r.name, null]), `${r.name} (turi saqlanadi, bo'lsa)`]);
      r.types.forEach((t) => opts.push([JSON.stringify([r.name, t]), `${r.name} › ${t}`]));
    });
  }
  const used = list.filter((p) => db.docs.some((d) => d.items.some((it) => it.productId === p.id))).length;
  openModal({
    title: `${label}ni o'chirish`,
    submitText: "O'chirish",
    body: `<div class="del-cat">
      <p>${kind === 'type' ? 'Bu turda' : 'Bu kategoriyada'} <b>${list.length} ta mahsulot</b> bor. Ular bilan nima qilamiz?</p>
      <label class="check"><input type="radio" name="how" value="move" ${opts.length ? 'checked' : 'disabled'}> Mahsulotlarni boshqa joyga ko'chirish</label>
      ${opts.length ? `<select name="to" class="del-to">${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>` : ''}
      <label class="check"><input type="radio" name="how" value="delete"> Mahsulotlar bilan birga o'chirish</label>
      ${used ? `<p class="muted small del-note">${used} tasi sotuv/kirim hujjatlarida ishlatilgan — ular o'chirilmaydi, arxivga o'tadi.</p>` : ''}
      <label class="check"><input type="radio" name="how" value="keep" ${opts.length ? '' : 'checked'}> Mahsulotlarga tegmaslik (faqat ro'yxatdan olib tashlash)</label>
      <ul class="muted small del-list">${list.slice(0, 8).map((p) => `<li>${esc(p.name)}</li>`).join('')}${list.length > 8 ? `<li>… yana ${list.length - 8} ta</li>` : ''}</ul></div>`,
    onOpen: () => { $('#modalBody .del-to')?.addEventListener('change', () => { $('#modalBody [name=how][value=move]').checked = true; }); },
    onSubmit: async (d) => {
      const how = d.how || 'keep';
      if (how === 'delete' && !confirm(`${label} va undagi ${list.length} ta mahsulot o'chirilsinmi? Buni qaytarib bo'lmaydi.`)) return false;
      if (how !== 'delete' && !confirm(`${label} o'chirilsinmi?`)) return false;
      const photos = [];
      if (how === 'move' && d.to) {
        const [toCat, toType] = JSON.parse(d.to);
        const toTypes = (rows.find((r) => r.name === toCat) || { types: [] }).types;
        list.forEach((p) => { p.category = toCat; p.type = toType === null ? (toTypes.includes(p.type) ? p.type : '') : toType; });
      } else if (how === 'delete') {
        const usedIds = new Set(db.docs.flatMap((x) => x.items.map((it) => it.productId)));
        list.forEach((p) => { if (usedIds.has(p.id)) p.archived = true; else photos.push(...(p.photos || []).flatMap((ph) => [ph.path, ph.thumb])); });
        const gone = new Set(list.filter((p) => !usedIds.has(p.id)).map((p) => p.id));
        db.products = db.products.filter((p) => !gone.has(p.id));
      }
      drop();
      saveLists(true);
      if (photos.length) commitQueue.then(() => backend.deletePhotos?.(photos.filter(Boolean)));
    },
  });
}

function renameCatType(row, chip) {
  const cat = catRowName(row);
  const old = chip.dataset.v;
  const v = (prompt(`«${old}» turining yangi nomi:`, old) || '').trim();
  if (!v || v === old) return;
  if ($$('.cat-types .chip', row).some((c) => c !== chip && c.dataset.v.toLowerCase() === v.toLowerCase())) return alert(`«${v}» turi allaqachon bor.`);
  chip.outerHTML = editChip(v);
  db.products.forEach((p) => { if (p.category === cat && p.type === old) p.type = v; });
  // Turga xos xususiyatlardagi bog'lanish ham yangilanadi
  $$('#fsRows .fs-applies .chip').forEach((c) => { if (c.dataset.v === `${cat} › ${old}`) c.outerHTML = editChip(`${cat} › ${v}`); });
  saveLists(true);
}

function showCtxMenu(x, y, items) {
  $('#ctxMenu')?.remove();
  const m = document.createElement('div');
  m.id = 'ctxMenu';
  m.className = 'ctx-menu';
  m.innerHTML = items.map(([t, , danger], i) => `<button type="button" data-i="${i}" class="${danger ? 'danger' : ''}">${t}</button>`).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  m.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; close(); items[+b.dataset.i][1](); });
  window.addEventListener('scroll', close, { once: true, capture: true });
  m.querySelector('button')?.focus();
}

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('#catRows .cat-row');
  if (!row || e.target.closest('.chip-add') || e.target.closest('.cat-colors')) return;
  e.preventDefault();
  const chip = e.target.closest('.cat-types .chip');
  showCtxMenu(e.clientX, e.clientY, chip ? [
    ["✏️ Nomini o'zgartirish", () => renameCatType(row, chip)],
    ["🗑 Turni o'chirish", () => removeCatEntry('type', row, chip), true],
  ] : [
    ["✏️ Nomini o'zgartirish", () => { const i = $('.cat-name', row); i.focus(); i.select(); }],
    ["➕ Tur qo'shish", () => $('.cat-types .chip-add', row)?.focus()],
    ["🗑 Kategoriyani o'chirish", () => removeCatEntry('cat', row), true],
  ]);
});

// iPhone'da «contextmenu» chiqmaydi — tur yoki kategoriya ikonkasini bosib turish menyuni ochadi
(() => {
  let timer = null;
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest?.('#catRows .cat-types .chip, #catRows .cat-ic-btn');
    if (!el || e.target.closest('.chip-x')) return;
    const t = e.touches[0];
    timer = setTimeout(() => { timer = null; el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY })); }, 550);
  }, { passive: true });
  const stop = () => { clearTimeout(timer); timer = null; };
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => document.addEventListener(ev, stop, { passive: true }));
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#ctxMenu')?.remove();
  if (e.key !== 'Delete') return;
  const row = e.target.closest?.('#catRows .cat-row');
  if (!row || e.target.closest('.chip-add') || e.target.closest('.cat-colors')) return;
  const chip = e.target.closest('.cat-types .chip');
  if (chip) { e.preventDefault(); removeCatEntry('type', row, chip); return; }
  // Kategoriya nomida: butun nom belgilangan bo'lsa (Ctrl+A) — kategoriya o'chiriladi, aks holda oddiy harf o'chirish
  const inp = e.target.closest('.cat-name');
  if (inp && !(inp.value && inp.selectionStart === 0 && inp.selectionEnd === inp.value.length)) return;
  e.preventDefault();
  removeCatEntry('cat', row);
});

function backupAutoCard() {
  const tg = db.telegram;
  const hasToken = !!tg.token;
  const on = hasToken && tg.backupChatId;
  return `<div class="card narrow backup-auto"><h3>${icon('send')}Har kungi avtomatik zaxira — Telegramga</h3>
    <p class="muted">${backend.kind === 'supabase' ? "Server har kecha soat 02:00 da (dastur ochilmagan bo'lsa ham)" : 'Dastur har kuni (siz uni birinchi ochganingizda)'} barcha ma'lumotlarning zaxira faylini <b>sizning shaxsiy Telegramingizga</b> yuboradi. Telefon yo'qolsa yoki buzilsa ham ma'lumotlar Telegramda saqlanib qoladi; tiklash uchun o'sha faylni «Zaxiradan tiklash» ga tanlaysiz.</p>
    <div class="backup-status ${on ? 'ok' : 'warn'}">${icon(on ? 'check' : 'alert')}<span>${on
      ? `Yoqilgan. Oxirgi yuborilgan: <b>${tg.lastBackupAt ? fmtDateTime(tg.lastBackupAt) : 'hali yuborilmagan'}</b>${tg.backupError ? `<br><span class="debt">Oxirgi urinish xatosi: ${esc(tg.backupError)}</span>` : ''}`
      : 'Hali yoqilmagan.'}</span></div>
    ${hasToken ? `<ol class="muted small">
        <li>Telegramda o'z botingizni oching va <b>/start</b> yozing (guruhda emas, bot bilan shaxsiy chatda).</li>
        <li>Pastdagi «Mening Telegramimni aniqlash» tugmasini bosing.</li>
        <li>«Hozir yuborish» ni bosing — fayl Telegramingizga keladi.</li>
      </ol>
      <div class="toolbar">
        <button data-act="backupDetect">${icon('user')}Mening Telegramimni aniqlash</button>
        ${on ? `<button class="primary" data-act="backupSend">${icon('send')}Hozir yuborish</button>` : ''}
      </div>` : `<p class="muted small">Avval <a href="#settings/telegram">Sozlamalar → Telegram</a> da bot yarating va tokenini kiriting (5 daqiqa), so'ng shu yerga qayting.</p>`}
  </div>`;
}

function viewBackup() {
  const server = backend.kind === 'supabase';
  const last = lastBackupAt();
  const empty = !db.products.length && !db.docs.length;
  return backupAutoCard() + `<div class="card narrow"><h3>Zaxira nusxa</h3>
    <p class="muted small">Oxirgi zaxira: <b>${last ? fmtDateTime(last) : "hali olinmagan"}</b>${storagePersisted === true ? " · Brauzer xotirasi doimiy (o'zi o'chirilmaydi)" : ''}</p>
    <p class="muted">${server
      ? "Ma'lumotlar serverda saqlanadi. Shunga qaramay, haftada bir marta zaxira nusxa olib qo'ying. Rasmlar serverdagi xotirada qoladi, faylga faqat ularning manzili yoziladi."
      : "Ma'lumotlar shu brauzerda saqlanadi. Ularni yo'qotmaslik uchun har kuni zaxira nusxa oling. Fayl rasmlarni ham o'z ichiga oladi va undan serverga ko'chirishda ham foydalanish mumkin."}</p>
    <div class="toolbar">
      <button class="primary" data-act="backup">Zaxira nusxani yuklab olish (.json)</button>
      <label class="filebtn">Zaxiradan tiklash<input type="file" id="restoreInput" accept=".json,application/json" hidden></label>
    </div>
    <p class="muted small">Tiklashda joriy ma'lumotlar fayldagisi bilan to'liq almashtiriladi.</p></div>
    ${empty ? `<div class="card narrow"><h3>Namuna ma'lumotlar</h3><p class="muted">Dasturni sinab ko'rish uchun bir nechta mahsulot, kontragent va hujjat qo'shadi (faqat bo'sh dasturda).</p>
      <button data-act="demo">Namuna ma'lumotlarni yuklash</button></div>` : ''}
    <div class="card narrow"><h3>Tozalash</h3><p class="muted small">Barcha ma'lumotlarni o'chiradi. Oldin zaxira avtomatik yuklab olinadi va «O'CHIRISH» deb yozib tasdiqlash so'raladi.</p>
      <button class="danger" data-act="reset">Barcha ma'lumotlarni o'chirish</button></div>`;
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

// Profil: har bir foydalanuvchiga ochiq — parol, tungi mavzu, telefonga o'rnatish va chiqish
function viewProfile() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<div class="card narrow profile-card">
      <h3>${esc(me.name)}</h3>
      <p class="muted">${esc(ROLES[me.role] || '')} · login: <b>${esc(me.login || '')}</b></p>
      <div class="profile-actions">
        <button type="button" data-act="editMe">${icon('users')}<span>Ism va parolni o'zgartirish</span></button>
        <button type="button" data-act="toggleTheme">${icon(dark ? 'sun' : 'moon')}<span>${dark ? 'Kunduzgi mavzuga o\'tish' : 'Tungi mavzuga o\'tish'}</span></button>
        <button type="button" data-act="goInstall">${icon('phone')}<span>Telefonga o'rnatish</span></button>
        <button type="button" class="danger" data-act="logout">${icon('logout')}<span>Chiqish</span></button>
      </div>
    </div>`;
}

function viewServer() {
  const server = backend.kind === 'supabase';
  const local = server && localDataSummary();
  return `<div class="card narrow"><h3>Server</h3>
    <p><b>${esc(backend.label)}</b></p>
    <p class="muted">${server
      ? "Barcha qurilmalar shu bitta bazada ishlaydi. Bir qurilmadagi o'zgarish boshqalarida bir necha soniyada ko'rinadi."
      : "Ma'lumotlar faqat shu qurilmada. Sotuvchilar telefondan ishlashi uchun Supabase serveriga ulaning (README → \"Supabase'ni sozlash\"). Ulangandan keyin shu sahifada «Serverga ko'chirish» tugmasi chiqadi — shu qurilmadagi barcha ma'lumotlar (rasmlari bilan) serverga o'tadi."}</p>
    ${serverLocked() ? '<p class="muted small">Sayt shu serverga doimiy ulangan (config.js).</p>' : `<button class="primary" data-act="serverSettings">${server ? 'Ulanish sozlamalari' : 'Serverga ulanish'}</button>`}</div>
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

// ---------- Zaxira nusxa: ma'lumot yo'qolmasligi uchun ----------
// Qo'lda yuklab olish + har kuni avtomatik ravishda administratorning shaxsiy Telegramiga yuborish.
const BACKUP_KEY = 'biznes-tizim-last-backup';

function lastBackupAt() {
  let local = '';
  try { local = localStorage.getItem(BACKUP_KEY) || ''; } catch (e) { /* xotira yopiq */ }
  return [local, db.telegram?.lastBackupAt || ''].filter(Boolean).sort().pop() || '';
}
const backupAgeDays = () => (lastBackupAt() ? (Date.now() - Date.parse(lastBackupAt())) / 864e5 : Infinity);
function markBackup() {
  try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch (e) { /* xotira yopiq */ }
}
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

async function buildBackup(quiet = false) {
  let data;
  if (backend.kind === 'local') {
    if (!quiet) showLoading(true, 'Zaxira tayyorlanmoqda...');
    try { data = await backend.exportWithPhotos(); } finally { if (!quiet) showLoading(false); }
  } else {
    data = JSON.parse(JSON.stringify(db));
    data.seq = countersFromData(data);
  }
  data.users = db.users.map(({ id, name, login, role, perms }) => ({ id, name, login, role, perms }));
  data.exportedAt = new Date().toISOString();
  return data;
}

async function backupData() {
  const data = await buildBackup();
  download(`biznes-tizim-zaxira-${today()}.json`, JSON.stringify(data), 'application/json');
  markBackup();
  render();
}

// Zaxira faylini administratorning shaxsiy Telegram chatiga yuborish
async function sendBackupToTelegram(quiet = false) {
  const { token, backupChatId } = db.telegram;
  if (!token || !backupChatId) throw new Error("Bot tokeni yoki sizning Telegram ID'ingiz kiritilmagan.");
  const data = await buildBackup(quiet);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const fd = new FormData();
  fd.append('chat_id', backupChatId);
  fd.append('document', new Blob([JSON.stringify(data)], { type: 'application/json' }), `biznes-tizim-zaxira-${stamp}.json`);
  fd.append('caption', `📦 Biznes Tizim — zaxira nusxa\n${fmtDateTime(data.exportedAt)}\nMahsulot: ${data.products?.length || 0} · Hujjat: ${data.docs?.length || 0} · To'lov: ${data.payments?.length || 0}\n\nTiklash: Sozlamalar → Zaxira nusxa → Zaxiradan tiklash`);
  if (!quiet) showLoading(true, 'Telegramga yuborilmoqda...');
  try {
    await telegramCall('sendDocument', fd);
  } finally {
    if (!quiet) showLoading(false);
  }
  db.telegram.lastBackupAt = data.exportedAt;
  markBackup();
  await save();
}

// Har kuni bir marta (administrator dasturni ochganda) o'zi yuboradi
let autoBackupBusy = false;
async function autoBackup() {
  if (autoBackupBusy || !me || !isAdmin() || !db.telegram?.token || !db.telegram?.backupChatId) return;
  const last = db.telegram.lastBackupAt ? Date.parse(db.telegram.lastBackupAt) : 0;
  if (Date.now() - last < 20 * 3600e3) return;
  autoBackupBusy = true;
  try {
    await sendBackupToTelegram(true);
  } catch (e) {
    console.warn('Avtomatik zaxira:', e);
    db.telegram.backupError = e.message;
  } finally {
    autoBackupBusy = false;
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoBackup(); });

// Brauzerdan "doimiy xotira" so'raymiz: telefon xotirasi to'lsa ham dastur ma'lumotlari o'chirilmaydi
let storagePersisted = null;
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return;
    storagePersisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch (e) { /* qo'llab-quvvatlanmaydi */ }
}

// Shaxsiy chat ID: administrator botga /start yozadi, so'ng shu tugma bosiladi
async function detectBackupChat() {
  if (!db.telegram.token) return alert("Avval Sozlamalar → Telegram da bot tokenini kiriting.");
  try {
    const priv = (await botUpdates()).map((u) => u.message?.chat).filter((c) => c && c.type === 'private').pop();
    if (!priv) return alert("Topilmadi. Telegramda botingizni oching, «/start» yoki istalgan xabar yozing va qayta bosing.");
    db.telegram.backupChatId = String(priv.id);
    await save();
    alert(`Topildi: ${[priv.first_name, priv.last_name].filter(Boolean).join(' ')} (${priv.id}). Endi «Hozir yuborish» ni bosing.`);
  } catch (e) {
    alert('Xato: ' + e.message);
  }
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
  // Lokal nusxa o'chirilmaydi — qo'shimcha zaxira bo'lib shu telefonda qoladi
  if (false) {
    localStorage.removeItem(LOCAL_DATA_KEY);
    render();
  }
}

async function loadDemo() {
  if (db.products.length && !confirm("Namuna ma'lumotlar mavjud ma'lumotlarga qo'shiladi. Davom etilsinmi?")) return;
  const sup = { id: uid(), name: '"Mebel Lux" MChJ', kind: 'supplier', phone: '+998 71 200 00 00', address: 'Toshkent, Chilonzor', inn: '301234567', note: '' };
  const cus = { id: uid(), name: 'Aliyev Jamshid', kind: 'customer', ctype: 'Mebelchi', phone: '+998 90 111 22 33', address: "Toshkent, Yunusobod 4-kvartal", inn: '', note: '' };
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
  dashboard: viewDashboard, products: viewProducts, stock: viewStock, parties: () => viewParties(), customers: () => viewParties('customer'), suppliers: () => viewParties('supplier'), debts: viewDebts,
  payments: viewPayments, cash: viewCash, profit: viewProfit, top: viewTop, users: viewUsers,
  telegram: viewTelegram, company: viewCompany, warehouses: viewWarehouses, categories: viewCategories, backup: viewBackup,
  server: viewServer, profile: viewProfile, layout: viewLayout, drivers: viewDrivers, kits: viewKits, expenses: viewExpenses, expenseCats: viewExpenseCats, currency: viewCurrency, install: viewInstall, labels: viewLabels, labelDesign: viewLabelDesign,
};

function render() {
  // iPhone Safari'da (hali o'rnatilmagan bo'lsa) — qanday o'rnatishni ko'rsatamiz
  let hintOff = false;
  try { hintOff = localStorage.getItem('biznes-tizim-ios-hint') === '1'; } catch (e) { /* xotira yopiq */ }
  $('#iosHint').hidden = !(isIOS() && !isStandalone() && hostedUrl() && !hintOff);
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
  $('#sections').innerHTML = visibleSections().filter((s) => !s.hideInNav).map((s) => `<a href="#${s.id}" class="${s === section ? 'active' : ''}">${icon(s.icon)}<span>${s.title}</span></a>`).join('');
  const sub = section.views && visibleViews(section).find((v) => v[0] === view);
  renderAlertBanner();
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
  cardTables($('#view'));
  if (view === 'labelDesign') ldRefresh();
  else labelDraft = null;
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
    if (!confirm("Joriy ma'lumotlar zaxiradagisi bilan to'liq almashtiriladi. Avval joriy holatning zaxirasi yuklab olinadi. Davom etilsinmi?")) return;
    // Xato fayl tanlansa ham hozirgi ma'lumot yo'qolmasin
    backupData().then(() => runImport(data, false));
  });
});

const ACTIONS = {
  newDoc: (ds) => openDoc(ds.type),
  openDoc: (ds) => { const d = doc(ds.id); if (d) openDoc(d.type, d); },
  exportDocs: (ds) => exportDocs(ds.type),
  newProduct: () => newProduct(),
  newKit: () => editKit(null),
  newExpense: (ds) => newExpense(ds.cat),
  expTile: (ds) => openExpenseSubs(ds.cat),
  closeSale: (ds) => closeSale(ds.id),
  acceptHandover: (ds) => acceptHandover(ds.id),
  drvEdit: (ds) => editDriver(ds.id),
  drvDel: (ds) => { const d = driver(ds.id); if (d && confirm(`«${d.name}» o'chirilsinmi?`)) { db.drivers = db.drivers.filter((x) => x.id !== d.id); save(); } },
  drvLink: (ds) => shareDriverLink(ds.id),
  botSetup: () => botSetup(),
  sendDriver: (ds) => sendToDriver(ds.id, doc(ds.id)?.driverId),
  scanFilter: async (ds) => {
    const code = await scanCode();
    if (!code) return;
    const p = productByScan(code);
    if (p && ds.view === 'products') return editProduct(p.id);
    filters[ds.view + '.q'] = p ? p.code || p.name : code;
    render();
  },
  showReceipt: (ds) => showReceipts(db.payments.find((p) => p.id === ds.id)?.receipts),
  loMove: (ds) => moveLayout(ds),
  loOpen: (ds) => { filters['layout.open'] = filterVal('layout.open') === ds.sec ? '' : ds.sec; render(); },
  loReset: () => { if (!confirm("Bo'limlar va tablar asl tartibga qaytarilsinmi?")) return; db.uiOrder = { sections: [], tabs: {} }; save(); },
  expFilter: (ds) => { filters['expenses.cat'] = ds.cat || ''; render(); },
  ecAdd: () => { db.expenseCats = readExpenseCats(); db.expenseCats.push({ emoji: '📦', name: '' }); render(); $$('.ec-name').pop()?.focus(); },
  ecDel: (ds) => { const cats = readExpenseCats(); const c = (db.expenseCats || [])[+ds.i]; if (c && !confirm(`«${c.name}» moddasi o'chirilsinmi?`)) return; db.expenseCats = cats.filter((x) => x.name !== c?.name); save(); },
  staffAdd: () => { const v = $('#staffNew').value.trim(); if (!v) return; db.staffNames = [...new Set([...(db.staffNames || []), v])]; save(); },
  staffDel: (ds) => { const n = db.staffNames[+ds.i]; if (n && confirm(`«${n}» ro'yxatdan olib tashlansinmi?`)) { db.staffNames.splice(+ds.i, 1); save(); } },
  ecSave: async () => { db.expenseCats = readExpenseCats(); await save(); alert('Saqlandi.'); },
  editProduct: (ds) => editProduct(ds.id),
  deleteProduct: (ds) => deleteProduct(ds.id),
  unarchive: (ds) => { product(ds.id).archived = false; save(); },
  productHistory: (ds) => productHistory(ds.id),
  exportProducts: () => exportProducts(),
  tgProduct: (ds) => telegramPostProducts([ds.id], true),
  newParty: (ds) => { if (canAddParty()) newParty(ds.kind || filterVal('parties.kind') || 'customer'); },
  editParty: (ds) => editParty(ds.id),
  deleteParty: (ds) => deleteParty(ds.id),
  statement: (ds) => partyStatement(ds.id),
  newPayment: (ds) => newPayment(ds.dir),
  deletePayment: (ds) => deletePayment(ds.id),
  print: () => window.print(),
  tgSave: () => { tgReadForm(); save(); alert('Saqlandi.'); },
  tgDetect: () => tgDetect(),
  bfAdd: () => { tgReadForm(); db.telegram.bot.extra = [...(db.telegram.bot.extra || []), { q: '', a: '' }]; render(); },
  bfDel: (ds) => { tgReadForm(); db.telegram.bot.extra.splice(+ds.i, 1); save(); },
  tgTopicsCreate: () => tgTopicsCreate(),
  tgTopicIcons: () => tgTopicIcons(),
  tgTopicsReset: () => { if (confirm("Kategoriyalar va temalar bog'lanishi o'chirilsinmi? Keyingi e'londa temalar qayta yaratiladi.")) { db.telegram.topics = {}; save(); } },
  tgTest: () => tgTest(),
  tgAll: () => {
    const ids = db.products.filter((p) => !p.archived && qtyIn(ctx.stock, p.id) > 0).map((p) => p.id);
    if (!ids.length) return alert("Omborda mahsulot yo'q.");
    if (confirm(`${ids.length} ta mahsulot guruhga yuborilsinmi? Telegram cheklovi sababli har biri ~4 soniyada (jami ~${Math.ceil(ids.length * 4 / 60)} daqiqa); shu vaqt sahifani yopmang.`)) { tgReadForm(); commit(); telegramPostProducts(ids, true); }
  },
  coSave: () => {
    Object.assign(db.company, { name: $('#coName').value.trim(), phone: $('#coPhone').value.trim(), address: $('#coAddress').value.trim(), contractTerms: $('#coTerms').value.trim() });
    save();
    alert('Saqlandi.');
  },
  editWh: (ds) => editWarehouse(ds.id),
  deleteWh: (ds) => deleteWarehouse(ds.id),
  catSave: () => saveLists(),
  backup: () => backupData(),
  demo: () => {
    // Haqiqiy ma'lumotlar orasiga namuna aralashib ketmasin
    if (db.products.length || db.docs.length) return alert("Namuna ma'lumotlar faqat bo'sh dasturga yuklanadi — sizda allaqachon ma'lumotlar bor.");
    loadDemo();
  },
  reset: async () => {
    const word = prompt("Barcha mahsulot, hujjat, to'lov va kontragentlar o'chiriladi" + (backend.kind === 'supabase' ? ' — BARCHA qurilmalarda' : '') + ".\nOldin zaxira nusxa avtomatik yuklab olinadi.\n\nTasdiqlash uchun O'CHIRISH deb yozing:");
    if ((word || '').trim().toUpperCase() !== "O'CHIRISH") return;
    await backupData();
    db = Object.assign(emptyDb(), { users: db.users });
    save();
  },
  editUser: (ds) => editUser(ds.id),
  backupDetect: () => detectBackupChat(),
  backupSend: async () => {
    try {
      await sendBackupToTelegram();
      db.telegram.backupError = '';
      render();
      alert('Zaxira nusxa Telegramingizga yuborildi.');
    } catch (e) {
      alert('Yuborib bo\'lmadi: ' + e.message);
    }
  },
  photoView: (ds) => openLightbox(product(ds.id)?.photos || [], 0),
  catIconOpen: (ds, el) => {
    const grid = $('.cat-ic-grid', el.closest('.cat-row'));
    grid.hidden = !grid.hidden;
  },
  catIconSet: ({ ic }, el) => {
    const row = el.closest('.cat-row');
    row.dataset.icon = ic;
    $('.cat-ic-btn', row).innerHTML = icon(ic);
    $$('.cat-ic-grid button', row).forEach((b) => b.classList.toggle('on', b === el));
    $('.cat-ic-grid', row).hidden = true;
  },
  catFilter: ({ f, v }) => {
    filters[f] = v;
    // Kategoriya almashsa — tur filtri tozalanadi
    if (f.endsWith('.cat')) filters[f.replace('.cat', '.type')] = '';
    render();
  },
  chipToggle: (ds, el) => { el.classList.toggle('on'); syncChips(el.closest('.chips')); },
  chipOne: (ds, el) => {
    const box = el.closest('.chips');
    const on = !el.classList.contains('on');
    $$('.chip', box).forEach((c) => c.classList.remove('on'));
    el.classList.toggle('on', on);
    syncChips(box);
    if (box.dataset.ctl) refreshFeatures();
  },
  chipRemove: (ds, el) => {
    // Kategoriya turi — so'rab, mahsulotlari bilan nima qilishni tanlab o'chiriladi
    if (el.closest('#catRows .cat-types')) return removeCatEntry('type', el.closest('.cat-row'), el.closest('.chip'));
    el.closest('.chip').remove();
  },
  regAdd: () => {
    $('#regionRows').insertAdjacentHTML('beforeend', `<div class="cat-row reg-row" data-orig="">
      <div class="cat-head"><input class="cat-name" placeholder="Viloyat nomi">
        <button type="button" class="small danger icon-only" data-act="regDel" title="Olib tashlash">${icon('trash')}</button></div>
      ${chipEditor([], "+ Shahar/tuman qo'shish (Enter)")}</div>`);
    $('#regionRows .reg-row:last-child .cat-name').focus();
  },
  regDel: (ds, el) => el.closest('.reg-row').remove(),
  fsAdd: () => {
    $('#fsRows').insertAdjacentHTML('beforeend', fsRow());
    $('#fsRows .fs-row:last-child .fs-name').focus();
  },
  fsDel: (ds, el) => { if (confirm("Bu xususiyatlar to'plami olib tashlansinmi? (mahsulotlardagi qiymatlar o'chmaydi)")) el.closest('.fs-row').remove(); },
  fsFieldAdd: (ds, el) => {
    const box = $('.fs-fields', el.closest('.fs-row'));
    box.insertAdjacentHTML('beforeend', fsFieldRow());
    $('.fs-field:last-child .fs-fname', box).focus();
  },
  fsFieldDel: (ds, el) => el.closest('.fs-field').remove(),
  catAdd: () => {
    $('#catRows').insertAdjacentHTML('beforeend', catRow('', []));
    $('#catRows .cat-row:last-child .cat-name').focus();
  },
  catDel: (ds, el) => removeCatEntry('cat', el.closest('.cat-row')),

  serverSettings: () => { if (!serverLocked()) openServerSettings(); },
  rateRefresh: () => refreshRate(true),
  contract: (ds) => printContract(ds.id),
  debtPay: (ds) => { const d = doc(ds.id); newPayment('in', { counterpartyId: d.counterpartyId, docId: d.id }); },
  installApp: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    render();
  },
  dismissIosHint: () => {
    try { localStorage.setItem('biznes-tizim-ios-hint', '1'); } catch (e) { /* xotira yopiq */ }
    $('#iosHint').hidden = true;
  },
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
  editMe: () => editUser(me.id),
  goInstall: () => { location.hash = '#install'; },
  toggleTheme: () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); render(); },
  logout: () => logout(),
};

// ---------- Etiketkalar ----------
// Shablon millimetrlarda saqlanadi (db.company.labelTpl): o'lcham va har bir element joyi,
// eni, shrift kattaligi. Dizaynni administrator sozlaydi, chop etishni hamma qila oladi.

const LABEL_FIELDS = {
  company: { title: 'Kompaniya nomi', text: () => db.company.name || '' },
  name: { title: 'Mahsulot nomi', text: (p) => p.name },
  meta: { title: "O'lcham va rang", text: (p) => [p.size && p.size + ' sm', p.color].filter(Boolean).join(' · ') },
  path: { title: 'Kategoriya va tur', text: (p) => productPath(p) },
  price: { title: 'Narx', text: (p) => priceLabel(p) },
  code: { title: 'Artikul', text: (p) => (p.code ? 'Art: ' + p.code : '') },
  origin: { title: 'Ishlab chiqaruvchi', text: (p) => [p.maker, p.origin].filter(Boolean).join(', ') },
  attrs: { title: 'Xususiyatlar (krestovina, mexanizm...)', text: (p) => productAttrs(p).map(([, v]) => v).join(' · ') },
  barcode: { title: 'Shtrix-kod', kind: 'barcode' },
  qr: { title: 'QR-kod', kind: 'qr' },
};

const LABEL_SIZES = [[58, 40], [58, 30], [40, 30], [43, 25], [30, 20], [100, 70]];

const DEFAULT_LABEL = {
  w: 58,
  h: 40,
  gap: 2,
  els: {
    company: { on: true, x: 2, y: 1.5, w: 54, fs: 7, bold: false, align: 'center' },
    name: { on: true, x: 2, y: 4.5, w: 54, fs: 10, bold: true, align: 'center' },
    meta: { on: true, x: 2, y: 10, w: 54, fs: 7, bold: false, align: 'center' },
    path: { on: false, x: 2, y: 13, w: 54, fs: 6, bold: false, align: 'center' },
    price: { on: true, x: 2, y: 13.5, w: 54, fs: 18, bold: true, align: 'center' },
    code: { on: true, x: 2, y: 35, w: 54, fs: 7, bold: false, align: 'center' },
    origin: { on: false, x: 2, y: 31, w: 54, fs: 6, bold: false, align: 'center' },
    attrs: { on: false, x: 2, y: 31, w: 54, fs: 6, bold: false, align: 'center' },
    barcode: { on: true, x: 6, y: 23.5, w: 46, h: 11 },
    qr: { on: false, x: 44, y: 24, w: 12 },
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function labelTpl() {
  const saved = db.company.labelTpl || {};
  const t = Object.assign(clone(DEFAULT_LABEL), saved, { els: {} });
  for (const k of Object.keys(LABEL_FIELDS)) t.els[k] = Object.assign({}, DEFAULT_LABEL.els[k], saved.els?.[k]);
  return t;
}

const barcodeCache = new Map();
function barcodeSvg(value) {
  if (!window.JsBarcode || !value) return '';
  if (barcodeCache.has(value)) return barcodeCache.get(value);
  let out = '';
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    window.JsBarcode(svg, String(value), { format: 'CODE128', displayValue: false, margin: 0, height: 100, width: 2 });
    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.removeAttribute('style');
    out = svg.outerHTML;
  } catch (e) { /* kodda shtrix-kodga yaramaydigan belgi bor */ }
  barcodeCache.set(value, out);
  return out;
}

function labelQr(text) {
  if (!window.qrcode || !text) return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// design: dizaynerda bo'sh elementlar ham nomi bilan ko'rinadi (sudrab joylash uchun)
function labelElHtml(k, e, p, design) {
  const f = LABEL_FIELDS[k];
  const pos = `left:${e.x}mm;top:${e.y}mm;width:${e.w}mm;`;
  const ph = (t) => (design ? `<span class="le-ph">${esc(t)}</span>` : '');
  if (f.kind === 'barcode') return `<div class="le le-bc" data-el="${k}" style="${pos}height:${e.h}mm">${barcodeSvg(p.code) || ph("Shtrix-kod (artikul yo'q)")}</div>`;
  if (f.kind === 'qr') return `<div class="le le-qr" data-el="${k}" style="${pos}height:${e.w}mm">${labelQr(p.code || p.name) || ph('QR')}</div>`;
  const t = f.text(p);
  if (!t && !design) return '';
  let html = t ? esc(t) : ph(f.title);
  // Narx: raqam katta, "so'm" kichikroq va yonida (yoki umuman yo'q)
  if (k === 'price' && t) {
    const m = /^(.*?)\s*(so'm)$/.exec(t);
    if (m) html = esc(m[1]) + (e.cur === false ? '' : `<span class="le-cur"> so'm</span>`);
  }
  return `<div class="le" data-el="${k}" style="${pos}font-size:${e.fs}pt;font-weight:${e.bold ? 700 : 400};text-align:${e.align}">${html}</div>`;
}

function labelHtml(p, tpl, design = false) {
  return `<div class="lbl" style="width:${tpl.w}mm;height:${tpl.h}mm">${Object.entries(tpl.els)
    .filter(([k, e]) => e.on && LABEL_FIELDS[k]).map(([k, e]) => labelElHtml(k, e, p, design)).join('')}</div>`;
}

const LABEL_CSS = `.lbl{position:relative;overflow:hidden;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}
.lbl .le{position:absolute;line-height:1.15;overflow-wrap:anywhere}.lbl .le-cur{font-size:.5em;white-space:nowrap}
.lbl .le-bc svg,.lbl .le-qr svg{display:block;width:100%;height:100%}`;

// Printer turi qurilmaga bog'liq — shu qurilmada eslab qolinadi
function labelMode() {
  try { return localStorage.getItem('bt-label-mode') || 'roll'; } catch (e) { return 'roll'; }
}
function setLabelMode(m) {
  try { localStorage.setItem('bt-label-mode', m); } catch (e) { /* */ }
}

// items: [{ p, n }] — n nusxa
function printLabels(items, tpl = labelTpl()) {
  const list = items.filter((x) => x.p && x.n > 0);
  const total = list.reduce((s, x) => s + x.n, 0);
  if (!total) return alert('Chop etish uchun etiketka soni kiritilmagan.');
  if (total > 1000 && !confirm(`${total} ta etiketka chop etiladi. Davom etilsinmi?`)) return;
  const labels = list.map(({ p, n }) => labelHtml(p, tpl).repeat(n)).join('');
  const roll = labelMode() !== 'a4';
  const css = roll
    ? `@page{size:${tpl.w}mm ${tpl.h}mm;margin:0}body{margin:0}.lbl{break-after:page;page-break-after:always}.lbl:last-child{break-after:auto;page-break-after:auto}`
    : `@page{size:A4;margin:8mm}body{margin:0}.sheet{display:flex;flex-wrap:wrap;gap:${tpl.gap}mm}.lbl{outline:.2mm dashed #bbb;break-inside:avoid;page-break-inside:avoid}`;
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Etiketkalar</title>
    <style>${LABEL_CSS}${css}</style></head><body>${roll ? labels : `<div class="sheet">${labels}</div>`}</body></html>`);
}

function labelModeSelect() {
  const m = labelMode();
  return `<select id="labelMode" title="Printer turi"><option value="roll" ${m !== 'a4' ? 'selected' : ''}>Etiketka printeri (rulon)</option><option value="a4" ${m === 'a4' ? 'selected' : ''}>Oddiy printer (A4 varaq)</option></select>`;
}

// Bitta mahsulot uchun tez chop etish (mahsulotlar ro'yxati va kartochkadan)
function quickLabel(id) {
  const p = product(id);
  if (!p) return;
  const st = Math.max(0, qtyIn(ctx.stock, p.id));
  openModal({
    title: 'Etiketka: ' + p.name,
    body: `<div class="lbl-quick"><div class="lbl-view">${labelHtml(p, labelTpl())}</div>
      <div class="form-grid"><label>Nechta nusxa<input name="n" type="number" inputmode="numeric" min="1" step="1" value="1" required></label>
      <label>Printer${labelModeSelect()}</label></div>
      ${st ? `<button type="button" class="small" id="lqAll">Omborda borcha (${st})</button>` : ''}</div>`,
    submitText: 'Chop etish',
    onOpen: () => {
      $('#lqAll')?.addEventListener('click', () => { $('#modalBody [name=n]').value = st; });
    },
    onSubmit: (d) => {
      printLabels([{ p, n: Math.min(1000, Math.max(0, Math.round(num(d.n)))) }]);
    },
  });
}

// Qabul qilish / kirim hujjatidagi tovarlar — kelgan soni bo'yicha
function docLabels(id) {
  const d = doc(id);
  const items = d.items.map((it) => ({ p: product(it.productId), n: Math.max(0, Math.round(it.qty)) })).filter((x) => x.p);
  if (!items.length) return alert("Hujjatda mahsulot yo'q.");
  openModal({
    title: `Etiketkalar: ${DOC_TYPES[d.type].one} ${d.no}`,
    body: `<div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Nusxa</th></tr></thead><tbody>
      ${items.map((x, i) => `<tr><td>${esc(productLabel(x.p))}</td><td class="num"><input class="lq-in" type="number" inputmode="numeric" min="0" step="1" name="n${i}" value="${x.n}"></td></tr>`).join('')}
      </tbody></table></div><div class="form-grid" style="margin-top:12px"><label>Printer${labelModeSelect()}</label></div>`,
    submitText: 'Chop etish',
    onSubmit: (data) => {
      printLabels(items.map((x, i) => ({ p: x.p, n: Math.min(1000, Math.max(0, Math.round(num(data['n' + i])))) })));
    },
  });
}

// --- Etiketkalar sahifasi: qaysi mahsulotdan nechta ---

const labelQty = {};
const labelTotal = () => Object.values(labelQty).reduce((s, n) => s + n, 0);

function labelList() {
  const q = filterVal('labels.q').toLowerCase();
  const cat = db.categories.includes(filterVal('labels.cat')) ? filterVal('labels.cat') : '';
  return activeProducts()
    .filter((p) => !cat || p.category === cat)
    .filter((p) => !q || [p.name, p.code, p.type, p.color, p.size].join(' ').toLowerCase().includes(q));
}

function viewLabels() {
  const list = labelList();
  const first = product(Object.keys(labelQty).find((id) => labelQty[id] > 0)) || list[0];
  const rows = list.map((p) => {
    const st = qtyIn(ctx.stock, p.id);
    return `<tr>${thumbCell(p)}
      <td><b>${esc(p.name)}</b><div class="muted small">${esc([p.code, productPath(p)].filter(Boolean).join(' · '))}</div></td>
      <td class="num">${priceLabel(p)}</td><td class="num">${st}</td>
      <td class="num"><div class="lq"><button type="button" class="small icon-only" data-act="lqStep" data-id="${p.id}" data-d="-1">−</button><input class="lq-in" type="number" inputmode="numeric" min="0" step="1" data-lq="${p.id}" value="${labelQty[p.id] || ''}" placeholder="0"><button type="button" class="small icon-only" data-act="lqStep" data-id="${p.id}" data-d="1">+</button></div></td>
    </tr>`;
  }).join('');
  return toolbar('labels', {
    extra: `<button data-act="lqStock" title="Ro'yxatdagi har bir mahsulotga omborda nechta bo'lsa, shuncha">Omborda borcha</button>
      <button data-act="lqOne">Hammasiga 1 tadan</button>
      <button data-act="lqClear">Tozalash</button>`,
    buttons: `${labelModeSelect()}<button class="primary" data-act="lqPrint" id="lqPrintBtn">${icon('print')}Chop etish (${labelTotal()})</button>
      ${isAdmin() ? `<button data-act="ldOpen">${icon('edit')}Dizaynni sozlash</button>` : ''}`,
  }) + categoryBar('labels.cat', activeProducts()) + `<div class="lbl-page">
    <div class="card lbl-sample"><h3>Ko'rinishi</h3>${first ? `<div class="lbl-view">${labelHtml(first, labelTpl())}</div>` : '<p class="muted">Mahsulot yo\'q</p>'}
      <p class="muted small">${labelTpl().w}×${labelTpl().h} mm${isAdmin() ? ' · o\'lcham va joylashuv «Dizaynni sozlash» da o\'zgaradi' : ''}</p></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th></th><th>Mahsulot</th><th class="num">Narx</th><th class="num">Qoldiq</th><th class="num">Nusxa</th></tr></thead>
      <tbody>${rows || emptyRow(5, "Mahsulot yo'q")}</tbody></table></div></div></div>`;
}

function updateLabelTotal() {
  const b = $('#lqPrintBtn');
  if (b) b.innerHTML = `${icon('print')}Chop etish (${labelTotal()})`;
}

document.addEventListener('input', (e) => {
  const id = e.target.dataset?.lq;
  if (!id) return;
  const n = Math.max(0, Math.round(num(e.target.value)));
  if (n) labelQty[id] = Math.min(1000, n); else delete labelQty[id];
  updateLabelTotal();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'labelMode') setLabelMode(e.target.value);
});

Object.assign(ACTIONS, {
  labelOne: ({ id }) => quickLabel(id),
  ldOpen: () => { location.hash = '#goods/labelDesign'; },
  lqStep: ({ id, d }) => {
    const n = Math.max(0, (labelQty[id] || 0) + Number(d));
    if (n) labelQty[id] = n; else delete labelQty[id];
    const inp = $(`[data-lq="${id}"]`);
    if (inp) inp.value = n || '';
    updateLabelTotal();
  },
  lqStock: () => {
    labelList().forEach((p) => {
      const st = Math.round(qtyIn(ctx.stock, p.id));
      if (st > 0) labelQty[p.id] = Math.min(1000, st); else delete labelQty[p.id];
    });
    render();
  },
  lqOne: () => { labelList().forEach((p) => { labelQty[p.id] = 1; }); render(); },
  lqClear: () => { Object.keys(labelQty).forEach((k) => delete labelQty[k]); render(); },
  lqPrint: () => printLabels(Object.entries(labelQty).map(([id, n]) => ({ p: product(id), n }))),
});

// --- Etiketka dizayneri (faqat administrator) ---

let labelDraft = null;
let labelSel = 'price';
let labelSampleId = '';

const labelSample = () => product(labelSampleId) || activeProducts().find((p) => p.code) || activeProducts()[0]
  || { name: 'Divan «Milano»', code: 'DV-1024', size: '220×95×85', color: 'Kulrang', category: 'Yumshoq mebel', type: 'Divanlar', salePrice: 7500000 };

function viewLabelDesign() {
  if (!labelDraft) labelDraft = labelTpl();
  const t = labelDraft;
  const preset = LABEL_SIZES.find(([w, h]) => w === t.w && h === t.h);
  const sample = labelSample();
  return `<div class="ld" id="ld">
    <div class="card ld-stage">
      <div class="toolbar">
        <label class="inline">O'lcham <select id="ldSize">${LABEL_SIZES.map(([w, h]) => `<option value="${w}x${h}" ${preset && preset[0] === w && preset[1] === h ? 'selected' : ''}>${w} × ${h} mm</option>`).join('')}<option value="custom" ${preset ? '' : 'selected'}>Boshqa o'lcham</option></select></label>
        <label class="inline">Eni <input class="ld-num" type="number" inputmode="numeric" min="15" max="200" step="1" data-ld="w" value="${t.w}"> mm</label>
        <label class="inline">Bo'yi <input class="ld-num" type="number" inputmode="numeric" min="10" max="200" step="1" data-ld="h" value="${t.h}"> mm</label>
        <label class="inline">Namuna <select id="ldSample">${activeProducts().slice(0, 500).map((p) => `<option value="${p.id}" ${p === sample ? 'selected' : ''}>${esc(productLabel(p))}</option>`).join('')}</select></label>
      </div>
      <div class="ld-canvas"><div class="ld-wrap" id="ldWrap"></div></div>
      <p class="muted small">Elementni sichqoncha yoki barmoq bilan sudrab joyini o'zgartiring, o'ng pastki burchagidagi kvadratchani tortib kattalashtiring. Strelka tugmalari — 0,5 mm ga suradi.</p>
    </div>
    <div class="card ld-side">
      <h3>Elementlar</h3>
      <div class="ld-els">${Object.entries(LABEL_FIELDS).map(([k, f]) => `<div class="ld-el ${k === labelSel ? 'sel' : ''}" data-k="${k}">
        <input type="checkbox" data-ldon="${k}" ${t.els[k].on ? 'checked' : ''} title="Ko'rsatish"><span class="ld-el-name" data-act="ldSel" data-k="${k}">${esc(f.title)}</span></div>`).join('')}</div>
      <div id="ldProps"></div>
      <div class="toolbar ld-actions">
        <button class="primary" data-act="ldSave">${icon('check')}Saqlash</button>
        <button data-act="ldTest">${icon('print')}Sinov chop etish</button>
        <button data-act="ldUndo">Bekor qilish</button>
        <button class="danger" data-act="ldReset">Standart</button>
      </div>
      <div class="form-grid"><label>Printer (shu qurilmada)${labelModeSelect()}</label>
        <label>A4 da oraliq, mm<input class="ld-num" type="number" inputmode="decimal" min="0" max="20" step="0.5" data-ld="gap" value="${t.gap}"></label></div>
    </div>
  </div>`;
}

function ldProps() {
  const k = labelSel;
  const e = labelDraft.els[k];
  const f = LABEL_FIELDS[k];
  const field = (key, label, min, max, step) => `<label>${label}<div class="ld-range"><input type="range" min="${min}" max="${max}" step="${step}" data-lde="${key}" value="${e[key]}"><input class="ld-num" type="number" inputmode="numeric" min="${min}" max="${max}" step="${step}" data-lde="${key}" value="${e[key]}"></div></label>`;
  const text = !f.kind;
  return `<h3>${esc(f.title)}</h3>${e.on ? '' : '<p class="muted small">Bu element yashirilgan — yuqorida belgilang.</p>'}
    <div class="ld-props">
    ${text ? `${field('fs', 'Shrift kattaligi (pt)', 4, 60, 0.5)}
      <div class="ld-btns">
        <button type="button" class="small" data-act="ldFs" data-d="-1">A−</button><button type="button" class="small" data-act="ldFs" data-d="1">A+</button>
        <button type="button" class="small ${e.bold ? 'on' : ''}" data-act="ldBold"><b>Qalin</b></button>
        ${k === 'price' ? `<button type="button" class="small ${e.cur === false ? '' : 'on'}" data-act="ldCur">so'm</button>` : ''}
        ${['left', 'center', 'right'].map((a) => `<button type="button" class="small ${e.align === a ? 'on' : ''}" data-act="ldAlign" data-a="${a}">${{ left: 'Chapga', center: "O'rtaga", right: "O'ngga" }[a]}</button>`).join('')}
      </div>` : ''}
    ${field('w', f.kind === 'qr' ? "O'lchami (mm)" : 'Eni (mm)', 3, labelDraft.w, 0.5)}
    ${f.kind === 'barcode' ? field('h', "Bo'yi (mm)", 3, labelDraft.h, 0.5) : ''}
    ${field('x', 'Chapdan (mm)', 0, labelDraft.w, 0.5)}
    ${field('y', 'Tepadan (mm)', 0, labelDraft.h, 0.5)}
    <div class="ld-btns"><button type="button" class="small" data-act="ldCenter">Gorizontal o'rtaga</button><button type="button" class="small" data-act="ldFull">To'liq eniga</button></div>
    </div>`;
}

function ldDraw() {
  const wrap = $('#ldWrap');
  if (!wrap) return;
  const t = labelDraft;
  wrap.innerHTML = labelHtml(labelSample(), t, true);
  // Ekranga sig'adigan masshtab
  const avail = Math.min(wrap.parentElement.clientWidth - 24, 640);
  const k = Math.max(1, Math.min(4, avail / (t.w * 3.78)));
  const lbl = $('.lbl', wrap);
  lbl.style.transform = `scale(${k})`;
  wrap.style.width = `${t.w * 3.78 * k}px`;
  wrap.style.height = `${t.h * 3.78 * k}px`;
  const sel = $(`.le[data-el="${labelSel}"]`, lbl);
  if (sel) {
    sel.classList.add('sel');
    sel.insertAdjacentHTML('beforeend', '<span class="le-h"></span>');
  }
}

function ldRefresh(props = true) {
  ldDraw();
  if (props && $('#ldProps')) $('#ldProps').innerHTML = ldProps();
  $$('#ld .ld-el').forEach((el) => el.classList.toggle('sel', el.dataset.k === labelSel));
}

const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
const r05 = (v) => Math.round(v * 2) / 2;

// Element label ichidan chiqib ketmasin
function ldClamp(k) {
  const e = labelDraft.els[k];
  e.w = clampNum(e.w, 3, labelDraft.w);
  if (e.h != null) e.h = clampNum(e.h, 3, labelDraft.h);
  e.x = clampNum(e.x, 0, Math.max(0, labelDraft.w - e.w));
  e.y = clampNum(e.y, 0, Math.max(0, labelDraft.h - (e.h ?? (LABEL_FIELDS[k].kind === 'qr' ? e.w : 2))));
}

// O'lcham o'zgarsa — elementlar ham mutanosib ko'chadi
function ldResize(w, h) {
  const t = labelDraft;
  const kx = w / t.w;
  const ky = h / t.h;
  const kf = Math.min(kx, ky);
  for (const [k, e] of Object.entries(t.els)) {
    e.x = r05(e.x * kx);
    e.w = r05(e.w * kx);
    e.y = r05(e.y * ky);
    if (e.h != null) e.h = r05(e.h * ky);
    if (e.fs) e.fs = r05(Math.max(4, e.fs * kf));
    t.w = w; t.h = h;
    ldClamp(k);
  }
  t.w = w;
  t.h = h;
}

document.addEventListener('input', (e) => {
  if (!labelDraft || !e.target.closest('#ld')) return;
  const el = e.target;
  if (el.dataset.lde) {
    const key = el.dataset.lde;
    const v = num(el.value);
    labelDraft.els[labelSel][key] = v;
    ldClamp(labelSel);
    // range va son maydoni bir-biriga mos tursin
    $$(`#ldProps [data-lde="${key}"]`).forEach((x) => { if (x !== el) x.value = labelDraft.els[labelSel][key]; });
    ldDraw();
  } else if (el.dataset.ld === 'gap') {
    labelDraft.gap = clampNum(num(el.value), 0, 20);
  } else if (el.dataset.ld === 'w' || el.dataset.ld === 'h') {
    const w = el.dataset.ld === 'w' ? num(el.value) : labelDraft.w;
    const h = el.dataset.ld === 'h' ? num(el.value) : labelDraft.h;
    if (w < 15 || h < 10 || w > 200 || h > 200) return;
    ldResize(w, h);
    $('#ldSize').value = LABEL_SIZES.some(([a, b]) => a === w && b === h) ? `${w}x${h}` : 'custom';
    ldRefresh();
  }
});

document.addEventListener('change', (e) => {
  if (!labelDraft || !e.target.closest('#ld')) return;
  const el = e.target;
  if (el.id === 'ldSize' && el.value !== 'custom') {
    const [w, h] = el.value.split('x').map(Number);
    ldResize(w, h);
    $('#ld [data-ld="w"]').value = w;
    $('#ld [data-ld="h"]').value = h;
    ldRefresh();
  } else if (el.id === 'ldSample') {
    labelSampleId = el.value;
    ldDraw();
  } else if (el.dataset.ldon) {
    labelDraft.els[el.dataset.ldon].on = el.checked;
    labelSel = el.dataset.ldon;
    ldRefresh();
  }
});

// Sudrab ko'chirish va burchakdan kattalashtirish
document.addEventListener('pointerdown', (e) => {
  const le = e.target.closest('#ldWrap .le');
  if (!le || !labelDraft) return;
  e.preventDefault();
  const k = le.dataset.el;
  const resize = e.target.classList.contains('le-h');
  if (k !== labelSel) {
    labelSel = k;
    ldRefresh();
  }
  const lbl = $('#ldWrap .lbl');
  const pxPerMm = lbl.getBoundingClientRect().width / labelDraft.w;
  const el = labelDraft.els[k];
  const start = { x: e.clientX, y: e.clientY, ex: el.x, ey: el.y, ew: el.w, eh: el.h };
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / pxPerMm;
    const dy = (ev.clientY - start.y) / pxPerMm;
    if (resize) {
      el.w = r05(start.ew + dx);
      if (el.h != null) el.h = r05(start.eh + dy);
    } else {
      el.x = r05(start.ex + dx);
      el.y = r05(start.ey + dy);
    }
    ldClamp(k);
    ldDraw();
    ['x', 'y', 'w', 'h'].forEach((key) => $$(`#ldProps [data-lde="${key}"]`).forEach((x) => { x.value = el[key]; }));
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
});

// Strelkalar bilan aniq surish (yozish maydonida emas)
document.addEventListener('keydown', (e) => {
  if (!labelDraft || !$('#ldWrap') || $('#modal').open || e.target.closest('input, select, textarea')) return;
  const d = { ArrowLeft: [-0.5, 0], ArrowRight: [0.5, 0], ArrowUp: [0, -0.5], ArrowDown: [0, 0.5] }[e.key];
  if (!d) return;
  e.preventDefault();
  const el = labelDraft.els[labelSel];
  el.x += d[0];
  el.y += d[1];
  ldClamp(labelSel);
  ldRefresh();
});

Object.assign(ACTIONS, {
  ldSel: ({ k }, el) => {
    labelSel = k;
    ldRefresh();
  },
  ldFs: ({ d }) => {
    const e = labelDraft.els[labelSel];
    e.fs = clampNum(e.fs + Number(d), 4, 60);
    ldRefresh();
  },
  ldBold: () => {
    const e = labelDraft.els[labelSel];
    e.bold = !e.bold;
    ldRefresh();
  },
  ldCur: () => {
    const e = labelDraft.els[labelSel];
    e.cur = e.cur === false;
    ldRefresh();
  },
  ldAlign: ({ a }) => {
    labelDraft.els[labelSel].align = a;
    ldRefresh();
  },
  ldCenter: () => {
    const e = labelDraft.els[labelSel];
    e.x = r05((labelDraft.w - e.w) / 2);
    ldRefresh();
  },
  ldFull: () => {
    const e = labelDraft.els[labelSel];
    e.x = 1;
    e.w = labelDraft.w - 2;
    if (e.align) e.align = 'center';
    ldClamp(labelSel);
    ldRefresh();
  },
  ldTest: () => printLabels([{ p: labelSample(), n: 1 }], labelDraft),
  ldUndo: () => { labelDraft = labelTpl(); render(); },
  ldReset: () => {
    if (!confirm("Etiketka dizayni standart holatga qaytarilsinmi? (Saqlash bosilmaguncha o'zgarmaydi)")) return;
    labelDraft = clone(DEFAULT_LABEL);
    render();
  },
  ldSave: async () => {
    db.company.labelTpl = clone(labelDraft);
    await save();
    alert('Etiketka dizayni saqlandi.');
  },
});

// Sotuvchi tugmani ko'rmasa ham, bu amallarni bajara olmasligi kerak
// Ruxsatga bog'liq amallar (tugma ko'rinmasa ham bajarilmasin)
const ACTION_PERMS = { newKit: 'products', exportProducts: 'products' };
const ADMIN_ACTIONS = ['deleteProduct', 'unarchive', 'exportProducts', 'tgProduct', 'deleteParty', 'deletePayment',
  'ecAdd', 'ecDel', 'ecSave', 'staffAdd', 'staffDel', 'loMove', 'loReset', 'drvEdit', 'drvDel', 'drvLink', 'botSetup', 'tgSave', 'tgDetect', 'tgTest', 'tgAll', 'bfAdd', 'bfDel', 'tgTopicsCreate', 'tgTopicsReset', 'tgTopicIcons', 'coSave', 'editWh', 'deleteWh', 'catSave', 'catAdd', 'catDel', 'catIconOpen', 'catIconSet', 'fsAdd', 'fsDel', 'fsFieldAdd', 'fsFieldDel', 'regAdd', 'regDel', 'chipRemove', 'backup', 'backupDetect', 'backupSend', 'demo', 'reset', 'editUser', 'exportDocs',
  'serverSettings', 'refreshUsage', 'migrateLocal', 'rateRefresh', 'rateManual', 'rateAuto',
  'ldSel', 'ldFs', 'ldBold', 'ldCur', 'ldAlign', 'ldCenter', 'ldFull', 'ldTest', 'ldUndo', 'ldReset', 'ldSave'];

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#modal') && !el.closest('#modalBody')) return;
  e.preventDefault();
  if (ADMIN_ACTIONS.includes(el.dataset.act) && !isAdmin()) return;
  if (ACTION_PERMS[el.dataset.act] && !can(ACTION_PERMS[el.dataset.act])) return;
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
  if (box.classList.contains('chips-one')) $$('.chip', box).forEach((c) => c.classList.remove('on'));
  if (exists) {
    exists.classList.add('on');
  } else if (box.classList.contains('chips-one')) {
    input.insertAdjacentHTML('beforebegin', `<button type="button" class="chip on" data-act="chipOne" data-v="${esc(v)}">${esc(v)}</button>`);
    if (box.dataset.ctl) { syncChips(box); refreshFeatures(); return; }
  } else if (box.classList.contains('chips-pick')) {
    input.insertAdjacentHTML('beforebegin', `<button type="button" class="chip on" data-act="chipToggle" data-v="${esc(v)}">${esc(v)}</button>`);
  } else {
    input.insertAdjacentHTML('beforebegin', editChip(v));
  }
  input.value = '';
  syncChips(box);
});

$('#authForm').addEventListener('submit', onAuthSubmit);
$('#iosShareIc').innerHTML = icon('share');
$('#brandMark').innerHTML = icon('sofa');
$('#authLogo').innerHTML = icon('sofa');

// Mavzu: mayin jigarrang (kunduzgi) yoki tungi. Har bir qurilmada alohida eslab qolinadi.
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('biznes-tizim-theme', theme); } catch (e) { /* xotira yopiq */ }
}
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
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

// ---------- Yangilanish ----------
// Har bir yangi versiyada sw.js o'zgaradi. Ilova ochilganda / fondan qaytganda tekshiriladi;
// yangisi topilsa — sahifa o'zi qayta yuklanadi (ochiq oyna bo'lsa, u yopilgach).
const APP_VERSION = window.BT_VERSION || 'dev';
let swReg = null;
let reloadPending = false;

function reloadForUpdate() {
  if ($('#modal').open) { reloadPending = true; return; }
  location.reload();
}

async function checkForUpdate() {
  try { await swReg?.update(); } catch (e) { /* internet yo'q */ }
}

// Telefon ilovasi (Capacitor) o'z fayllarini o'zi beradi — service worker faqat brauzer uchun
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => { swReg = reg; checkForUpdate(); })
    .catch((e) => console.warn('Service worker:', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Birinchi o'rnatilishda emas, faqat yangi versiya kelganda
    if (!hadController || reloading) return;
    reloading = true;
    reloadForUpdate();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  setInterval(checkForUpdate, 20 * 60e3);
}
$('#modal').addEventListener('close', () => { if (reloadPending) location.reload(); });

// Versiya har sahifa pastida ko'rinadi — qaysi nusxa ochilganini bilish oson bo'lsin
$('#verFoot').textContent = `Biznes Tizim · versiya ${APP_VERSION}`;

// Saytdagi versiya bilan solishtiramiz: eski nusxa ochilgan bo'lsa ogohlantiramiz.
// Brauzer/o'rnatilgan sayt o'zi yangilanadi; Android ilovasi esa o'z ichidagi fayllardan ochiladi.
async function compareWithSite() {
  const site = hostedUrl() || window.BT_CONFIG?.siteUrl;
  if (!site || APP_VERSION === 'dev' || !navigator.onLine) return;
  let remote = '';
  try {
    const res = await fetch(new URL(`version.js?t=${Date.now()}`, site), { cache: 'no-store' });
    remote = /"([^"]+)"/.exec(await res.text())?.[1] || '';
  } catch (e) { return; }
  if (!remote || remote <= APP_VERSION) return;
  if (hostedUrl()) {
    // Bir marta o'zi yangilab ko'ramiz (takror aylanib qolmasligi uchun shu versiyaga bir marta)
    let tried = '';
    try { tried = sessionStorage.getItem('bt-update-tried'); sessionStorage.setItem('bt-update-tried', remote); } catch (e) { /* */ }
    if (tried !== remote) { await checkForUpdate(); reloadForUpdate(); return; }
  }
  const b = $('#updateBanner');
  b.innerHTML = window.Capacitor
    ? `Yangi versiya chiqdi (${esc(remote)}). Bu Android ilovasi o'zi yangilanmaydi — <a href="${esc(site)}" target="_blank" rel="noopener">saytni Chrome'da oching</a> va «Ilovani o'rnatish» ni bosing: u har doim o'zi yangilanadi.`
    : `Yangi versiya chiqdi (${esc(remote)}). <button type="button" class="small" data-act="reloadApp">Yangilash</button>`;
  b.hidden = false;
}
ACTIONS.reloadApp = async () => { await checkForUpdate(); location.reload(); };
setTimeout(compareWithSite, 4000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') compareWithSite(); });

// Ekranni pastga tortib yangilash (o'rnatilgan ilovada brauzerning o'z "tortish"i yo'q)
(function pullToRefresh() {
  const el = $('#ptr');
  const text = $('#ptrText');
  $('#ptrIc').innerHTML = icon('download');
  const LIMIT = 80;
  let startY = null;
  let dist = 0;
  const reset = () => {
    startY = null;
    dist = 0;
    el.classList.remove('show', 'ready');
    el.style.transform = '';
  };
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || $('#modal').open || e.touches.length > 1) return;
    if (e.target.closest('input, textarea, select, .table-wrap, .party-suggest, .subnav, #sections')) return;
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0 || window.scrollY > 0) { reset(); return; }
    const d = Math.min(dist, LIMIT * 1.5);
    el.classList.add('show');
    el.classList.toggle('ready', d >= LIMIT);
    el.style.transform = `translate(-50%, ${d * 0.6}px)`;
    text.textContent = d >= LIMIT ? "Qo'yib yuboring — yangilanadi" : 'Yangilash uchun torting';
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (startY === null) return;
    if (dist >= LIMIT) {
      text.textContent = 'Yangilanmoqda...';
      el.classList.add('busy');
      await checkForUpdate();
      location.reload();
      return;
    }
    reset();
  });
})();
