"""Barcha platformalardan kelgan xabarlarni bitta joyda qayta ishlash.

Oqim: xabar keldi -> tarixga yoziladi -> AI javob loyihasi -> (auto) darhol yuboriladi
yoki (review) sizga Telegramda ✅/❌ tugmalari bilan yuboriladi.
"""
import logging

from . import ai, config, db

log = logging.getLogger("responder")


async def deliver(platform: str, kind: str, target: dict, text: str):
    """Javobni kerakli platformaga yuboradi."""
    from .platforms import instagram, telegram, tiktok, youtube

    if platform == "telegram":
        await telegram.send_message(
            target["chat_id"], text,
            business_connection_id=target.get("business_connection_id"),
            reply_to=target.get("reply_to_message_id"),
        )
    elif platform == "instagram":
        if kind == "dm":
            await instagram.send_dm(target["recipient_id"], text)
        else:
            await instagram.reply_comment(target["comment_id"], text)
    elif platform == "youtube":
        await youtube.reply_comment(target["parent_id"], text)
    elif platform == "tiktok":
        await tiktok.reply_comment(target["video_id"], target["comment_id"], text)
    else:
        raise ValueError(platform)


async def handle_incoming(*, platform: str, kind: str, thread_id: str, external_id: str,
                          author: str, text: str, target: dict, context: str = ""):
    if not text or not text.strip():
        return
    if not db.mark_seen(platform, external_id):
        return  # bu xabar allaqachon qayta ishlangan

    db.add_message(platform, kind, thread_id, "in", author, text)
    hist = db.history(platform, thread_id, config.HISTORY_LIMIT)

    try:
        draft = await ai.draft_reply(platform, kind, author, text, hist, context)
    except Exception:
        log.exception("AI xatosi")
        draft = {"action": "escalate", "reply": "", "reason": "AI xatosi"}

    action, reply = draft["action"], draft["reply"].strip()
    log.info("[%s/%s] %s: %r -> %s %r", platform, kind, author, text[:60], action, reply[:60])

    if action == "ignore":
        return

    from .platforms import telegram

    header = f"📩 {platform} · {'direkt' if kind == 'dm' else 'koment'} · {author}\n«{text}»"
    if action == "escalate":
        await telegram.notify_owner(
            f"⚠️ Sizning javobingiz kerak\n{header}\n\nSabab: {draft['reason']}"
            + (f"\nAI taklifi: {reply}" if reply else ""),
            pending_id=_queue(platform, kind, thread_id, target, reply) if reply else None,
        )
        return

    if config.REPLY_MODE == "auto":
        await send_and_log(platform, kind, thread_id, target, reply)
    else:
        pid = _queue(platform, kind, thread_id, target, reply)
        await telegram.notify_owner(f"{header}\n\n🤖 Javob: {reply}", pending_id=pid)


def _queue(platform, kind, thread_id, target, reply) -> int:
    return db.add_pending("reply", {
        "platform": platform, "kind": kind, "thread_id": thread_id,
        "target": target, "text": reply,
    })


async def send_and_log(platform, kind, thread_id, target, text):
    await deliver(platform, kind, target, text)
    db.add_message(platform, kind, thread_id, "out", "me", text)


async def approve(pid: int, edited_text: str | None = None) -> str:
    """Telegramdagi ✅ tugmasi yoki tahrirlangan javob."""
    item = db.take_pending(pid)
    if not item:
        return "Bu amal allaqachon bajarilgan yoki topilmadi."
    p = item["payload"]
    if item["kind"] == "reply":
        text = edited_text or p["text"]
        await send_and_log(p["platform"], p["kind"], p["thread_id"], p["target"], text)
        if edited_text:
            # Siz tuzatgan javob — keyingi safar AI uchun namuna bo'ladi
            incoming = db.last_incoming(p["platform"], p["thread_id"])
            if incoming:
                db.add_example(incoming, edited_text, source="edited")
        return "✅ Yuborildi"
    if item["kind"] == "post":
        from . import scheduler
        return await scheduler.publish_item(p["plan_id"])
    return "Noma'lum amal"
