# kao-reels — KAO Mebel Telegram boti

Kontent va mijozlar bilan ishlash uchun Telegram bot. Bot yozadigan barcha matnlar o'zbek tilida, kirill yozuvida.

## Bot nima qiladi

| Tugma / buyruq | Vazifasi |
|---|---|
| 📝 Пост — `/post` | Matn, rasm yoki video yuborasiz. «🤖 AI матн ёзсин» tugmasi sotuvchi post matnini yozib beradi (rasmni ham ko'radi). Keyin post darhol kanalga joylanadi yoki belgilangan vaqtda chiqadi. |
| 🎬 Монтаж — `/montaj` | Bir nechta video, rasm va xohlasangiz musiqa yuborasiz. Bot ulardan vertikal 1080×1920 Reels video yig'adi: gorizontal kadrlar xira fon ustiga joylanadi, rasmlarga sekin zoom qo'shiladi, pastga brend nomi yoziladi. Tayyor videoni ham shu yerning o'zida post qilish mumkin. |
| 📅 Контент режа — `/reja` | Haftalik yoki o'zingiz aytgan davr uchun kontent reja: kun, format, mavzu, g'oya, vaqt. |
| 🗂 Навбат — `/navbat` | Rejalashtirilgan postlar ro'yxati, ularni o'chirish ham mumkin. |
| Mijozlar | Admin bo'lmagan odam botga yozsa, AI `business_info.md` faylidagi ma'lumot asosida javob beradi. Mijoz buyurtma bermoqchi bo'lsa, o'lchov so'rasa, shikoyat qilsa yoki fayl yuborsa, xabar menejerga boradi. Menejer o'sha xabarga **Reply** qilib javob yozsa, bot uni mijozga yetkazadi. |

## Sozlash (bir marta)

1. **Bot yarating:** Telegramda [@BotFather](https://t.me/BotFather) → `/newbot` → tokenni nusxalang.
2. **ID'ingizni biling:** [@userinfobot](https://t.me/userinfobot) ga yozing, u ID'ingizni aytadi.
3. **Kanalga qo'shing:** botni kanalingizga **admin** qilib qo'shing va unga «post joylash» huquqini bering.
4. **Claude API kaliti oling:** <https://console.anthropic.com> → API Keys (pullik, ishlatganingizcha to'laysiz).
5. `.env.example` faylidan nusxa olib, `.env` deb nomlang va to'ldiring.
6. **`business_info.md` faylini to'ldiring:** narxlar, manzil, telefon, ish vaqti, kafolat va hokazo. Bot mijozlarga **faqat** shu ma'lumot bilan javob beradi, shuning uchun bu fayl qanchalik to'liq bo'lsa, javoblar shunchalik yaxshi chiqadi.

## Ishga tushirish

Bot doim ishlab turishi uchun uni server (VPS) yoki hosting'da ishga tushirish kerak.

**Docker bilan (tavsiya etiladi):**
```bash
docker build -t kao-bot .
docker run -d --name kao-bot --restart always --env-file .env -v $(pwd)/data:/app/data kao-bot
```

**Docker'siz** (Python 3.11+ va `ffmpeg` o'rnatilgan bo'lishi kerak):
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m bot
```

## Cheklovlar

- Telegram boti 20 MB dan katta faylni yuklab ololmaydi. Montaj uchun qisqaroq yoki siqilgan video yuboring.
- Tayyor video 50 MB dan oshmasligi kerak (bot ko'pi bilan 90 soniyalik video yig'adi).
- Mijozlar bilan suhbat tarixi xotirada saqlanadi va bot qayta ishga tushganda o'chib ketadi. Rejalashtirilgan postlar esa `data/bot.db` faylida saqlanadi.
- AI uchun `claude-opus-5-5` modeli ishlatiladi.
