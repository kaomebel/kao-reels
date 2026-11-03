"""Server: Instagram webhook, boshqaruv paneli va fon vazifalari.

Ishga tushirish:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
import asyncio
import html
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, scheduler
from .platforms import instagram, telegram, tiktok, youtube

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    tasks = [asyncio.create_task(scheduler.run_forever())]
    if config.enabled("telegram"):
        tasks.append(asyncio.create_task(telegram.poll_forever()))
    if config.enabled("youtube"):
        tasks.append(asyncio.create_task(youtube.poll_forever()))
    if config.enabled("tiktok"):
        tasks.append(asyncio.create_task(tiktok.poll_forever()))
    log.info("Yoqilgan: %s", [p for p in ("telegram", "instagram", "youtube", "tiktok") if config.enabled(p)])
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="KAO AI assistant", lifespan=lifespan)
config.RENDER_DIR.mkdir(parents=True, exist_ok=True)
# Instagram videoni shu manzildan yuklab oladi
app.mount("/media/rendered", StaticFiles(directory=config.RENDER_DIR), name="rendered")


@app.get("/webhook/instagram")
async def ig_verify(request: Request):
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == config.IG_VERIFY_TOKEN:
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(403)


@app.post("/webhook/instagram")
async def ig_webhook(request: Request):
    body = await request.body()
    if not instagram.verify_signature(body, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(401, "bad signature")
    payload = await request.json()
    # Meta 20 soniya ichida javob kutadi — qayta ishlashni fonga qo'yamiz
    asyncio.create_task(_safe(instagram.handle_webhook(payload)))
    return {"ok": True}


async def _safe(coro):
    try:
        await coro
    except Exception:
        log.exception("Webhook qayta ishlanmadi")


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    e = html.escape
    msgs = "".join(
        f"<tr><td>{e(m['created_at'][:16])}</td><td>{e(m['platform'])}/{e(m['kind'])}</td>"
        f"<td>{'⬅️' if m['direction'] == 'in' else '➡️'} {e(m['author'] or '')}</td><td>{e(m['text'] or '')}</td></tr>"
        for m in db.recent_messages(50)
    )
    plan = "".join(
        f"<tr><td>{e(p['publish_at'][:16])}</td><td>{e(p['status'])}</td><td>{e(p['topic'])}</td>"
        f"<td>{e(p['hook'])}</td><td>{len(p['media'])} fayl</td></tr>"
        for p in db.plan_items()
    )
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>KAO AI</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{{font-family:system-ui;margin:16px;background:#fafafa;color:#222}}
table{{border-collapse:collapse;width:100%;margin-bottom:24px;font-size:14px}}
td{{border-bottom:1px solid #ddd;padding:6px;vertical-align:top}}</style></head><body>
<h1>KAO AI yordamchi</h1>
<p>Javob rejimi: <b>{config.REPLY_MODE}</b> · Post rejimi: <b>{config.POST_MODE}</b></p>
<h2>Kontent plan</h2><table>{plan or '<tr><td>Hali reja yo‘q. Telegramda /plan 7 yozing.</td></tr>'}</table>
<h2>Oxirgi xabarlar</h2><table>{msgs or '<tr><td>Hali xabar yo‘q</td></tr>'}</table>
</body></html>"""
