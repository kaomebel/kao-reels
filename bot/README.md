# Moona bot

Telegram bot: videolarni yuborasiz, u ularni Instagram Reels uchun montaj qilib, tayyor MP4 ni qaytaradi.

## Bot nima qiladi

- Har bir videoni 1080×1920 (9:16) formatga keltiradi, sekin yaqinlashish effektini beradi.
- Har bir klipga ekrandagi yozuvni qo'yadi (standart: stol ssenariysi).
- Tepaga brend nomi yoki logotipni qo'yadi.
- Oxiriga 2,5 soniyalik yakuniy kadr qo'shadi: logotip, chaqiriq, telefon.
- Xohlasangiz, musiqa qo'shadi.
- Natijani ikki xil yuboradi: oddiy video va siqilmagan fayl.

## Ishlatish (Telegram'da)

1. Videolar yoki rasmlarni yuboring (bir nechtasini birdan ham bo'ladi).
2. Xohlasangiz, yozuvlarni matn qilib yuboring: har bir qator bitta klipga tushadi. Yozuvsiz video uchun `-` yuboring.
3. **🎬 15 s / 20 s / 30 s** tugmasidan birini bosing.
4. Taxminan 20–60 soniyada tayyor video keladi.

Buyruqlar: `/brend`, `/tel`, `/cta`, `/logo`, `/yozuv`, `/holat`, `/tozalash`, `/yordam`.

## Ishga tushirish

### 1. Bot tokenini olish
Telegram'da **@BotFather** ga yozing:
1. `/newbot` buyrug'ini yuboring.
2. Botga nom bering (masalan, `Moona`).
3. Username bering (masalan, `ata_moona_bot`).
4. BotFather token beradi. **Tokenni hech kimga bermang va chatga yozmang.**

### 2. Serverga qo'yish
Bot doim ishlab turishi uchun internetdagi serverda turishi kerak. Server sifatida oddiy VPS yoki Railway kabi xizmat ishlatiladi.

**VPS (Docker bilan):**
```bash
git clone https://github.com/kaomebel/kao-reels.git
cd kao-reels/bot
docker build -t moona .
docker run -d --name moona --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN="BU_YERGA_TOKEN" \
  -e ALLOWED_USERS="SIZNING_TELEGRAM_ID" \
  -v moona-data:/data moona
```

**Railway:**
1. GitHub repozitoriyani ulang.
2. Root Directory sifatida `bot` ni tanlang (Railway Dockerfile'ni o'zi topadi).
3. Variables bo'limiga `TELEGRAM_BOT_TOKEN` va `ALLOWED_USERS` ni qo'shing.
4. `/data` uchun Volume qo'shing.

### Sozlamalar (muhit o'zgaruvchilari)
| O'zgaruvchi | Ma'nosi |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather bergan token (majburiy) |
| `ALLOWED_USERS` | Botdan foydalana oladigan Telegram ID'lar, vergul bilan. Bo'sh qolsa, hamma foydalana oladi. ID'ingizni bilish uchun botga yozing: ruxsatsiz foydalanuvchiga u ID'ni o'zi aytadi. |
| `DATA_DIR` | Kliplar saqlanadigan papka (Docker'da `/data`) |
| `BOT_API_URL` | Ixtiyoriy: o'zingizning Telegram Bot API serveringiz manzili. Bu 20 MB cheklovini olib tashlaydi (pastga qarang). |

## 20 MB cheklovi
Telegram botlarga 20 MB dan katta faylni yuklab olishga ruxsat bermaydi. Shuning uchun videoni **fayl qilib emas, oddiy video qilib** yuboring. Shunda Telegram uni o'zi siqadi va 15–30 soniyalik klip odatda 20 MB ichiga sig'adi.

Katta fayllar ham kerak bo'lsa, [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) serverini alohida ishga tushirib, `BOT_API_URL` ni unga ko'rsating. Shunda chegara 2 GB bo'ladi. Buning uchun my.telegram.org saytidan `api_id` va `api_hash` olish kerak.

## Fayllar
- `bot.py`: Telegram bilan ishlash qismi.
- `montage.py`: ffmpeg orqali montaj. Uni botsiz ham chaqirsa bo'ladi.
- `fonts/Montserrat.ttf`: yozuvlar shrifti (SIL Open Font License, `fonts/OFL.txt`).
