"""YouTube Data API v3: komentlarga javob + Shorts yuklash.

YouTube'da shaxsiy direkt (DM) yo'q — faqat komentariyalar.
OAuth scope: https://www.googleapis.com/auth/youtube.force-ssl (+ youtube.upload Shorts uchun).
"""
import asyncio
import json
import logging
import time
from pathlib import Path

import httpx

from .. import config, db

log = logging.getLogger("youtube")
API = "https://www.googleapis.com/youtube/v3"
_token = {"value": None, "exp": 0.0}


async def access_token() -> str:
    if _token["value"] and time.time() < _token["exp"] - 60:
        return _token["value"]
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post("https://oauth2.googleapis.com/token", data={
            "client_id": config.YT_CLIENT_ID, "client_secret": config.YT_CLIENT_SECRET,
            "refresh_token": config.YT_REFRESH_TOKEN, "grant_type": "refresh_token",
        })
    r.raise_for_status()
    d = r.json()
    _token.update(value=d["access_token"], exp=time.time() + d.get("expires_in", 3600))
    return _token["value"]


async def _req(method, path, **kw):
    headers = {"Authorization": f"Bearer {await access_token()}"}
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.request(method, f"{API}/{path}", headers=headers, **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"YouTube {path}: {r.status_code} {r.text}")
    return r.json()


async def reply_comment(parent_id: str, text: str):
    return await _req("POST", "comments", params={"part": "snippet"},
                      json={"snippet": {"parentId": parent_id, "textOriginal": text}})


async def check_comments():
    from .. import responder

    data = await _req("GET", "commentThreads", params={
        "part": "snippet", "allThreadsRelatedToChannelId": config.YT_CHANNEL_ID,
        "order": "time", "maxResults": 50, "textFormat": "plainText",
    })
    first_run = db.kv_get("yt_initialized") is None
    for th in reversed(data.get("items", [])):
        top = th["snippet"]["topLevelComment"]
        sn = top["snippet"]
        if sn.get("authorChannelId", {}).get("value") == config.YT_CHANNEL_ID:
            continue
        if th["snippet"].get("totalReplyCount", 0) > 0:
            db.mark_seen("youtube", top["id"])  # allaqachon javob berilgan
            continue
        if first_run:
            db.mark_seen("youtube", top["id"])  # eski komentlarga birinchi ishga tushganda tegmaymiz
            continue
        await responder.handle_incoming(
            platform="youtube", kind="comment", thread_id=top["id"], external_id=top["id"],
            author=sn.get("authorDisplayName", "?"), text=sn.get("textOriginal", ""),
            target={"parent_id": top["id"]}, context=f"Video ID: {sn.get('videoId', '')}",
        )
    db.kv_set("yt_initialized", "1")


async def poll_forever():
    log.info("YouTube komentlari kuzatilmoqda (har %ss)", config.YT_POLL_SECONDS)
    while True:
        try:
            await check_comments()
        except Exception:
            log.exception("YouTube xatosi")
        await asyncio.sleep(config.YT_POLL_SECONDS)


async def upload_short(path: Path, title: str, description: str) -> str:
    meta = {
        "snippet": {"title": title[:95] + " #shorts", "description": description[:4900], "categoryId": "22"},
        "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False},
    }
    headers = {"Authorization": f"Bearer {await access_token()}"}
    async with httpx.AsyncClient(timeout=600) as c:
        init = await c.post(
            "https://www.googleapis.com/upload/youtube/v3/videos",
            params={"uploadType": "resumable", "part": "snippet,status"},
            headers=headers | {"Content-Type": "application/json; charset=UTF-8",
                               "X-Upload-Content-Type": "video/mp4"},
            content=json.dumps(meta),
        )
        init.raise_for_status()
        r = await c.put(init.headers["Location"], headers=headers | {"Content-Type": "video/mp4"},
                        content=path.read_bytes())
    r.raise_for_status()
    return r.json()["id"]
