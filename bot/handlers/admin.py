import asyncio
import logging
import re
from collections import defaultdict
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (CallbackQuery, FSInputFile, InlineKeyboardButton,
                           InlineKeyboardMarkup, KeyboardButton, Message, ReplyKeyboardMarkup)

from .. import ai, db
from ..config import Config
from ..montage import Clip, MontageError, build_reel
from ..publish import send_content, split_text
from .customer import remember_manager_reply

log = logging.getLogger(__name__)
router = Router(name="admin")

BTN_POST = "📝 Пост"
BTN_MONTAGE = "🎬 Монтаж"
BTN_PLAN = "📅 Контент режа"
BTN_QUEUE = "🗂 Навбат"
BTN_DONE = "✅ Тайёр"
BTN_CANCEL = "❌ Бекор"

MENU = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text=BTN_POST), KeyboardButton(text=BTN_MONTAGE)],
              [KeyboardButton(text=BTN_PLAN), KeyboardButton(text=BTN_QUEUE)]],
    resize_keyboard=True,
)
MONTAGE_KB = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text=BTN_DONE), KeyboardButton(text=BTN_CANCEL)]],
    resize_keyboard=True,
)

HELP = (
    "Ассалому алайкум! Мен KAO Mebel контент ботиман 🤖\n\n"
    f"{BTN_POST} — матн, расм ёки видео юборинг, AI матн ёзиб беради, каналга жойлайман ёки вақтини белгилайман.\n"
    f"{BTN_MONTAGE} — бир нечта видео/расм (ва хоҳласангиз мусиқа) юборинг, вертикал Reels видео йиғиб бераман.\n"
    f"{BTN_PLAN} — ҳафталик контент режа тузиб бераман.\n"
    f"{BTN_QUEUE} — режалаштирилган постлар рўйхати.\n\n"
    "Мижозлар ботга ёзса, AI жавоб беради. Буюртма ёки мураккаб савол бўлса, сизга юбораман — "
    "менинг хабаримга «Reply» қилиб жавоб ёзсангиз, мижозга етказаман.\n\n"
    "Буйруқлар: /post /montaj /reja /navbat /bekor"
)


class PostFlow(StatesGroup):
    content = State()
    preview = State()
    edit_text = State()
    time = State()


class PlanFlow(StatesGroup):
    request = State()


class MontageFlow(StatesGroup):
    collecting = State()


# Album items arrive as parallel updates; serialize state edits per chat.
_montage_locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)


def preview_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardButton
    return InlineKeyboardMarkup(inline_keyboard=[
        [b(text="🤖 AI матн ёзсин", callback_data="post:ai"),
         b(text="✏️ Матнни ўзгартириш", callback_data="post:edit")],
        [b(text="📢 Ҳозир жойлаш", callback_data="post:now"),
         b(text="🕒 Вақт белгилаш", callback_data="post:schedule")],
        [b(text="❌ Бекор қилиш", callback_data="post:cancel")],
    ])


# ---------- general ----------

@router.message(CommandStart())
@router.message(Command("help"))
async def start(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(HELP, reply_markup=MENU)


@router.message(Command("bekor"))
@router.message(F.text == BTN_CANCEL)
async def cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Бекор қилинди.", reply_markup=MENU)


# Manager replies to a relayed customer message -> deliver it to the customer.
@router.message(F.reply_to_message)
async def manager_reply(message: Message, bot: Bot, config: Config, state: FSMContext) -> None:
    customer = db.find_relay(message.chat.id, message.reply_to_message.message_id)
    if customer is None:
        # Not a relay — let other handlers in the current flow deal with it.
        await route_by_state(message, bot, config, state)
        return
    try:
        await message.copy_to(customer)
    except TelegramBadRequest as e:
        await message.reply(f"Юборилмади: {e.message}")
        return
    if message.text:
        remember_manager_reply(customer, message.text)
    await message.reply("✅ Мижозга юборилди.")


async def route_by_state(message: Message, bot: Bot, config: Config, state: FSMContext) -> None:
    current = await state.get_state()
    if current == PostFlow.content.state:
        await post_content(message, state)
    elif current == PostFlow.edit_text.state:
        await post_edit_text(message, bot, state)
    elif current == PostFlow.time.state:
        await post_time(message, config, state)
    elif current == PlanFlow.request.state:
        await plan_request(message, config, state)
    elif current == MontageFlow.collecting.state:
        await montage_collect(message, state)


# ---------- posts ----------

@router.message(Command("post"))
@router.message(F.text == BTN_POST)
async def post_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    await state.set_state(PostFlow.content)
    await message.answer(
        "Пост учун матн, расм ёки видео юборинг.\n"
        "Маслаҳат: расм юбориб, изоҳга қисқача маълумот ёзинг (масалан «ошхона, оқ ранг, 3 м») — "
        "кейин «🤖 AI матн ёзсин» тугмасини босинг.",
        reply_markup=MENU,
    )


async def show_preview(bot: Bot, chat_id: int, state: FSMContext) -> None:
    data = await state.get_data()
    await state.set_state(PostFlow.preview)
    await bot.send_message(chat_id, "👇 Пост кўриниши:")
    await send_content(bot, chat_id, data["kind"], data.get("file_id"), data.get("caption", ""),
                       reply_markup=preview_kb())


@router.message(PostFlow.content)
async def post_content(message: Message, state: FSMContext) -> None:
    if message.photo:
        kind, file_id, caption = "photo", message.photo[-1].file_id, message.caption or ""
    elif message.video:
        kind, file_id, caption = "video", message.video.file_id, message.caption or ""
    elif message.text:
        kind, file_id, caption = "text", None, message.text
    else:
        await message.answer("Фақат матн, расм ёки видео юборинг.")
        return
    await state.update_data(kind=kind, file_id=file_id, caption=caption)
    await show_preview(message.bot, message.chat.id, state)


@router.callback_query(PostFlow.preview, F.data == "post:ai")
async def post_ai(call: CallbackQuery, bot: Bot, config: Config, state: FSMContext) -> None:
    await call.answer("AI ёзяпти...")
    data = await state.get_data()
    image = None
    if data["kind"] == "photo":
        try:
            image = (await bot.download(data["file_id"])).read()
        except TelegramBadRequest:
            image = None
    await bot.send_chat_action(call.message.chat.id, "typing")
    try:
        caption = await ai.write_caption(config.business_info, data.get("caption", ""), image)
    except ai.AIError as e:
        await call.message.answer(f"⚠️ {e}")
        return
    await state.update_data(caption=caption)
    await show_preview(bot, call.message.chat.id, state)


@router.callback_query(PostFlow.preview, F.data == "post:edit")
async def post_edit(call: CallbackQuery, state: FSMContext) -> None:
    await call.answer()
    await state.set_state(PostFlow.edit_text)
    await call.message.answer("Янги матнни юборинг:")


@router.message(PostFlow.edit_text, F.text)
async def post_edit_text(message: Message, bot: Bot, state: FSMContext) -> None:
    await state.update_data(caption=message.text)
    await show_preview(bot, message.chat.id, state)


@router.callback_query(PostFlow.preview, F.data == "post:now")
async def post_now(call: CallbackQuery, bot: Bot, config: Config, state: FSMContext) -> None:
    data = await state.get_data()
    if not config.channel_id:
        await call.answer("CHANNEL_ID созланмаган", show_alert=True)
        return
    try:
        await send_content(bot, config.channel_id, data["kind"], data.get("file_id"),
                           data.get("caption", ""))
    except TelegramBadRequest as e:
        await call.answer()
        await call.message.answer(f"⚠️ Каналга жойлаб бўлмади: {e.message}\n"
                                  "Бот каналда админ эканини текширинг.")
        return
    await call.answer("Жойланди ✅")
    await state.clear()
    await call.message.answer("✅ Каналга жойланди.", reply_markup=MENU)


@router.callback_query(PostFlow.preview, F.data == "post:schedule")
async def post_schedule(call: CallbackQuery, state: FSMContext) -> None:
    await call.answer()
    await state.set_state(PostFlow.time)
    await call.message.answer(
        "Қачон жойлай? Масалан:\n• 18:30 — бугун (ўтиб кетган бўлса эртага)\n"
        "• 25.10 18:30\n• 25.10.2026 18:30"
    )


def parse_time(text: str, tz) -> datetime | None:
    now = datetime.now(tz)
    m = re.fullmatch(r"\s*(?:(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+)?(\d{1,2})[:.](\d{2})\s*", text)
    if not m:
        return None
    day, month, year, hour, minute = m.groups()
    try:
        if day:
            when = datetime(int(year or now.year), int(month), int(day), int(hour), int(minute),
                            tzinfo=tz)
            if not year and when < now:
                when = when.replace(year=now.year + 1)
        else:
            when = now.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
            if when <= now:
                when += timedelta(days=1)
    except ValueError:
        return None
    return when


@router.message(PostFlow.time, F.text)
async def post_time(message: Message, config: Config, state: FSMContext) -> None:
    when = parse_time(message.text, config.tz)
    if when is None:
        await message.answer("Вақтни тушунмадим. Масалан: 18:30 ёки 25.10 18:30")
        return
    if when <= datetime.now(config.tz):
        await message.answer("Бу вақт ўтиб кетган. Келажакдаги вақтни ёзинг.")
        return
    data = await state.get_data()
    post_id = db.add_post(data["kind"], data.get("file_id"), data.get("caption", ""), when)
    await state.clear()
    await message.answer(f"🕒 Пост №{post_id} {when:%d.%m.%Y %H:%M} да жойланади.",
                         reply_markup=MENU)


@router.callback_query(F.data == "post:cancel")
async def post_cancel(call: CallbackQuery, state: FSMContext) -> None:
    await call.answer()
    await state.clear()
    await call.message.answer("Бекор қилинди.", reply_markup=MENU)


# ---------- queue ----------

@router.message(Command("navbat"))
@router.message(F.text == BTN_QUEUE)
async def queue(message: Message, config: Config) -> None:
    posts = db.pending_posts()
    if not posts:
        await message.answer("Навбатда пост йўқ.")
        return
    icons = {"text": "📝", "photo": "🖼", "video": "🎬"}
    for p in posts:
        when = p.publish_at.astimezone(config.tz)
        preview = (p.caption[:80] + "…") if len(p.caption) > 80 else p.caption
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🗑 Ўчириш", callback_data=f"del:{p.id}")]])
        await message.answer(f"{icons.get(p.kind, '')} №{p.id} — {when:%d.%m %H:%M}\n{preview}",
                             reply_markup=kb)


@router.callback_query(F.data.startswith("del:"))
async def queue_delete(call: CallbackQuery) -> None:
    post_id = int(call.data.split(":")[1])
    ok = db.cancel_post(post_id)
    await call.answer("Ўчирилди" if ok else "Топилмади")
    if ok:
        await call.message.edit_text(f"🗑 №{post_id} бекор қилинди.")


# ---------- content plan ----------

@router.message(Command("reja"))
@router.message(F.text == BTN_PLAN)
async def plan_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    await state.set_state(PlanFlow.request)
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📅 Келаси 7 кун", callback_data="plan:week")]])
    await message.answer(
        "Қандай режа керак? Масалан: «Ноябрь ойи учун, ошхона мебелига урғу» ёки "
        "«3 кунлик, янги шкаф коллекцияси». Ёки тугмани босинг:",
        reply_markup=kb,
    )


async def _make_plan(message: Message, config: Config, request: str) -> None:
    await message.bot.send_chat_action(message.chat.id, "typing")
    wait = await message.answer("⏳ Режа тузиляпти...")
    try:
        plan = await ai.content_plan(config.business_info, request)
    except ai.AIError as e:
        await wait.edit_text(f"⚠️ {e}")
        return
    await wait.delete()
    for chunk in split_text(plan):
        await message.answer(chunk, reply_markup=MENU)


@router.callback_query(PlanFlow.request, F.data == "plan:week")
async def plan_week(call: CallbackQuery, config: Config, state: FSMContext) -> None:
    await call.answer()
    await state.clear()
    await _make_plan(call.message, config, "Келаси 7 кун учун")


@router.message(PlanFlow.request, F.text)
async def plan_request(message: Message, config: Config, state: FSMContext) -> None:
    await state.clear()
    await _make_plan(message, config, message.text)


# ---------- montage ----------

@router.message(Command("montaj"))
@router.message(F.text == BTN_MONTAGE)
async def montage_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    await state.set_state(MontageFlow.collecting)
    await state.update_data(items=[], music=None)
    await message.answer(
        "🎬 Видео ва расмларни кетма-кет юборинг (тартиби сақланади).\n"
        "🎵 Фон мусиқаси керак бўлса, аудио файл ҳам юборинг.\n"
        f"Ҳаммасини юбориб бўлгач «{BTN_DONE}» ни босинг.\n\n"
        "⚠️ Ҳар бир файл 20 МБ дан катта бўлмасин (Telegram бот чеклови).",
        reply_markup=MONTAGE_KB,
    )


@router.message(MontageFlow.collecting, F.text == BTN_DONE)
async def montage_done(message: Message, bot: Bot, config: Config, state: FSMContext) -> None:
    data = await state.get_data()
    items = data.get("items", [])
    if not items:
        await message.answer("Ҳали ҳеч нарса юбормадингиз.")
        return
    wait = await message.answer(f"⏳ {len(items)} та материалдан видео йиғиляпти, бир оз кутинг...",
                                reply_markup=MENU)
    await bot.send_chat_action(message.chat.id, "upload_video")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            clips = []
            for i, item in enumerate(sorted(items, key=lambda it: it["msg"])):
                path = work / f"src{i:03d}{'.jpg' if item['photo'] else '.mp4'}"
                await bot.download(item["file_id"], destination=path)
                clips.append(Clip(path, item["photo"]))
            music = None
            if data.get("music"):
                music = work / "music.audio"
                await bot.download(data["music"], destination=music)
            result = await build_reel(clips, work, music, config.brand_text)
            if result.stat().st_size > 49 * 1024 * 1024:
                await wait.edit_text("⚠️ Тайёр видео 50 МБ дан катта чиқди. Камроқ ёки қисқароқ "
                                     "видео юбориб қайта уриниб кўринг.")
                return
            sent = await message.answer_video(FSInputFile(result, "kao-reel.mp4"),
                                              width=1080, height=1920, supports_streaming=True)
    except TelegramBadRequest as e:
        await wait.edit_text(f"⚠️ Файлни юклаб бўлмади: {e.message}\n"
                             "Файл 20 МБ дан катта бўлса, қисқароқ видео юборинг.")
        await state.clear()
        return
    except MontageError:
        log.exception("montage failed")
        await wait.edit_text("⚠️ Видео йиғишда хатолик. Бошқа файллар билан уриниб кўринг.")
        await state.clear()
        return

    await wait.delete()
    await state.clear()
    await state.update_data(kind="video", file_id=sent.video.file_id, caption="")
    await state.set_state(PostFlow.preview)
    await message.answer("Видео тайёр! Энди уни пост қилиш мумкин:", reply_markup=preview_kb())


@router.message(MontageFlow.collecting)
async def montage_collect(message: Message, state: FSMContext) -> None:
    async with _montage_locks[message.chat.id]:
        await _montage_collect(message, state)


async def _montage_collect(message: Message, state: FSMContext) -> None:
    data = await state.get_data()
    items = data.get("items", [])
    if message.photo:
        items.append({"file_id": message.photo[-1].file_id, "photo": True, "msg": message.message_id})
    elif message.video:
        items.append({"file_id": message.video.file_id, "photo": False, "msg": message.message_id})
    elif message.document and (message.document.mime_type or "").startswith("video/"):
        items.append({"file_id": message.document.file_id, "photo": False, "msg": message.message_id})
    elif message.document and (message.document.mime_type or "").startswith("image/"):
        items.append({"file_id": message.document.file_id, "photo": True, "msg": message.message_id})
    elif message.audio or message.voice:
        await state.update_data(music=(message.audio or message.voice).file_id)
        await message.answer("🎵 Мусиқа қабул қилинди.")
        return
    else:
        await message.answer(f"Видео, расм ёки аудио юборинг. Тугатгач «{BTN_DONE}».")
        return
    await state.update_data(items=items)
    await message.answer(f"📥 {len(items)}-материал қабул қилинди.")
