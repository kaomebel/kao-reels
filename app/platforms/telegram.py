"""Telegram: bot + Telegram Business (shaxsiy chatlaringizga javob) + kanal komentlari.

- Shaxsiy direktlar: Telegram Premium -> Sozlamalar -> Telegram Business -> Chatbotlar -> botingizni qo'shing.
  Shunda bot sizning nomingizdan shaxsiy chatlarga javob beradi (business_message).
- Kanal komentariyalari: botni kanalingizga bog'langan muhokama (discussion) guruhiga admin qiling.
- Boshqaruv: bot sizga (OWNER_TELEGRAM_ID) ✅/❌ tugmali xabarlar yuboradi.
"""
import asyncio
import json
import logging
import re
from pathlib import Path

import httpx

from .. import config, db

log = logging.getLogger("telegram")
API = "https://api.telegram.org/bot{token}/{method}"
PID_RE = re.compile(r"#ID(\d+)")


async def call(method: str, http_timeout: float = 30, files=None, **params):
    url = API.format(token=config.TELEGRAM_BOT_TOKEN, method=method)
    params = {k: v for k, v in params.items() if v is not None}
    async with httpx.AsyncClient(timeout=http_timeout) as c:
        if files:
            r = await c.post(url, data=params, files=files)
        else:
            r = await c.post(url, json=params)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram {method}: {data}")
    return data["result"]


async def send_message(chat_id, text, business_connection_id=None, reply_to=None, reply_markup=None):
    return await call(
        "sendMessage", chat_id=chat_id, text=text,
        business_connection_id=business_connection_id,
        reply_parameters={"message_id": reply_to, "allow_sending_without_reply": True} if reply_to else None,
        reply_markup=reply_markup,
    )


def _buttons(pid: int):
    return {"inline_keyboard": [[
        {"text": "✅ Yuborish", "callback_data": f"ok:{pid}"},
        {"text": "❌ Bekor", "callback_data": f"no:{pid}"},
    ]]}


async def notify_owner(text: str, pending_id: int | None = None):
    if not (config.TELEGRAM_BOT_TOKEN and config.OWNER_TELEGRAM_ID):
        log.info("[owner] %s", text)
        return
    if pending_id:
        text += f"\n\n#ID{pending_id}\n✏️ O'zgartirish uchun shu xabarga javob (reply) qilib to'g'ri matnni yozing."
    try:
        await send_message(config.OWNER_TELEGRAM_ID, text[:4000],
                           reply_markup=_buttons(pending_id) if pending_id else None)
    except Exception:
        log.exception("Egaga xabar yuborilmadi")


async def send_video_to_owner(path: Path, caption: str, pending_id: int):
    caption = f"{caption}\n\n#ID{pending_id}"[:1024]
    with open(path, "rb") as f:
        await call("sendVideo", http_timeout=300, files={"video": (path.name, f, "video/mp4")},
                   chat_id=config.OWNER_TELEGRAM_ID, caption=caption,
                   reply_markup=json.dumps(_buttons(pending_id)))


def _is_owner(user: dict | None) -> bool:
    return bool(user) and str(user.get("id")) == str(config.OWNER_TELEGRAM_ID)


def _name(user: dict | None) -> str:
    if not user:
        return "?"
    return user.get("username") or " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))


async def _handle_owner_command(msg: dict):
    from .. import responder, scheduler

    text = (msg.get("text") or "").strip()
    chat = msg["chat"]["id"]

    replied = msg.get("reply_to_message") or {}
    m = PID_RE.search(replied.get("text") or replied.get("caption") or "")
    if m and text and not text.startswith("/"):
        res = await responder.approve(int(m.group(1)), edited_text=text)
        await send_message(chat, res)
        return

    if text.startswith("/plan"):
        parts = text.split(maxsplit=2)
        days = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 7
        goals = parts[2] if len(parts) > 2 else ""
        await send_message(chat, f"⏳ {days} kunlik kontent plan tuzilyapti...")
        items = await scheduler.generate_plan(days=days, goals=goals)
        lines = [f"{i['publish_at'][:16]} — {i['topic']}" for i in items]
        await send_message(chat, "🗓 Kontent plan:\n" + ("\n".join(lines) or "bo'sh (media yo'qmi?)"))
    elif text.startswith("/status"):
        planned = db.plan_items("planned")
        await send_message(chat, f"Rejim: javob={config.REPLY_MODE}, post={config.POST_MODE}\n"
                                 f"Rejadagi postlar: {len(planned)}")
    elif text.startswith("/learn"):
        # /learn Mijoz savoli || Mening javobim
        body = text[len("/learn"):].strip()
        if "||" in body:
            q, a = (s.strip() for s in body.split("||", 1))
            db.add_example(q, a, source="owner")
            await send_message(chat, "📚 Namuna saqlandi")
        else:
            await send_message(chat, "Format: /learn Mijoz savoli || Mening javobim")
    else:
        await send_message(chat, "Buyruqlar:\n/plan 7 [maqsad] — kontent plan\n/status\n"
                                 "/learn savol || javob — uslub namunasini qo'shish")


async def _handle_update(u: dict):
    from .. import responder

    if cq := u.get("callback_query"):
        if not _is_owner(cq.get("from")):
            return
        action, pid = cq["data"].split(":")
        if action == "ok":
            res = await responder.approve(int(pid))
        else:
            db.reject_pending(int(pid))
            res = "❌ Bekor qilindi"
        await call("answerCallbackQuery", callback_query_id=cq["id"], text=res[:190])
        try:
            await call("editMessageReplyMarkup", chat_id=cq["message"]["chat"]["id"],
                       message_id=cq["message"]["message_id"], reply_markup={"inline_keyboard": []})
            await send_message(cq["message"]["chat"]["id"], res, reply_to=cq["message"]["message_id"])
        except Exception:
            pass
        return

    if bm := u.get("business_message"):
        chat_id = bm["chat"]["id"]
        text = bm.get("text") or bm.get("caption") or ""
        if _is_owner(bm.get("from")):
            # Siz o'zingiz qo'lda javob yozdingiz -> AI sizdan o'rganadi
            incoming = db.last_incoming("telegram", chat_id)
            if incoming and text:
                db.add_example(incoming, text, source="telegram-live")
            db.add_message("telegram", "dm", chat_id, "out", "me", text)
            return
        await responder.handle_incoming(
            platform="telegram", kind="dm", thread_id=str(chat_id),
            external_id=f"b{bm['business_connection_id']}:{bm['message_id']}",
            author=_name(bm.get("from")), text=text,
            target={"chat_id": chat_id, "business_connection_id": bm["business_connection_id"]},
        )
        return

    msg = u.get("message")
    if not msg:
        return
    chat = msg["chat"]
    text = msg.get("text") or msg.get("caption") or ""

    if chat["type"] == "private":
        if _is_owner(msg.get("from")):
            await _handle_owner_command(msg)
            return
        if text.startswith("/start"):
            if not config.OWNER_TELEGRAM_ID:
                await send_message(chat["id"], f"Sizning Telegram ID: {msg['from']['id']}\n"
                                               "Uni .env dagi OWNER_TELEGRAM_ID ga yozing.")
                return
            text = "Assalomu alaykum"
        await responder.handle_incoming(
            platform="telegram", kind="dm", thread_id=str(chat["id"]),
            external_id=f"{chat['id']}:{msg['message_id']}", author=_name(msg.get("from")),
            text=text, target={"chat_id": chat["id"]},
        )
        return

    # Guruh: faqat kanal postiga yozilgan komentlarga javob beramiz
    parent = msg.get("reply_to_message") or {}
    if chat["type"] in ("group", "supergroup") and parent.get("is_automatic_forward"):
        if msg.get("from", {}).get("is_bot") or _is_owner(msg.get("from")):
            return
        await responder.handle_incoming(
            platform="telegram", kind="comment", thread_id=f"{chat['id']}:{parent['message_id']}:{msg['from']['id']}",
            external_id=f"{chat['id']}:{msg['message_id']}", author=_name(msg.get("from")), text=text,
            target={"chat_id": chat["id"], "reply_to_message_id": msg["message_id"]},
            context=f"Kanal posti: {(parent.get('text') or parent.get('caption') or '')[:500]}",
        )


async def poll_forever():
    """Long-polling: webhook/HTTPS kerak emas."""
    await call("deleteWebhook")
    me = await call("getMe")
    log.info("Telegram bot ishga tushdi: @%s", me["username"])
    offset = int(db.kv_get("tg_offset", 0))
    while True:
        try:
            updates = await call(
                "getUpdates", http_timeout=70, offset=offset, limit=50, timeout=50,
                allowed_updates=["message", "business_connection", "business_message", "callback_query"],
            )
        except Exception as e:
            log.warning("getUpdates xatosi: %s", e)
            await asyncio.sleep(5)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            db.kv_set("tg_offset", offset)
            try:
                await _handle_update(u)
            except Exception:
                log.exception("Update qayta ishlanmadi: %s", u.get("update_id"))
