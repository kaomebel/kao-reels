"""Avtomatik montaj: rasm va videolardan 9:16 (1080x1920) Reels yasaydi (ffmpeg).

- Rasmlar: sekin zoom (Ken Burns) effekti
- Videolar: kerakli qismi kesiladi, vertikal formatga keltiriladi
- Kliplar orasida silliq o'tish (crossfade)
- Boshida katta "hook" yozuvi, oxirida chaqiriq (CTA) yozuvi
- media/music papkasidan musiqa qo'shiladi (oxirida sekin pasayadi)
"""
import json
import logging
import random
import subprocess
import tempfile
from pathlib import Path

from . import config

log = logging.getLogger("montage")
W, H, FPS = 1080, 1920, 30
PHOTO_SEC, VIDEO_SEC, XFADE = 2.6, 4.0, 0.4
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".ogg"}


def library_files() -> list[str]:
    exts = IMAGE_EXT | VIDEO_EXT
    return sorted(
        str(p.relative_to(config.LIBRARY_DIR))
        for p in config.LIBRARY_DIR.rglob("*") if p.suffix.lower() in exts
    )


def _duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return float(json.loads(out)["format"].get("duration") or 0)


def _text_filter(textfile: Path, start: float, end: float, y: str, size: int) -> str:
    return (
        f"drawtext=fontfile='{config.FONT_PATH}':textfile='{textfile}':fontsize={size}:"
        f"fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=28:line_spacing=12:"
        f"x=(w-text_w)/2:y={y}:enable='between(t,{start:.2f},{end:.2f})'"
    )


def _fit(i: int, w: int, h: int) -> str:
    """Rasmni kesmasdan joylaydi: orqada xira (blur) fon, oldinda to'liq kadr."""
    return (
        f"split[bg{i}][fg{i}];"
        f"[bg{i}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=30:3[bgb{i}];"
        f"[fg{i}]scale={w}:{h}:force_original_aspect_ratio=decrease[fgs{i}];"
        f"[bgb{i}][fgs{i}]overlay=(W-w)/2:(H-h)/2"
    )


def _wrap(text: str, width: int = 18) -> str:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def render(media: list[str], hook: str, out_name: str, cta: str = "Batafsil — direktda",
           music: str | None = None) -> Path:
    files = [config.LIBRARY_DIR / m for m in media if (config.LIBRARY_DIR / m).exists()]
    if not files:
        raise ValueError("Montaj uchun media fayl topilmadi")
    config.RENDER_DIR.mkdir(parents=True, exist_ok=True)
    out = config.RENDER_DIR / f"{out_name}.mp4"

    args, chains, durs = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"], [], []
    for i, f in enumerate(files):
        if f.suffix.lower() in IMAGE_EXT:
            frames = int(PHOTO_SEC * FPS)
            args += ["-i", str(f)]
            zin = random.choice(["min(zoom+0.0009,1.15)", "if(eq(on,0),1.15,max(zoom-0.0009,1.0))"])
            chains.append(
                f"[{i}:v]{_fit(i, W * 2, H * 2)},"
                f"zoompan=z='{zin}':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS},"
                f"setsar=1,format=yuv420p,settb=AVTB[v{i}]"
            )
            durs.append(frames / FPS)
        else:
            d = min(VIDEO_SEC, _duration(f) or VIDEO_SEC)
            args += ["-t", f"{d:.2f}", "-i", str(f)]
            chains.append(f"[{i}:v]{_fit(i, W, H)},fps={FPS},setsar=1,format=yuv420p,settb=AVTB[v{i}]")
            durs.append(d)

    # Crossfade bilan ulash
    last, total = "v0", durs[0]
    for i in range(1, len(files)):
        offset = total - XFADE
        chains.append(f"[{last}][v{i}]xfade=transition=fade:duration={XFADE}:offset={offset:.2f}[x{i}]")
        last, total = f"x{i}", offset + durs[i]

    tmp = Path(tempfile.mkdtemp())
    hook_f, cta_f = tmp / "hook.txt", tmp / "cta.txt"
    hook_f.write_text(_wrap(hook), encoding="utf-8")
    cta_f.write_text(_wrap(cta, 24), encoding="utf-8")
    chains.append(
        f"[{last}]{_text_filter(hook_f, 0, min(3.0, total), '(h-text_h)/2-200', 78)},"
        f"{_text_filter(cta_f, max(0, total - 2.2), total, 'h-text_h-260', 58)}[vout]"
    )

    # Musiqa
    tracks = [p for p in config.MUSIC_DIR.glob("*") if p.suffix.lower() in AUDIO_EXT]
    track = config.MUSIC_DIR / music if music else (random.choice(tracks) if tracks else None)
    a_idx = len(files)
    if track and track.exists():
        args += ["-stream_loop", "-1", "-i", str(track)]
        chains.append(f"[{a_idx}:a]atrim=0:{total:.2f},afade=t=in:d=0.5,"
                      f"afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5,volume=0.8[aout]")
    else:
        args += ["-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=r=44100:cl=stereo"]
        chains.append(f"[{a_idx}:a]anull[aout]")

    args += [
        "-filter_complex", ";".join(chains), "-map", "[vout]", "-map", "[aout]",
        "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-r", str(FPS), "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", str(out),
    ]
    log.info("Montaj: %d ta fayl, %.1fs -> %s", len(files), total, out.name)
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg xatosi: {res.stderr[-2000:]}")
    return out
