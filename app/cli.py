"""Terminaldan sinash:

  python -m app.cli reply "Assalomu alaykum, narxi qancha?"     # AI qanday javob berishini ko'rish
  python -m app.cli reply "Zo'r!" --comment
  python -m app.cli plan --days 7 --goals "yangi ATA divanni sotish"
  python -m app.cli montage media/library/a.jpg media/library/b.mp4 --hook "Yangi ATA divan"
  python -m app.cli learn "Kafolat bormi?" "Ha, 12 oy kafolat beramiz 🤝"
"""
import argparse
import asyncio
import json
from pathlib import Path

from . import ai, config, db, montage, scheduler


def main():
    p = argparse.ArgumentParser(prog="kao")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reply")
    r.add_argument("text")
    r.add_argument("--comment", action="store_true")
    r.add_argument("--platform", default="instagram")
    pl = sub.add_parser("plan")
    pl.add_argument("--days", type=int, default=7)
    pl.add_argument("--per-day", type=int, default=1)
    pl.add_argument("--goals", default="")
    m = sub.add_parser("montage")
    m.add_argument("files", nargs="+")
    m.add_argument("--hook", default="KAO Mebel")
    m.add_argument("--out", default="test")
    le = sub.add_parser("learn")
    le.add_argument("incoming")
    le.add_argument("reply")
    a = p.parse_args()
    db.init()

    if a.cmd == "reply":
        kind = "comment" if a.comment else "dm"
        hist = [{"direction": "in", "text": a.text}]
        res = asyncio.run(ai.draft_reply(a.platform, kind, "test_user", a.text, hist))
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif a.cmd == "plan":
        items = asyncio.run(scheduler.generate_plan(a.days, a.per_day, a.goals))
        for it in items:
            print(f"{it['publish_at'][:16]}  {it['topic']}\n   hook: {it['hook']}\n   media: {it['media']}\n")
    elif a.cmd == "montage":
        rel = []
        for f in a.files:
            path = Path(f).resolve()
            try:
                rel.append(str(path.relative_to(config.LIBRARY_DIR)))
            except ValueError:
                raise SystemExit(f"Fayl media/library ichida bo'lishi kerak: {f}")
        print(montage.render(rel, a.hook, a.out))
    elif a.cmd == "learn":
        db.add_example(a.incoming, a.reply, source="cli")
        print("Saqlandi")


if __name__ == "__main__":
    main()
