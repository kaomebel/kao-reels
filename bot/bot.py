"""Moona Telegram bot: send clips, get a finished 9:16 Reels video back.

Environment:
  TELEGRAM_BOT_TOKEN  token from @BotFather (required)
  ALLOWED_USERS       comma-separated Telegram user ids allowed to use the bot (empty = anyone)
  DATA_DIR            where clips and settings are kept (default ./data)
  BOT_API_URL         optional local Bot API server, e.g. http://telegram-bot-api:8081 (lifts the 20 MB limit)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.constants import ChatAction
from telegram.ext import (Application, ApplicationBuilder, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)

from montage import DEFAULT_CAPTIONS, Options, make_reel

logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
log = logging.getLogger("moona")

DATA = Path(os.environ.get("DATA_DIR", "data")).resolve()
ALLOWED = {int(x) for x in os.environ.get("ALLOWED_USERS", "").replace(" ", "").split(",") if x}
LOCAL_API = os.environ.get("BOT_API_URL", "").rstrip("/")
MAX_FILE = (2000 if LOCAL_API else 20) * 1024 * 1024

DEFAULTS = {"brand": "ATA MEBEL", "phone": "", "cta": "Narxi uchun direktga yozing", "captions": []}
locks: dict[int, asyncio.Lock] = {}
status_tasks: dict[int, asyncio.Task] = {}
waiting_logo: set[int] = set()

HELP = (
    "🎬 <b>Moona</b>: videolaringizdan Instagram Reels yasayman.\n\n"
    "<b>1.</b> Videolar yoki rasmlarni yuboring (bir nechtasini birdan ham bo'ladi).\n"
    "<b>2.</b> Xohlasangiz, yozuvlarni matn qilib yuboring: har bir qator bitta klipga tushadi.\n"
    "<b>3.</b> Pastdagi tugmadan uzunlikni tanlang: 15, 20 yoki 30 soniya.\n"
    "<b>4.</b> Tayyor videoni yuboraman. Uni saqlab, Instagram'ga joylaysiz.\n\n"
    "<b>Sozlamalar</b>\n"
    "/brend ATA MEBEL — brend nomi\n"
    "/tel +998 90 123 45 67 — telefon (oxirgi kadrda)\n"
    "/cta Narxi uchun direktga yozing — chaqiriq\n"
    "/logo — keyingi yuborgan rasmingiz logotip bo'ladi\n"
    "/yozuv — joriy yozuvlarni ko'rish\n"
    "/holat — nechta klip borligini ko'rish\n"
    "/tozalash — kliplarni o'chirib, yangidan boshlash\n\n"
    "🎵 Audio fayl yuborsangiz, u musiqa sifatida qo'shiladi."
)


# ---------- storage ----------
def chat_dir(chat_id: int) -> Path:
    d = DATA / str(chat_id)
    (d / "clips").mkdir(parents=True, exist_ok=True)
    return d


def load_settings(chat_id: int) -> dict:
    p = chat_dir(chat_id) / "settings.json"
    try:
        return {**DEFAULTS, **json.loads(p.read_text())}
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULTS)


def save_settings(chat_id: int, s: dict) -> None:
    (chat_dir(chat_id) / "settings.json").write_text(json.dumps(s, ensure_ascii=False, indent=1))


def clips_of(chat_id: int) -> list[Path]:
    return sorted(p for p in (chat_dir(chat_id) / "clips").iterdir() if p.is_file())


def find_file(chat_id: int, stem: str) -> Path | None:
    return next(iter(sorted(chat_dir(chat_id).glob(stem + ".*"))), None)


def menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🎬 15 s", callback_data="mk:15"),
         InlineKeyboardButton("🎬 20 s", callback_data="mk:20"),
         InlineKeyboardButton("🎬 30 s", callback_data="mk:30")],
        [InlineKeyboardButton("🗑 Tozalash", callback_data="clr")],
    ])


# ---------- access ----------
async def allowed(update: Update) -> bool:
    user = update.effective_user
    if not ALLOWED or (user and user.id in ALLOWED):
        return True
    if update.effective_message:
        await update.effective_message.reply_text(
            f"Bu bot shaxsiy. Egasidan sizni qo'shishini so'rang. Sizning ID: {user.id if user else '?'}")
    return False


# ---------- commands ----------
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if await allowed(update):
        await update.effective_message.reply_html(HELP)


async def set_field(update: Update, ctx: ContextTypes.DEFAULT_TYPE, key: str, label: str) -> None:
    if not await allowed(update):
        return
    chat = update.effective_chat.id
    s = load_settings(chat)
    value = " ".join(ctx.args).strip()
    s[key] = value
    save_settings(chat, s)
    await update.effective_message.reply_text(f"✅ {label}: {value or '(bo‘sh)'}")


async def brend(update, ctx): await set_field(update, ctx, "brand", "Brend")
async def tel(update, ctx): await set_field(update, ctx, "phone", "Telefon")
async def cta(update, ctx): await set_field(update, ctx, "cta", "Chaqiriq")


async def logo_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    chat = update.effective_chat.id
    if ctx.args and ctx.args[0] in ("off", "yoq", "o'chir"):
        for p in chat_dir(chat).glob("logo.*"):
            p.unlink()
        await update.effective_message.reply_text("Logotip olib tashlandi. Endi brend nomi yoziladi.")
        return
    waiting_logo.add(chat)
    await update.effective_message.reply_text(
        "Logotipni yuboring. Shaffof fonli PNG'ni fayl sifatida yuborsangiz, eng yaxshi chiqadi.\n"
        "Olib tashlash uchun: /logo off")


async def yozuv(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    s = load_settings(update.effective_chat.id)
    caps = s["captions"] or DEFAULT_CAPTIONS
    src = "sizniki" if s["captions"] else "standart (stol ssenariysi)"
    await update.effective_message.reply_text(
        f"Yozuvlar ({src}):\n" + "\n".join(f"{i+1}. {c}" for i, c in enumerate(caps)) +
        "\n\nO'zgartirish uchun yangi yozuvlarni matn qilib yuboring, har biri alohida qatorda."
        "\nYozuvsiz video uchun: -")


async def holat(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    chat = update.effective_chat.id
    n = len(clips_of(chat))
    music = "bor" if find_file(chat, "music") else "yo'q"
    logo = "bor" if find_file(chat, "logo") else "yo'q"
    await update.effective_message.reply_text(f"Kliplar: {n}\nMusiqa: {music}\nLogotip: {logo}",
                                              reply_markup=menu() if n else None)


async def tozalash(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    clear_clips(update.effective_chat.id)
    await update.effective_message.reply_text("🗑 Kliplar va musiqa o'chirildi. Yangi videolarni yuboring.")


def clear_clips(chat: int) -> None:
    shutil.rmtree(chat_dir(chat) / "clips", ignore_errors=True)
    for p in chat_dir(chat).glob("music.*"):
        p.unlink()
    chat_dir(chat)


# ---------- incoming media ----------
def media_of(msg: Message):
    """Returns (file object, extension, kind) for a message, or None."""
    if msg.video:
        return msg.video, ".mp4", "video"
    if msg.video_note:
        return msg.video_note, ".mp4", "video"
    if msg.photo:
        return msg.photo[-1], ".jpg", "image"
    if msg.animation:
        return msg.animation, ".mp4", "video"
    if msg.document:
        mt = msg.document.mime_type or ""
        ext = Path(msg.document.file_name or "").suffix.lower() or (".mp4" if mt.startswith("video/") else ".jpg")
        if mt.startswith("video/"):
            return msg.document, ext, "video"
        if mt.startswith("image/"):
            return msg.document, ext, "image"
        if mt.startswith("audio/"):
            return msg.document, ext, "audio"
    if msg.audio:
        return msg.audio, Path(msg.audio.file_name or "a.mp3").suffix or ".mp3", "audio"
    if msg.voice:
        return msg.voice, ".ogg", "audio"
    return None


async def on_media(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    msg, chat = update.effective_message, update.effective_chat.id
    got = media_of(msg)
    if not got:
        return
    f, ext, kind = got
    if f.file_size and f.file_size > MAX_FILE:
        await msg.reply_text(
            f"⚠️ Bu fayl {f.file_size/1048576:.0f} MB. Telegram botlarga 20 MB dan katta fayl bermaydi.\n"
            "Videoni <b>fayl qilib emas, oddiy video qilib</b> yuboring: Telegram uni o'zi siqadi.", parse_mode="HTML")
        return
    d = chat_dir(chat)
    if kind == "image" and chat in waiting_logo:
        dest = d / f"logo{ext if ext in ('.png', '.webp') else '.jpg'}"
        for p in d.glob("logo.*"):
            p.unlink()
    elif kind == "audio":
        for p in d.glob("music.*"):
            p.unlink()
        dest = d / f"music{ext}"
    else:
        dest = d / "clips" / f"{time.time_ns()}_{msg.message_id}{ext}"
    try:
        tg_file = await f.get_file()
        if LOCAL_API and tg_file.file_path and Path(tg_file.file_path).is_absolute():
            shutil.copy(tg_file.file_path, dest)       # local Bot API server stores files on disk
        else:
            await tg_file.download_to_drive(dest)
    except Exception as e:  # noqa: BLE001
        log.exception("download failed")
        await msg.reply_text(f"Faylni yuklab bo'lmadi: {e}")
        return
    if dest.stem == "logo":
        waiting_logo.discard(chat)
        await msg.reply_text("✅ Logotip saqlandi.")
    elif dest.stem == "music":
        await msg.reply_text("🎵 Musiqa saqlandi. U keyingi montajga qo'shiladi.")
    else:
        schedule_status(ctx, chat)


def schedule_status(ctx: ContextTypes.DEFAULT_TYPE, chat: int) -> None:
    """Several files sent together arrive as separate messages; answer once after they settle."""
    old = status_tasks.pop(chat, None)
    if old:
        old.cancel()

    async def later():
        await asyncio.sleep(2.0)
        n = len(clips_of(chat))
        await ctx.bot.send_message(chat, f"✅ Qabul qilindi. Jami kliplar: {n}.\nYana yuboring yoki uzunlikni tanlang:",
                                   reply_markup=menu())
    status_tasks[chat] = asyncio.create_task(later())


async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    chat = update.effective_chat.id
    text = (update.effective_message.text or "").strip()
    s = load_settings(chat)
    if text == "-":
        s["captions"] = [""]
        msg = "Yozuvlar o'chirildi: video yozuvsiz bo'ladi. Standartga qaytish uchun: /yozuv_standart"
    else:
        s["captions"] = [ln.strip() for ln in text.splitlines() if ln.strip()]
        msg = "✍️ Yozuvlar saqlandi:\n" + "\n".join(f"{i+1}. {c}" for i, c in enumerate(s["captions"]))
    save_settings(chat, s)
    await update.effective_message.reply_text(msg, reply_markup=menu() if clips_of(chat) else None)


async def yozuv_standart(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await allowed(update):
        return
    s = load_settings(update.effective_chat.id)
    s["captions"] = []
    save_settings(update.effective_chat.id, s)
    await update.effective_message.reply_text("Standart yozuvlar qaytarildi.")


# ---------- montage ----------
async def on_button(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    await q.answer()
    if not await allowed(update):
        return
    chat = update.effective_chat.id
    if q.data == "clr":
        clear_clips(chat)
        await q.message.reply_text("🗑 Tozalandi. Yangi videolarni yuboring.")
        return
    total = float(q.data.split(":")[1])
    lock = locks.setdefault(chat, asyncio.Lock())
    if lock.locked():
        await q.message.reply_text("⏳ Oldingi montaj hali tugamadi, biroz kuting.")
        return
    async with lock:
        clips = clips_of(chat)
        if not clips:
            await q.message.reply_text("Avval videolarni yuboring.")
            return
        s = load_settings(chat)
        opts = Options(total=total, brand=s["brand"], phone=s["phone"], cta=s["cta"], captions=s["captions"],
                       logo=find_file(chat, "logo"), music=find_file(chat, "music"))
        note = await q.message.reply_text(f"⏳ Montaj boshlandi: {len(clips)} ta klip, {total:.0f} soniya. Odatda 20–60 soniya oladi…")
        await ctx.bot.send_chat_action(chat, ChatAction.UPLOAD_VIDEO)
        out = chat_dir(chat) / f"reel_{int(total)}s.mp4"
        t0 = time.time()
        try:
            await asyncio.to_thread(make_reel, clips, opts, out)
        except Exception as e:  # noqa: BLE001
            log.exception("montage failed")
            await note.edit_text(f"❌ Montajda xato: {str(e)[:300]}")
            return
        await note.edit_text(f"✅ Tayyor ({time.time()-t0:.0f} s). Yuboryapman…")
        with out.open("rb") as fh:
            await ctx.bot.send_video(chat, fh, width=1080, height=1920, supports_streaming=True,
                                     caption="Tayyor! Saqlab, Instagram'ga joylang. Boshqa uzunlik kerak bo'lsa, tugmani bosing.",
                                     reply_markup=menu(), read_timeout=120, write_timeout=120)
        with out.open("rb") as fh:
            await ctx.bot.send_document(chat, fh, filename=f"moona_{int(total)}s.mp4",
                                        caption="Siqilmagan asl sifat (fayl ko'rinishida).",
                                        read_timeout=120, write_timeout=120)
        out.unlink(missing_ok=True)


def build() -> Application:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN o'rnatilmagan.")
    b = ApplicationBuilder().token(token).concurrent_updates(True)
    if LOCAL_API:
        b = b.base_url(f"{LOCAL_API}/bot").base_file_url(f"{LOCAL_API}/file/bot").local_mode(True)
    app = b.build()
    app.add_handler(CommandHandler(["start", "help", "yordam"], start))
    app.add_handler(CommandHandler("brend", brend))
    app.add_handler(CommandHandler("tel", tel))
    app.add_handler(CommandHandler("cta", cta))
    app.add_handler(CommandHandler("logo", logo_cmd))
    app.add_handler(CommandHandler("yozuv", yozuv))
    app.add_handler(CommandHandler("yozuv_standart", yozuv_standart))
    app.add_handler(CommandHandler("holat", holat))
    app.add_handler(CommandHandler("tozalash", tozalash))
    app.add_handler(CallbackQueryHandler(on_button))
    media = (filters.VIDEO | filters.PHOTO | filters.VIDEO_NOTE | filters.ANIMATION | filters.AUDIO | filters.VOICE
             | filters.Document.VIDEO | filters.Document.IMAGE | filters.Document.AUDIO)
    app.add_handler(MessageHandler(media, on_media))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    return app


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    log.info("Moona bot ishga tushdi")
    build().run_polling(allowed_updates=Update.ALL_TYPES)
