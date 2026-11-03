"""TikTok.

- Komentlar: TikTok API for Business (business-api.tiktok.com) — TikTok Business hisobi va
  developer ilovasiga "comment" ruxsatlari kerak. Javob berish shu API orqali.
- Video joylash: TikTok Content Posting API (open.tiktokapis.com). Ilova audit'dan o'tmaguncha
  videolar faqat "SELF_ONLY" (shaxsiy) bo'lib joylanadi — bu TikTok qoidasi.
- Direkt (DM): TikTok umumiy dasturchilarga DM API bermaydi, shuning uchun bu yerda yo'q.
"""
import asyncio
import logging
from pathlib import Path

import httpx

from .. import config, db

log = logging.getLogger("tiktok")
BIZ = "https://business-api.tiktok.com/open_api/v1.3"


async def _biz(method, path, **kw):
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.request(method, f"{BIZ}/{path}", headers={"Access-Token": config.TIKTOK_BUSINESS_TOKEN}, **kw)
    d = r.json()
    if d.get("code") not in (0, None):
        raise RuntimeError(f"TikTok {path}: {d}")
    return d.get("data", {})


async def reply_comment(video_id: str, comment_id: str, text: str):
    return await _biz("POST", "business/comment/reply/create/", json={
        "business_id": config.TIKTOK_BUSINESS_ID, "video_id": video_id,
        "comment_id": comment_id, "text": text[:150],
    })


async def check_comments():
    from .. import responder

    vids = await _biz("GET", "business/video/list/", params={
        "business_id": config.TIKTOK_BUSINESS_ID, "fields": '["item_id","caption"]', "max_count": 10,
    })
    first_run = db.kv_get("tt_initialized") is None
    for v in vids.get("videos", []):
        com = await _biz("GET", "business/comment/list/", params={
            "business_id": config.TIKTOK_BUSINESS_ID, "video_id": v["item_id"], "max_count": 30,
        })
        for c in com.get("comments", []):
            if c.get("owner") or c.get("user_id") == config.TIKTOK_BUSINESS_ID:
                continue
            if first_run:
                db.mark_seen("tiktok", c["comment_id"])
                continue
            await responder.handle_incoming(
                platform="tiktok", kind="comment", thread_id=c["comment_id"], external_id=c["comment_id"],
                author=c.get("username") or c.get("display_name") or "?", text=c.get("text", ""),
                target={"video_id": v["item_id"], "comment_id": c["comment_id"]},
                context=f"Video matni: {(v.get('caption') or '')[:300]}",
            )
    db.kv_set("tt_initialized", "1")


async def poll_forever():
    log.info("TikTok komentlari kuzatilmoqda (har %ss)", config.TIKTOK_POLL_SECONDS)
    while True:
        try:
            await check_comments()
        except Exception:
            log.exception("TikTok xatosi")
        await asyncio.sleep(config.TIKTOK_POLL_SECONDS)


async def upload_video(path: Path, title: str, privacy: str = "SELF_ONLY") -> str:
    size = path.stat().st_size
    headers = {"Authorization": f"Bearer {config.TIKTOK_ACCESS_TOKEN}",
               "Content-Type": "application/json; charset=UTF-8"}
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post("https://open.tiktokapis.com/v2/post/publish/video/init/", headers=headers, json={
            "post_info": {"title": title[:2200], "privacy_level": privacy},
            "source_info": {"source": "FILE_UPLOAD", "video_size": size,
                            "chunk_size": size, "total_chunk_count": 1},
        })
        d = r.json()
        if d.get("error", {}).get("code") not in ("ok", None):
            raise RuntimeError(f"TikTok init: {d}")
        up = await c.put(d["data"]["upload_url"], content=path.read_bytes(), headers={
            "Content-Type": "video/mp4", "Content-Range": f"bytes 0-{size - 1}/{size}",
        })
        up.raise_for_status()
    return d["data"]["publish_id"]
