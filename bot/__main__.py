import asyncio
import logging

from aiogram import Bot, Dispatcher, F
from aiogram.types import BotCommand

from .config import load_config
from .handlers import admin, customer
from .scheduler import run_scheduler


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    bot = Bot(config.bot_token)
    dp = Dispatcher(config=config)

    is_admin = F.from_user.id.in_(config.admin_ids)
    admin.router.message.filter(is_admin)
    admin.router.callback_query.filter(is_admin)
    dp.include_routers(admin.router, customer.router)

    await bot.set_my_commands([
        BotCommand(command="start", description="Бошлаш"),
        BotCommand(command="post", description="Пост тайёрлаш (админ)"),
        BotCommand(command="montaj", description="Reels монтаж (админ)"),
        BotCommand(command="reja", description="Контент режа (админ)"),
        BotCommand(command="navbat", description="Режалаштирилган постлар (админ)"),
        BotCommand(command="bekor", description="Бекор қилиш"),
    ])
    scheduler = asyncio.create_task(run_scheduler(bot, config))
    try:
        await dp.start_polling(bot)
    finally:
        scheduler.cancel()


if __name__ == "__main__":
    asyncio.run(main())
