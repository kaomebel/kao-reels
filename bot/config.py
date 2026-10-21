import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader so the bot runs without extra dependencies."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


@dataclass(frozen=True)
class Config:
    bot_token: str
    admin_ids: frozenset[int]
    channel_id: str
    manager_chat_id: int
    tz: ZoneInfo
    brand_text: str
    business_info: str


def load_config() -> Config:
    _load_dotenv(ROOT / ".env")

    token = os.environ.get("BOT_TOKEN", "")
    if not token:
        raise SystemExit("BOT_TOKEN topilmadi. .env faylini to'ldiring (.env.example ga qarang).")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY topilmadi. .env faylini to'ldiring.")

    admin_ids = frozenset(
        int(x) for x in os.environ.get("ADMIN_IDS", "").replace(" ", "").split(",") if x
    )
    if not admin_ids:
        raise SystemExit("ADMIN_IDS bo'sh. O'z Telegram ID'ingizni yozing.")

    manager = os.environ.get("MANAGER_CHAT_ID", "").strip()
    info_path = ROOT / "business_info.md"

    return Config(
        bot_token=token,
        admin_ids=admin_ids,
        channel_id=os.environ.get("CHANNEL_ID", "").strip(),
        manager_chat_id=int(manager) if manager else min(admin_ids),
        tz=ZoneInfo(os.environ.get("TIMEZONE", "Asia/Tashkent")),
        brand_text=os.environ.get("BRAND_TEXT", "").strip(),
        business_info=info_path.read_text(encoding="utf-8") if info_path.exists() else "",
    )
