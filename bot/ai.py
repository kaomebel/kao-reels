import base64
import logging

import anthropic

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
# If Claude's safety classifiers decline a request, the API re-runs it on
# Anthropic's recommended fallback model instead of returning a refusal.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Claude appends this marker when a live manager should take over the chat.
HANDOFF_MARKER = "[MANAGER]"

_client = anthropic.AsyncAnthropic()

STYLE = (
    "Барча жавобларни ўзбек тилида, КИРИЛЛ ёзувида ёз. "
    "Telegram учун ёзяпсан: Markdown белгилари (**, ##) ишлатма, оддий матн ва ўринли эмодзилар ишлат."
)


class AIError(Exception):
    pass


def _user(content) -> list[dict]:
    return [{"role": "user", "content": content}]


async def _ask(system: str, messages: list[dict], effort: str, max_tokens: int = 8000) -> str:
    try:
        response = await _client.beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": effort},
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
        )
    except anthropic.RateLimitError as e:
        raise AIError("Claude ҳозир band, бир оздан кейин қайта уриниб кўринг.") from e
    except anthropic.APIConnectionError as e:
        raise AIError("Claude билан алоқа йўқ, интернетни текширинг.") from e
    except anthropic.APIStatusError as e:
        log.exception("Claude API error")
        raise AIError(f"Claude хатоси ({e.status_code}).") from e

    if response.stop_reason == "refusal":
        raise AIError("Claude бу сўровга жавоб бермади.")
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not text:
        raise AIError("Claude бўш жавоб қайтарди.")
    return text


async def content_plan(business_info: str, request: str) -> str:
    system = (
        "Сен мебель компаниясининг SMM мутахассисисан. Компания Telegram канали ва "
        "Instagram Reels учун контент режа тузасан.\n" + STYLE + "\n\nКомпания ҳақида:\n" + business_info
    )
    prompt = (
        "Контент режа туз. Ҳар кун учун: кун, пост тури (Reels / фото / карусел / сторис), "
        "мавзу, қисқа ғоя ёки сценарий (1-2 жумла), тавсия этилган вақт. "
        "Сотувга, ишончга ва фойдали маслаҳатларга аралаш урғу бер.\n\n"
        f"Илова/истак: {request or 'Келаси 7 кун учун'}"
    )
    return await _ask(system, _user(prompt), effort="medium")


async def write_caption(business_info: str, brief: str, image: bytes | None = None,
                        image_mime: str = "image/jpeg") -> str:
    system = (
        "Сен мебель компаниясининг копирайтерисан. Telegram канали учун сотувчи, қисқа "
        "(500 белгигача) пост матни ёзасан: эътиборни тортувчи биринчи қатор, фойда, "
        "чақириқ (call to action) ва 3-5 та хештег.\n" + STYLE
        + "\nФақат пост матнини қайтар, изоҳсиз.\n\nКомпания ҳақида:\n" + business_info
    )
    content: list[dict] = []
    if image:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": image_mime,
                       "data": base64.b64encode(image).decode()},
        })
    content.append({"type": "text", "text": f"Пост учун маълумот: {brief or 'расмдаги мебель'}"})
    return await _ask(system, _user(content), effort="low", max_tokens=4000)


async def answer_customer(business_info: str, history: list[dict]) -> tuple[str, bool]:
    """Returns (reply text, whether a human manager should take over)."""
    system = (
        "Сен KAO Mebel компаниясининг Telegram ботидаги хушмуомала ёрдамчисан. Мижозлар "
        "саволларига ФАҚАТ қуйидаги компания маълумотлари асосида қисқа ва аниқ жавоб бер. "
        "Маълумотда йўқ нарсани (нарх, муддат, чегирма) ўйлаб топма — менежер аниқлаштиришини айт.\n"
        f"Агар мижоз буюртма бермоқчи бўлса, ўлчов ёки учрашув сўраса, шикоят қилса, "
        f"ёки саволга маълумотда жавоб бўлмаса — жавобинг охирига алоҳида қаторда {HANDOFF_MARKER} "
        "деб ёз ва мижоздан исми ва телефон рақамини сўра.\n"
        "Мижоз рус тилида ёзса, рус тилида жавоб бер; акс ҳолда ўзбек кирилл ёзувида.\n"
        "Markdown ишлатма.\n\nКомпания маълумотлари:\n" + business_info
    )
    text = await _ask(system, history, effort="low", max_tokens=2000)
    handoff = HANDOFF_MARKER in text
    return text.replace(HANDOFF_MARKER, "").strip(), handoff
