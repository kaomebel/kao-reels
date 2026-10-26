# Biznes Tizim

Mebel do'koni uchun ombor, savdo va pul hisobi dasturi (MoySklad uslubida), o'zbek tilida.

## Imkoniyatlar

| Bo'lim | Nima qiladi |
|---|---|
| **Ko'rsatkichlar** | Bugungi va oylik savdo, foyda, pul qoldig'i, qarzlar, yaqin yetkazishlar, kam qolgan tovarlar |
| **Xaridlar** | Ta'minotchiga buyurtma → Qabul qilish → Ta'minotchiga qaytarish |
| **Savdo** | Mijoz buyurtmasi (rezerv bilan) → Jo'natish (sotuv) → Mijozdan qaytarish; yetkazish sanasi va manzili, chek chop etish |
| **Tovarlar** | Mahsulot kartochkasi (rasm, o'lcham, rang, material, ishlab chiqarilgan joyi), omborlar bo'yicha qoldiqlar, kirim qilish, hisobdan chiqarish, omborlararo ko'chirish, inventarizatsiya |
| **Kontragentlar** | Mijozlar va ta'minotchilar, o'zaro hisob-kitob (akt sverka), qarzlar |
| **Pul** | Kirim/chiqim to'lovlari (naqd, karta, hisob raqam), xarajat moddalari, kassa qoldig'i |
| **Hisobotlar** | Foyda va zarar (tannarx, xarajatlar, sof foyda), eng ko'p sotilganlar, kategoriyalar, mijozlar va sotuvchilar reytingi |
| **Telegram** | Omborga mahsulot kelganda uning rasmi, narxi, o'lchami, rangi, materiali, ishlab chiqarilgan joyi va omborda bor-yo'qligi guruhga avtomatik yuboriladi |

Qoldiq va qarzlar alohida saqlanmaydi: ular har safar hujjatlardan qayta hisoblanadi, shuning uchun hujjat tahrirlansa yoki o'chirilsa, hammasi avtomatik to'g'rilanadi. Tannarx qabul qilish narxlarining o'rtacha tortilgan qiymati bo'yicha hisoblanadi.

## Foydalanuvchilar

- **Administrator** — barcha bo'limlarga kiradi, foydalanuvchilarni qo'shadi.
- **Sotuvchi** — faqat savdo hujjatlari, mijozlar, kirim to'lovlari, mahsulot va qoldiqlarni ko'radi. Tannarx, foyda, xaridlar, kassa va sozlamalar unga ko'rinmaydi. Faqat o'zi yaratgan hujjatlarni o'zgartira oladi, hech narsani o'chira olmaydi.

Birinchi ochilganda administrator hisobi yaratiladi. Sotuvchilarni **Sozlamalar → Foydalanuvchilar** bo'limida qo'shasiz.

## Ishga tushirish

Dastur — oddiy HTML/JS ilova, o'rnatish talab qilinmaydi.

- **Kompyuterda sinash:** `index.html` faylini Chrome yoki Edge'da oching.
- **Telefon va kompyuterga ilova sifatida o'rnatish (PWA):** fayllarni HTTPS saytga joylang (masalan GitHub Pages: repo *Settings → Pages → Branch: main*), so'ng:
  - **Android:** Chrome'da saytni oching → ⋮ menyu → *Ilovani o'rnatish* (yoki *Bosh ekranga qo'shish*).
  - **iPhone/iPad:** Safari'da oching → *Ulashish* → *Bosh ekranga qo'shish* (Add to Home Screen).
  - **Windows:** Edge yoki Chrome'da oching → manzil qatoridagi *Ilovani o'rnatish* belgisi. Ilova alohida oynada, ish stolidagi ikonka orqali ochiladi.

  O'rnatilgandan keyin internet bo'lmasa ham ochiladi.

## Telegram sozlash

1. Telegramda **@BotFather** → `/newbot` → bot yarating va tokenni oling.
2. Botni guruhingizga qo'shing va administrator qiling.
3. Dasturda **Sozlamalar → Telegram**: tokenni kiriting, guruhga biror xabar yozing va *Guruh ID sini aniqlash* tugmasini bosing, so'ng *Sinov xabari*.

## Muhim cheklov (hozirgi bosqich)

Hozircha ma'lumotlar **har bir qurilmaning brauzerida alohida** saqlanadi. Bir nechta sotuvchi turli telefonlardan bitta bazada ishlashi uchun keyingi bosqichda server (ma'lumotlar bazasi) qo'shiladi. Shungacha **Sozlamalar → Zaxira nusxa** orqali muntazam nusxa oling.

## Fayllar

- `index.html` — sahifa tuzilmasi
- `styles.css` — dizayn
- `app.js` — butun dastur mantig'i
- `manifest.webmanifest`, `sw.js`, `icons/` — ilova sifatida o'rnatish va oflayn ishlash
