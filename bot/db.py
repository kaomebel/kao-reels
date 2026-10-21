import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from .config import DATA_DIR

_conn = sqlite3.connect(DATA_DIR / "bot.db", check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,            -- text | photo | video
        file_id TEXT,
        caption TEXT NOT NULL DEFAULT '',
        publish_at TEXT NOT NULL,      -- UTC ISO
        status TEXT NOT NULL DEFAULT 'pending'  -- pending | done | failed | cancelled
    );
    CREATE TABLE IF NOT EXISTS relays (
        manager_chat_id INTEGER NOT NULL,
        manager_message_id INTEGER NOT NULL,
        customer_chat_id INTEGER NOT NULL,
        PRIMARY KEY (manager_chat_id, manager_message_id)
    );
    """
)
_conn.commit()


@dataclass
class Post:
    id: int
    kind: str
    file_id: str | None
    caption: str
    publish_at: datetime
    status: str


def _row_to_post(row: sqlite3.Row) -> Post:
    return Post(
        id=row["id"],
        kind=row["kind"],
        file_id=row["file_id"],
        caption=row["caption"],
        publish_at=datetime.fromisoformat(row["publish_at"]),
        status=row["status"],
    )


def add_post(kind: str, file_id: str | None, caption: str, publish_at: datetime) -> int:
    cur = _conn.execute(
        "INSERT INTO posts (kind, file_id, caption, publish_at) VALUES (?, ?, ?, ?)",
        (kind, file_id, caption, publish_at.astimezone(timezone.utc).isoformat()),
    )
    _conn.commit()
    return cur.lastrowid


def due_posts(now: datetime) -> list[Post]:
    rows = _conn.execute(
        "SELECT * FROM posts WHERE status = 'pending' AND publish_at <= ? ORDER BY publish_at",
        (now.astimezone(timezone.utc).isoformat(),),
    ).fetchall()
    return [_row_to_post(r) for r in rows]


def pending_posts() -> list[Post]:
    rows = _conn.execute(
        "SELECT * FROM posts WHERE status = 'pending' ORDER BY publish_at"
    ).fetchall()
    return [_row_to_post(r) for r in rows]


def set_status(post_id: int, status: str) -> None:
    _conn.execute("UPDATE posts SET status = ? WHERE id = ?", (status, post_id))
    _conn.commit()


def cancel_post(post_id: int) -> bool:
    cur = _conn.execute(
        "UPDATE posts SET status = 'cancelled' WHERE id = ? AND status = 'pending'", (post_id,)
    )
    _conn.commit()
    return cur.rowcount > 0


def save_relay(manager_chat_id: int, manager_message_id: int, customer_chat_id: int) -> None:
    _conn.execute(
        "INSERT OR REPLACE INTO relays VALUES (?, ?, ?)",
        (manager_chat_id, manager_message_id, customer_chat_id),
    )
    _conn.commit()


def find_relay(manager_chat_id: int, manager_message_id: int) -> int | None:
    row = _conn.execute(
        "SELECT customer_chat_id FROM relays WHERE manager_chat_id = ? AND manager_message_id = ?",
        (manager_chat_id, manager_message_id),
    ).fetchone()
    return row["customer_chat_id"] if row else None
