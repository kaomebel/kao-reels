# Biznes Tizim

Mebel do'koni uchun ombor, savdo va pul hisobi dasturi (MoySklad uslubida), o'zbek tilida.

## Imkoniyatlar

| Bo'lim | Nima qiladi |
|---|---|
| **Ko'rsatkichlar** | Bugungi va oylik savdo, foyda, pul qoldig'i, qarzlar, yaqin yetkazishlar, kam qolgan tovarlar |
| **Xaridlar** | Ta'minotchiga buyurtma → Qabul qilish → Ta'minotchiga qaytarish |
| **Savdo** | Mijoz buyurtmasi (rezerv bilan) → Sotuv → Mijozdan qaytarish; mijozni telefon raqami bo'yicha avtomatik topish; yetkazish sanasi va manzili, chek chop etish |
| **Tovarlar** | Mahsulot kartochkasi (5 tagacha rasm, o'lcham, rang, material, ishlab chiqarilgan joyi), omborlar bo'yicha qoldiqlar, kirim qilish, hisobdan chiqarish, ko'chirish, inventarizatsiya |
| **Kontragentlar** | Mijozlar va ta'minotchilar, o'zaro hisob-kitob (akt sverka), qarzlar |
| **Pul** | Kirim/chiqim to'lovlari (naqd, karta, hisob raqam), xarajat moddalari, kassa qoldig'i |
| **Hisobotlar** | Foyda va zarar, eng ko'p sotilganlar, kategoriyalar, mijozlar va sotuvchilar reytingi |
| **Telegram** | Omborga mahsulot kelganda uning rasmlari (albom), narxi, o'lchami, rangi, materiali, ishlab chiqarilgan joyi va omborda bor-yo'qligi guruhga avtomatik yuboriladi |

## Foydalanuvchilar

- **Administrator** — barcha bo'limlar, foydalanuvchilarni qo'shadi va bloklaydi.
- **Sotuvchi** — savdo hujjatlari, mijozlar, kirim to'lovlari, mahsulot va qoldiqlar. Tannarx, foyda, xaridlar, kassa va sozlamalar unga ko'rinmaydi; faqat o'zi yaratgan hujjatlarni o'zgartiradi, hech narsani o'chira olmaydi. Supabase rejimida bu cheklovlar **serverning o'zida** (RLS qoidalari) tekshiriladi — sotuvchiga tannarx va xarid narxlari umuman yuborilmaydi.

## Ishlash rejimlari

| Rejim | Qachon | Ma'lumot qayerda |
|---|---|---|
| **Lokal** | Sinab ko'rish, bitta kompyuter | Shu brauzerda |
| **Supabase** | Do'konda haqiqiy ish, bir nechta sotuvchi va qurilma | Supabase serverida (PostgreSQL + rasmlar xotirasi) |

Supabase rejimida barcha qurilmalar bitta bazada ishlaydi va bir qurilmadagi o'zgarish boshqalarida bir necha soniyada ko'rinadi. Internet uzilib qolsa, dastur ogohlantiradi va ulanish tiklanganda saqlanmagan o'zgarishlarni o'zi yuboradi. Yangi hujjat yaratish uchun internet kerak (hujjat raqami serverda beriladi, shuning uchun bir vaqtda ishlayotgan sotuvchilarda raqam takrorlanmaydi).

## Supabase'ni sozlash (bir marta, ~10 daqiqa)

1. **supabase.com** → *Start your project* → GitHub yoki email bilan ro'yxatdan o'ting.
2. *New project*:
   - **Name:** `biznes-tizim`
   - **Database password:** kuchli parol o'ylab toping va **albatta saqlab qo'ying** (keyinchalik boshqa serverga ko'chishda kerak bo'ladi).
   - **Region:** *Central EU (Frankfurt)* — O'zbekistonga yaqinlaridan biri.
   - *Create new project* → 1–2 daqiqa kuting.
3. **Email tasdiqlashni o'chiring** (aks holda administrator qo'shgan sotuvchi emailini tasdiqlamaguncha kira olmaydi): *Authentication → Sign In / Providers → Email* → **Confirm email** — o'chiring → *Save*.
4. **Bazani yarating:** chap menyuda *SQL Editor* → *New query* → shu repodagi [`supabase/schema.sql`](supabase/schema.sql) faylining butun matnini joylang → **Run**. "Success" chiqishi kerak. (Qayta ishga tushirish xavfsiz.)
5. **Ulanish ma'lumotlarini oling:** *Project Settings → API* (yoki *API Keys*):
   - **Project URL** — `https://xxxxxxxx.supabase.co`
   - **anon / publishable key** — uzun kalit. *service_role / secret* kalitni hech qachon dasturga yozmang.
6. Dasturni oching → kirish oynasining pastidagi **Serverga ulanish** → URL va kalitni joylang → **Tekshirish va saqlash**.
7. **Administrator hisobi:** ismingiz, email va parol (kamida 6 belgi). Serverda birinchi ro'yxatdan o'tgan foydalanuvchi avtomatik administrator bo'ladi.
8. Avval lokal rejimda ma'lumot kiritgan bo'lsangiz: **Sozlamalar → Server → Serverga ko'chirish** (rasmlari bilan ko'chadi).
9. Sotuvchilarni qo'shing: **Sozlamalar → Foydalanuvchilar → + Foydalanuvchi** (email + parol). Ular shu email va parol bilan istalgan qurilmadan kiradi.

Har bir qurilmada URL va kalitni qayta kiritmaslik uchun ularni [`config.js`](config.js) fayliga yozib qo'yish mumkin — anon kalit ochiq kalit, uni saqlash xavfsiz.

**Bepul tarif:** 500 MB baza, 1 GB rasm, oyiga ~5 GB trafik — 1000 ta mahsulot (har biriga 3–4 rasm) uchun yetarli. Band joy **Sozlamalar → Server** da ko'rinadi, 80% dan oshsa bosh sahifada ogohlantirish chiqadi. Bepul loyiha 7 kun umuman ishlatilmasa to'xtatiladi (ma'lumot o'chmaydi, panelda qayta yoqiladi).

## Boshqa serverga ko'chish

- Baza — oddiy PostgreSQL: `pg_dump` bilan to'liq nusxa olinadi va istalgan PostgreSQL serverga yuklanadi.
- Rasmlar bazada nisbiy yo'l (`products/2026/abc.webp`) sifatida saqlanadi — fayllarni yangi xotiraga ko'chirish kifoya.
- Dastur serverga faqat [`backend.js`](backend.js) orqali murojaat qiladi — server almashganda faqat shu fayl o'zgaradi.
- **Sozlamalar → Zaxira nusxa** — barcha ma'lumotlar JSON faylga; boshqa tizimga tiklashda hujjat raqamlari ham to'g'ri davom etadi.

## Ilovalar (Windows, Android, iPhone)

Har push'da GitHub Actions ikkita ilovani yig'adi: repo → **Actions** → *Ilovalarni yig'ish* → oxirgi yashil ishga tushirish → pastdagi **Artifacts**:

- **Biznes-Tizim-Windows** — `Biznes-Tizim-Setup-1.0.0.exe`. Ishga tushiring → o'rnatiladi, ish stolida *Biznes Tizim* ikonkasi paydo bo'ladi. Ilova hozircha raqamli imzosiz, shuning uchun Windows "Windows protected your PC" deb ogohlantiradi: *More info → Run anyway*.
- **Biznes-Tizim-Android** — `Biznes-Tizim.apk`. Telefonga yuboring (Telegram orqali ham bo'ladi), ochib o'rnating. Telefon "noma'lum manbadan o'rnatish"ga ruxsat so'raydi — ruxsat bering.
- **iPhone/iPad** — App Store'ga chiqarish uchun Apple Developer hisobi kerak (yiliga 99 $). Shungacha iPhone'da veb-versiyani Safari orqali o'rnatish mumkin (pastda).

Birinchi ochilganda har bir ilovada *Serverga ulanish* orqali Supabase URL va kalitini kiritasiz (yoki ular `config.js` ga yozilgan bo'lsa, so'ralmaydi).

Telefon ilovasida zaxira faylini yuklab olish va chek chop etish ishlamaydi — buni Windows ilovasi yoki brauzerdan bajaring.

Play Market'ga chiqarish uchun Google Play Developer hisobi (bir martalik 25 $) va imzo kaliti kerak bo'ladi.

### Brauzer orqali o'rnatish (PWA)

Dasturni HTTPS saytga joylang (masalan GitHub Pages: repo *Settings → Pages → Branch*), so'ng:

- **Android:** Chrome → ⋮ → *Ilovani o'rnatish*.
- **iPhone/iPad:** Safari → *Ulashish* → *Bosh ekranga qo'shish*.
- **Windows:** Edge yoki Chrome → manzil qatoridagi *Ilovani o'rnatish* belgisi.

## Telegram sozlash

1. Telegramda **@BotFather** → `/newbot` → bot yarating va tokenni oling.
2. Botni guruhingizga qo'shing va administrator qiling.
3. Dasturda **Sozlamalar → Telegram**: tokenni kiriting, guruhga biror xabar yozing va *Guruh ID sini aniqlash*, so'ng *Sinov xabari*.

Supabase rejimida token serverda saqlanadi va faqat administratorga ko'rinadi.

## Fayllar

- `index.html`, `styles.css` — sahifa va dizayn
- `app.js` — dastur mantig'i (hisob-kitob, sahifalar)
- `backend.js` — ma'lumotlar qatlami (lokal / Supabase)
- `config.js` — Supabase ulanish ma'lumotlari (ixtiyoriy)
- `supabase/schema.sql` — baza sxemasi, ruxsatlar, server funksiyalari
- `vendor/supabase.js` — Supabase kutubxonasi (MIT litsenziya)
- `manifest.webmanifest`, `sw.js`, `icons/` — brauzer orqali o'rnatish (PWA)
- `desktop/main.js`, `package.json` — Windows ilovasi (Electron)
- `android/`, `capacitor.config.json` — Android ilovasi (Capacitor)
- `scripts/build-web.js` — ilovalar uchun veb-fayllarni `www/` ga yig'adi
- `.github/workflows/apps.yml` — ilovalarni avtomatik yig'ish
- `.github/workflows/pages.yml` — saytni https://kaomebel.github.io/kao-reels/ ga joylash (gh-pages branch)
