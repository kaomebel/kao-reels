import html
import logging
from collections import defaultdict

from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.types import Message, User

from .. import ai, db
from ..config import Config

log = logging.getLogger(__name__)
router = Router(name="customer")
router.message.filter(F.chat.type == ChatType.PRIVATE)

HISTORY_LIMIT = 12
_history: defaultdict[int, list[dict]] = defaultdict(list)

GREETING = (
    "Ассалому алайкум! KAO Mebel га хуш келибсиз 🛋\n"
    "Мебель, нархлар, буюртма ёки ўлчов ҳақида саволингизни ёзинг — дарҳол жавоб бераман."
)


def _remember(user_id: int, role: str, text: str) -> None:
    history = _history[user_id]
    if history and history[-1]["role"] == role:
        history[-1]["content"] += "\n" + text
    else:
        history.append({"role": role, "content": text})
    del history[:-HISTORY_LIMIT]
    # The conversation sent to Claude must start with the customer's turn.
    while history and history[0]["role"] != "user":
        history.pop(0)


def remember_manager_reply(user_id: int, text: str) -> None:
    _remember(user_id, "assistant", f"(Менежер жавоби) {text}")


def _who(user: User) -> str:
    name = html.escape(user.full_name)
    tag = f" @{user.username}" if user.username else ""
    return f'👤 <a href="tg://user?id={user.id}">{name}</a>{tag} (ID {user.id})'


async def _relay(bot: Bot, config: Config, message: Message, note: str) -> None:
    """Sends the customer's message to the manager; a reply there goes back to the customer."""
    try:
        header = await bot.send_message(config.manager_chat_id, f"{note}\n{_who(message.from_user)}",
                                        parse_mode="HTML")
        db.save_relay(config.manager_chat_id, header.message_id, message.chat.id)
        copy = await message.copy_to(config.manager_chat_id)
        db.save_relay(config.manager_chat_id, copy.message_id, message.chat.id)
    except TelegramBadRequest:
        log.exception("could not relay customer message to manager")


@router.message(CommandStart())
async def start(message: Message) -> None:
    _history.pop(message.from_user.id, None)
    await message.answer(GREETING)


@router.message(F.text)
async def text(message: Message, bot: Bot, config: Config) -> None:
    user_id = message.from_user.id
    _remember(user_id, "user", message.text)
    await bot.send_chat_action(message.chat.id, "typing")
    try:
        reply, handoff = await ai.answer_customer(config.business_info, list(_history[user_id]))
    except ai.AIError:
        reply, handoff = "Раҳмат! Менежеримиз тез орада жавоб беради 🙏", True
    _remember(user_id, "assistant", reply)
    await message.answer(reply)
    if handoff:
        await _relay(bot, config, message, "🔔 Мижоз менежерни кутяпти (жавоб учун «Reply» қилинг):")


@router.message()
async def media(message: Message, bot: Bot, config: Config) -> None:
    await message.answer("Раҳмат! Менежеримиз кўриб чиқиб, тез орада жавоб беради 🙏")
    await _relay(bot, config, message, "📎 Мижоз файл юборди (жавоб учун «Reply» қилинг):")
