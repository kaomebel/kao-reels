from aiogram import Bot

CAPTION_LIMIT = 1024
TEXT_LIMIT = 4096


def split_text(text: str, limit: int = TEXT_LIMIT) -> list[str]:
    chunks = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut <= 0:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        chunks.append(text)
    return chunks


async def send_content(bot: Bot, chat_id: int | str, kind: str, file_id: str | None,
                       caption: str, reply_markup=None) -> None:
    """Sends a text/photo/video post. Long media captions go as a follow-up message."""
    if kind == "text":
        chunks = split_text(caption)
        for i, chunk in enumerate(chunks):
            last = i == len(chunks) - 1
            await bot.send_message(chat_id, chunk, reply_markup=reply_markup if last else None)
        return

    extra = ""
    if len(caption) > CAPTION_LIMIT:
        caption, extra = "", caption
    send = bot.send_photo if kind == "photo" else bot.send_video
    await send(chat_id, file_id, caption=caption or None,
               reply_markup=None if extra else reply_markup)
    if extra:
        await send_content(bot, chat_id, "text", None, extra, reply_markup)
