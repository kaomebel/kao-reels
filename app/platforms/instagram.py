"""Instagram (Instagram API with Instagram Login, graph.instagram.com).

Kerakli ruxsatlar (scopes): instagram_business_basic, instagram_business_manage_messages,
instagram_business_manage_comments, instagram_business_content_publish.
Webhook maydonlari: comments, messages.
Hisob Professional (Business yoki Creator) bo'lishi shart.
"""
import asyncio
import hashlib
import hmac
import logging

import httpx

from .. import config

log = logging.getLogger("instagram")


async def _req(method: str, path: str, timeout: float = 30, **kw):
    params = kw.pop("params", {}) | {"access_token": config.IG_ACCESS_TOKEN}
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.request(method, f"{config.IG_API}/{path.lstrip('/')}", params=params, **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"Instagram {path}: {r.status_code} {r.text}")
    return r.json()


def verify_signature(body: bytes, header: str | None) -> bool:
    if not config.IG_APP_SECRET:
        return True  # sir kiritilmagan bo'lsa tekshirmaymiz (faqat test uchun!)
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(config.IG_APP_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[7:])


async def send_dm(recipient_id: str, text: str):
    return await _req("POST", f"{config.IG_USER_ID}/messages",
                      json={"recipient": {"id": recipient_id}, "message": {"text": text}})


async def reply_comment(comment_id: str, text: str):
    return await _req("POST", f"{comment_id}/replies", params={"message": text})


async def media_caption(media_id: str) -> str:
    try:
        d = await _req("GET", media_id, params={"fields": "caption"})
        return (d.get("caption") or "")[:500]
    except Exception:
        return ""


async def handle_webhook(payload: dict):
    """Meta webhook POST tanasini qayta ishlaydi."""
    from .. import responder

    for entry in payload.get("entry", []):
        # Direkt xabarlar
        for ev in entry.get("messaging", []):
            msg = ev.get("message") or {}
            sender = (ev.get("sender") or {}).get("id")
            if not msg or msg.get("is_echo") or msg.get("is_deleted") or sender == config.IG_USER_ID:
                continue
            text = msg.get("text") or ""
            if not text and msg.get("attachments"):
                text = "[rasm/video yubordi]"
            await responder.handle_incoming(
                platform="instagram", kind="dm", thread_id=sender, external_id=msg.get("mid", ""),
                author=f"ig:{sender}", text=text, target={"recipient_id": sender},
            )
        # Komentlar
        for ch in entry.get("changes", []):
            if ch.get("field") not in ("comments", "live_comments"):
                continue
            v = ch.get("value", {})
            frm = v.get("from", {})
            if frm.get("id") == config.IG_USER_ID or v.get("parent_id"):
                continue  # o'z komentimiz yoki javoblarga javob bermaymiz
            media_id = (v.get("media") or {}).get("id", "")
            await responder.handle_incoming(
                platform="instagram", kind="comment", thread_id=f"{media_id}:{frm.get('id')}",
                external_id=v.get("id", ""), author=frm.get("username", "?"), text=v.get("text", ""),
                target={"comment_id": v.get("id")},
                context=f"Post matni: {await media_caption(media_id)}" if media_id else "",
            )


async def publish_reel(video_url: str, caption: str) -> str:
    """Reels joylaydi. video_url — internetdan ochiq bo'lishi kerak (PUBLIC_BASE_URL)."""
    container = await _req("POST", f"{config.IG_USER_ID}/media", params={
        "media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true",
    })
    cid = container["id"]
    for _ in range(60):  # ~10 daqiqagacha kutamiz
        await asyncio.sleep(10)
        st = await _req("GET", cid, params={"fields": "status_code,status"})
        if st.get("status_code") == "FINISHED":
            break
        if st.get("status_code") in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram video qayta ishlanmadi: {st}")
    else:
        raise RuntimeError("Instagram: video tayyor bo'lishi juda uzoq davom etdi")
    res = await _req("POST", f"{config.IG_USER_ID}/media_publish", params={"creation_id": cid})
    return res["id"]
