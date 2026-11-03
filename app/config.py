"""Barcha sozlamalar .env faylidan o'qiladi."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def env(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def flag(key: str, default: bool = False) -> bool:
    v = os.getenv(key)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on", "ha")


# --- Umumiy ---
TIMEZONE = env("TIMEZONE", "Asia/Tashkent")
PUBLIC_BASE_URL = env("PUBLIC_BASE_URL").rstrip("/")  # https://sizning-domen.uz
DB_PATH = ROOT / env("DB_PATH", "data/kao.db")
PERSONA_DIR = ROOT / "persona"
MEDIA_DIR = ROOT / "media"
LIBRARY_DIR = MEDIA_DIR / "library"
MUSIC_DIR = MEDIA_DIR / "music"
RENDER_DIR = MEDIA_DIR / "rendered"
FONT_PATH = env("FONT_PATH", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

# --- AI (Claude) ---
ANTHROPIC_MODEL = env("ANTHROPIC_MODEL", "claude-opus-5-5")
REPLY_EFFORT = env("REPLY_EFFORT", "low")  # javoblar uchun: tez va arzon
PLAN_EFFORT = env("PLAN_EFFORT", "high")  # kontent plan uchun: chuqurroq o'ylaydi

# auto   -> AI darhol javob yuboradi
# review -> AI javobni sizga Telegramda yuboradi, ✅ bossangiz ketadi
REPLY_MODE = env("REPLY_MODE", "review")
POST_MODE = env("POST_MODE", "review")
HISTORY_LIMIT = int(env("HISTORY_LIMIT", "12"))

# --- Telegram ---
TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN")
OWNER_TELEGRAM_ID = env("OWNER_TELEGRAM_ID")  # sizning shaxsiy Telegram ID raqamingiz

# --- Instagram (Instagram API with Instagram Login) ---
IG_USER_ID = env("IG_USER_ID")
IG_ACCESS_TOKEN = env("IG_ACCESS_TOKEN")
IG_APP_SECRET = env("IG_APP_SECRET")
IG_VERIFY_TOKEN = env("IG_VERIFY_TOKEN", "kao-verify")
IG_API = env("IG_API", "https://graph.instagram.com/v23.0")

# --- YouTube ---
YT_CLIENT_ID = env("YT_CLIENT_ID")
YT_CLIENT_SECRET = env("YT_CLIENT_SECRET")
YT_REFRESH_TOKEN = env("YT_REFRESH_TOKEN")
YT_CHANNEL_ID = env("YT_CHANNEL_ID")
YT_POLL_SECONDS = int(env("YT_POLL_SECONDS", "300"))
YT_UPLOAD_SHORTS = flag("YT_UPLOAD_SHORTS")

# --- TikTok ---
TIKTOK_ACCESS_TOKEN = env("TIKTOK_ACCESS_TOKEN")  # Content Posting API (video joylash)
TIKTOK_BUSINESS_TOKEN = env("TIKTOK_BUSINESS_TOKEN")  # Business API (komentlar)
TIKTOK_BUSINESS_ID = env("TIKTOK_BUSINESS_ID")
TIKTOK_POLL_SECONDS = int(env("TIKTOK_POLL_SECONDS", "600"))
TIKTOK_UPLOAD = flag("TIKTOK_UPLOAD")


def enabled(platform: str) -> bool:
    return {
        "telegram": bool(TELEGRAM_BOT_TOKEN),
        "instagram": bool(IG_USER_ID and IG_ACCESS_TOKEN),
        "youtube": bool(YT_CLIENT_ID and YT_REFRESH_TOKEN and YT_CHANNEL_ID),
        "tiktok": bool(TIKTOK_BUSINESS_TOKEN and TIKTOK_BUSINESS_ID),
    }[platform]
