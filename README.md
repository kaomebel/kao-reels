# KAO AI yordamchi

Instagram, Telegram, YouTube va TikTok'dagi **direkt va komentariyalarga sizning uslubingizda javob beradigan**,
hamda **kontent plan tuzib, Reels montaj qilib, o'zi joylaydigan** dastur. AI qismi Claude'da ishlaydi.

## Nima qila oladi

| Platforma | Direkt | Komentariya | Video joylash |
|-----------|--------|-------------|---------------|
| Instagram | ✅ | ✅ | ✅ Reels (avtomatik montaj) |
| Telegram  | ✅ (Telegram Business orqali shaxsiy chatlaringiz + bot) | ✅ kanal komentlari | — |
| YouTube   | ❌ YouTube'da DM yo'q | ✅ | ✅ Shorts (ixtiyoriy) |
| TikTok    | ❌ TikTok DM API bermaydi | ✅ Business API orqali | ✅ (audit'gacha faqat shaxsiy) |

- **Sizdek yozadi**: `persona/style.md` (uslub), `persona/business.md` (narx, manzil, faktlar),
  `persona/examples.jsonl` (haqiqiy javoblaringiz) asosida.
- **Sizdan o'rganadi**: AI javobini Telegramda tuzatsangiz yoki Telegram'da mijozga o'zingiz yozsangiz,
  bu yangi namuna sifatida saqlanadi.
- **Xavfsiz**: shikoyat, savdolashish, noma'lum narx kabi holatlarda o'zi javob bermaydi — sizga yuboradi.
  Spam va haqoratga e'tibor bermaydi.
- **Kontent**: AI `media/library` dagi rasm/videolarga qarab N kunlik plan tuzadi, har bir post uchun
  9:16 Reels montaj qiladi (zoom effekti, o'tishlar, hook yozuvi, musiqa), caption va hashtag yozadi
  va belgilangan vaqtda joylaydi.

## Ikki rejim

- `REPLY_MODE=review` (boshlash uchun tavsiya): har bir javob sizga Telegramda keladi —
  **✅ Yuborish**, **❌ Bekor** yoki xabarga reply qilib to'g'ri matnni yozasiz.
- `REPLY_MODE=auto`: AI darhol javob beradi, faqat nozik holatlarni sizga yuboradi.
- `POST_MODE` ham xuddi shunday: `review` da tayyor video joylanishidan 1.5 soat oldin sizga keladi.

Bir-ikki hafta `review` da ishlatib, javoblar sizga yoqsa `auto` ga o'tkazing.

## O'rnatish

```bash
pip install -r requirements.txt      # ffmpeg ham o'rnatilgan bo'lishi kerak
cp .env.example .env                 # kalitlarni to'ldiring
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

yoki Docker: `docker build -t kao . && docker run --env-file .env -p 8000:8000 -v $PWD/data:/app/data -v $PWD/media:/app/media kao`

Serverga HTTPS kerak (Instagram webhook va video yuklash uchun) — masalan VPS + Caddy/nginx, yoki Railway/Render.

### 1. Uslubingizni o'rgating
1. `persona/style.md` va `persona/business.md` ni to'ldiring (narxlar, manzil, muddatlar).
2. `persona/examples.jsonl` ga eng yaxshi 20–50 ta haqiqiy javobingizni qo'shing (qancha ko'p bo'lsa, shuncha o'xshaydi).
3. Sinab ko'ring: `python -m app.cli reply "Assalomu alaykum, narxi qancha?"`

### 2. Telegram
1. @BotFather → yangi bot → tokenni `TELEGRAM_BOT_TOKEN` ga yozing.
2. Botga `/start` yozing — u ID ingizni aytadi → `OWNER_TELEGRAM_ID` ga yozing.
3. **Shaxsiy chatlaringizga javob** (Telegram Premium kerak): Sozlamalar → Telegram Business → Chatbotlar → botingiz.
4. **Kanal komentlari**: botni kanal muhokama guruhiga admin qiling.

Bot buyruqlari (faqat sizga): `/plan 7 maqsad`, `/status`, `/learn savol || javob`.

### 3. Instagram
1. Instagram hisobni **Professional** (Business/Creator) qiling.
2. developers.facebook.com → ilova → **Instagram API with Instagram Login** mahsuloti.
3. Ruxsatlar: `instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments`, `instagram_business_content_publish`.
4. Token va IG user ID ni `.env` ga yozing.
5. Webhook: `https://domeningiz/webhook/instagram`, verify token = `IG_VERIFY_TOKEN`,
   maydonlar: `messages`, `comments`.
6. Ilova "Live" rejimga o'tishi uchun Meta App Review kerak bo'ladi (o'z hisobingiz uchun dev rejim yetarli).

### 4. YouTube
Google Cloud → YouTube Data API v3 → OAuth client → `youtube.force-ssl` (+ `youtube.upload`) scope bilan
refresh token oling (masalan OAuth Playground orqali). Komentlar har 5 daqiqada tekshiriladi.

### 5. TikTok
- Komentlar: TikTok for Business developer ilovasi, Business hisob → `TIKTOK_BUSINESS_TOKEN`, `TIKTOK_BUSINESS_ID`.
- Video: Content Posting API → `TIKTOK_ACCESS_TOKEN`, `TIKTOK_UPLOAD=true`.
  TikTok ilovangizni audit qilmaguncha videolar faqat "shaxsiy" bo'lib chiqadi.
- Bu qism TikTok ruxsatlariga bog'liq — birinchi ulaganda loglarni tekshiring.

### 6. Kontent
1. Rasm va videolarni `media/library/` ga tashlang. **Fayl nomida nima borligini yozing**
   (masalan `ata-divan-kulrang-1.jpg`, `sex-tikish-jarayoni.mp4`) — AI shunga qarab tanlaydi.
   Papkalar ham bo'ladi: `media/library/ata/...`.
2. Musiqalarni `media/music/` ga tashlang (mualliflik huquqiga e'tibor bering).
3. Telegramda `/plan 14 yangi ATA divanni sotish` yoki `python -m app.cli plan --days 14`.
4. Montajni qo'lda sinash: `python -m app.cli montage media/library/a.jpg media/library/b.mp4 --hook "Yangi model"`.

Panel: `http://server:8000/` — kontent plan va oxirgi xabarlar.

## Tuzilishi

```
app/
  ai.py          Claude: uslubda javob + kontent plan
  responder.py   barcha platformalar uchun yagona javob oqimi (auto/review)
  montage.py     ffmpeg bilan Reels montaj
  scheduler.py   plan -> montaj -> tasdiq -> joylash
  platforms/     telegram, instagram, youtube, tiktok
  main.py        server (webhook, panel, fon vazifalari)
  cli.py         terminaldan sinash
persona/         sizning uslubingiz va biznes ma'lumotlari
media/library    xom rasm/videolar   media/music  musiqa   media/rendered  tayyor videolar
```
