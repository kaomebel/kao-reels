"""Kontent plan: AI tuzadi -> vaqti kelganda montaj qilinadi -> (tasdiqlansa) joylanadi."""
import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import ai, config, db, montage

log = logging.getLogger("scheduler")
TZ = ZoneInfo(config.TIMEZONE)
RENDER_AHEAD = timedelta(minutes=90)  # review rejimida sizga oldindan yuboriladi


def _now():
    return datetime.now(TZ)


async def generate_plan(days: int = 7, per_day: int = 1, goals: str = "") -> list[dict]:
    files = montage.library_files()
    items = await ai.make_content_plan(days, per_day, files, goals)
    saved = []
    for it in items:
        if not it["media"]:
            log.warning("Postda media yo'q, o'tkazib yuborildi: %s", it["topic"])
            continue
        try:
            dt = datetime.fromisoformat(f"{it['date']}T{it['time']}").replace(tzinfo=TZ)
        except ValueError:
            continue
        if dt < _now():
            continue
        it["publish_at"] = dt.isoformat()
        it["id"] = db.add_plan_item(it)
        saved.append(it)
    log.info("Kontent plan: %d ta post qo'shildi", len(saved))
    return saved


def _caption(item) -> str:
    return f"{item['caption'].strip()}\n\n{item['hashtags']}".strip()


async def render_item(item) -> str:
    path = await asyncio.to_thread(
        montage.render, item["media"], item["hook"], f"post-{item['id']}"
    )
    db.update_plan(item["id"], status="rendered", video_path=str(path))
    return str(path)


async def publish_item(plan_id: int) -> str:
    """Tasdiqlangan postni joylaydi (vaqti kelmagan bo'lsa navbatga qo'yadi)."""
    from .platforms import instagram, tiktok, youtube

    item = db.plan_item(plan_id)
    if not item:
        return "Post topilmadi"
    if datetime.fromisoformat(item["publish_at"]) > _now() and item["status"] != "approved":
        db.update_plan(plan_id, status="approved")
        return f"✅ Tasdiqlandi, {item['publish_at'][:16].replace('T', ' ')} da joylanadi"

    path = Path(item["video_path"] or await render_item(item))
    caption, results = _caption(item), []
    try:
        if config.enabled("instagram"):
            if not config.PUBLIC_BASE_URL:
                raise RuntimeError("PUBLIC_BASE_URL kiritilmagan — Instagram videoni yuklab ololmaydi")
            url = f"{config.PUBLIC_BASE_URL}/media/rendered/{path.name}"
            results.append(f"instagram:{await instagram.publish_reel(url, caption)}")
        if config.YT_UPLOAD_SHORTS and config.enabled("youtube"):
            results.append(f"youtube:{await youtube.upload_short(path, item['hook'], caption)}")
        if config.TIKTOK_UPLOAD and config.TIKTOK_ACCESS_TOKEN:
            results.append(f"tiktok:{await tiktok.upload_video(path, caption)}")
    except Exception as e:
        log.exception("Joylashda xato")
        db.update_plan(plan_id, status="failed", result=str(e)[:1000])
        return f"❌ Xato: {str(e)[:300]}"
    db.update_plan(plan_id, status="published", result=", ".join(results))
    return "🚀 Joylandi: " + (", ".join(results) or "(hech qaysi platforma yoqilmagan)")


async def tick():
    from .platforms import telegram

    now = _now()
    for item in db.plan_items():
        at = datetime.fromisoformat(item["publish_at"])
        st = item["status"]
        try:
            if config.POST_MODE == "review":
                if st == "planned" and at - RENDER_AHEAD <= now:
                    path = await render_item(item)
                    pid = db.add_pending("post", {"plan_id": item["id"]})
                    db.update_plan(item["id"], status="awaiting")
                    await telegram.send_video_to_owner(
                        Path(path),
                        f"🗓 {item['publish_at'][:16].replace('T', ' ')}\n{item['topic']}\n\n{_caption(item)}",
                        pid,
                    )
                elif st == "approved" and at <= now:
                    await telegram.notify_owner(await publish_item(item["id"]))
            else:  # auto
                if st == "planned" and at - timedelta(minutes=15) <= now:
                    await render_item(item)
                elif st in ("rendered", "approved") and at <= now:
                    await telegram.notify_owner(await publish_item(item["id"]))
        except Exception:
            log.exception("Post #%s qayta ishlanmadi", item["id"])
            db.update_plan(item["id"], status="failed")


async def run_forever():
    log.info("Rejalashtiruvchi ishga tushdi (%s)", config.TIMEZONE)
    while True:
        await tick()
        await asyncio.sleep(60)
