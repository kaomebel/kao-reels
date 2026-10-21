import asyncio
import logging
from datetime import datetime, timezone

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError

from . import db
from .config import Config
from .publish import send_content

log = logging.getLogger(__name__)
CHECK_EVERY_SECONDS = 30


async def run_scheduler(bot: Bot, config: Config) -> None:
    """Publishes scheduled posts to the channel when their time comes."""
    while True:
        for post in db.due_posts(datetime.now(timezone.utc)):
            try:
                await send_content(bot, config.channel_id, post.kind, post.file_id, post.caption)
                db.set_status(post.id, "done")
                await bot.send_message(config.manager_chat_id, f"✅ Пост №{post.id} каналга жойланди.")
            except TelegramAPIError as e:
                log.exception("failed to publish post %s", post.id)
                db.set_status(post.id, "failed")
                await bot.send_message(config.manager_chat_id,
                                       f"⚠️ Пост №{post.id} жойланмади: {e.message}")
        await asyncio.sleep(CHECK_EVERY_SECONDS)
