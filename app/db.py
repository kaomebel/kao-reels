"""SQLite: xabarlar tarixi, kutilayotgan tasdiqlar, kontent plan, uslub namunalari."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT, kind TEXT, thread_id TEXT, direction TEXT,
    author TEXT, text TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_msg_thread ON messages(platform, thread_id, id);
CREATE TABLE IF NOT EXISTS seen (
    platform TEXT, external_id TEXT, PRIMARY KEY (platform, external_id)
);
CREATE TABLE IF NOT EXISTS pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, payload TEXT, status TEXT DEFAULT 'waiting', created_at TEXT
);
CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_at TEXT, topic TEXT, hook TEXT, caption TEXT, hashtags TEXT,
    media TEXT, status TEXT DEFAULT 'planned', video_path TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incoming TEXT, reply TEXT, source TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def conn():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)


def mark_seen(platform: str, external_id: str) -> bool:
    """True qaytaradi agar bu yangi bo'lsa (avval ko'rilmagan)."""
    with conn() as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO seen(platform, external_id) VALUES (?, ?)",
            (platform, str(external_id)),
        )
        return cur.rowcount == 1


def add_message(platform, kind, thread_id, direction, author, text):
    with conn() as c:
        c.execute(
            "INSERT INTO messages(platform, kind, thread_id, direction, author, text, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (platform, kind, str(thread_id), direction, author, text, now()),
        )


def history(platform, thread_id, limit):
    with conn() as c:
        rows = c.execute(
            "SELECT direction, author, text FROM messages WHERE platform=? AND thread_id=?"
            " ORDER BY id DESC LIMIT ?",
            (platform, str(thread_id), limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def last_incoming(platform, thread_id):
    with conn() as c:
        r = c.execute(
            "SELECT text FROM messages WHERE platform=? AND thread_id=? AND direction='in'"
            " ORDER BY id DESC LIMIT 1",
            (platform, str(thread_id)),
        ).fetchone()
    return r["text"] if r else None


def add_pending(kind, payload) -> int:
    with conn() as c:
        cur = c.execute(
            "INSERT INTO pending(kind, payload, created_at) VALUES (?,?,?)",
            (kind, json.dumps(payload, ensure_ascii=False), now()),
        )
        return cur.lastrowid


def take_pending(pid: int):
    """Kutilayotgan amalni oladi va 'done' qiladi (ikki marta bosilishdan himoya)."""
    with conn() as c:
        r = c.execute("SELECT * FROM pending WHERE id=? AND status='waiting'", (pid,)).fetchone()
        if not r:
            return None
        c.execute("UPDATE pending SET status='done' WHERE id=?", (pid,))
        return {"id": r["id"], "kind": r["kind"], "payload": json.loads(r["payload"])}


def reject_pending(pid: int):
    with conn() as c:
        c.execute("UPDATE pending SET status='rejected' WHERE id=? AND status='waiting'", (pid,))


def add_example(incoming, reply, source="manual"):
    with conn() as c:
        c.execute(
            "INSERT INTO examples(incoming, reply, source, created_at) VALUES (?,?,?,?)",
            (incoming, reply, source, now()),
        )


def examples(limit=40):
    with conn() as c:
        rows = c.execute(
            "SELECT incoming, reply FROM examples ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def kv_get(k, default=None):
    with conn() as c:
        r = c.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def kv_set(k, v):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES (?,?)", (k, str(v)))


# --- Kontent plan ---
def add_plan_item(item: dict) -> int:
    with conn() as c:
        cur = c.execute(
            "INSERT INTO plan(publish_at, topic, hook, caption, hashtags, media) VALUES (?,?,?,?,?,?)",
            (
                item["publish_at"], item["topic"], item["hook"], item["caption"],
                " ".join(item.get("hashtags", [])),
                json.dumps(item.get("media", []), ensure_ascii=False),
            ),
        )
        return cur.lastrowid


def plan_items(status=None):
    q, args = "SELECT * FROM plan", ()
    if status:
        q, args = q + " WHERE status=?", (status,)
    with conn() as c:
        rows = c.execute(q + " ORDER BY publish_at", args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["media"] = json.loads(d["media"] or "[]")
        out.append(d)
    return out


def plan_item(pid):
    items = [i for i in plan_items() if i["id"] == pid]
    return items[0] if items else None


def update_plan(pid, **fields):
    sets = ", ".join(f"{k}=?" for k in fields)
    with conn() as c:
        c.execute(f"UPDATE plan SET {sets} WHERE id=?", (*fields.values(), pid))


def recent_messages(limit=50):
    with conn() as c:
        rows = c.execute("SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
