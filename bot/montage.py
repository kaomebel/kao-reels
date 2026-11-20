"""Builds a vertical 9:16 Reels video from phone clips and photos with ffmpeg.

Each clip becomes a uniform 1080x1920 segment (slow zoom, caption, brand mark),
then an end card with the logo and call to action is added, the segments are
joined and optional music is mixed in.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1080, 1920, 30
END_SEC = 2.5
FONT_PATH = Path(__file__).with_name("fonts") / "Montserrat.ttf"
GOLD = (230, 184, 79, 255)
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp"}

# Default on-screen captions: the ceramic table script.
DEFAULT_CAPTIONS = [
    "Qaynoq choynak to'g'ridan-to'g'ri stolga",
    "Iz yo'q",
    "Dog' qolmaydi",
    "Tirnalmaydi",
    "KERAMOGRANIT",
    "Temir karkas",
    "Yumshoq va mustahkam",
    "Stol + 4 stul",
]


@dataclass
class Options:
    total: float = 20.0                 # whole video length, end card included
    brand: str = "ATA MEBEL"
    phone: str = ""
    cta: str = "Narxi uchun direktga yozing"
    logo: Path | None = None
    music: Path | None = None
    music_volume: float = 0.8
    captions: list[str] = field(default_factory=list)


def _run(cmd: list[str]) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(cmd[:6])}…\n{res.stderr[-1500:]}")


def probe_duration(path: Path) -> float | None:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(json.loads(res.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return None


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXT


def _font(size: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT_PATH), size)
    try:
        f.set_variation_by_name("Black")
    except Exception:
        pass
    return f


_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]+")


def clean_text(s: str) -> str:
    """ffmpeg/Pillow cannot draw colour emoji, so they are dropped."""
    return re.sub(r"\s+", " ", _EMOJI.sub("", s)).strip()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        t = f"{cur} {word}".strip()
        if cur and draw.textlength(t, font=font) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


def caption_png(text: str, out: Path) -> Path:
    """White rounded plates with dark text, centred at 24% of the height."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    text = clean_text(text)
    if text:
        d = ImageDraw.Draw(img)
        fs = int(W * 0.068)
        font = _font(fs)
        lines = _wrap(d, text, font, int(W * 0.8))
        lh, pad = int(fs * 1.28), int(fs * 0.42)
        top = int(H * 0.24 - len(lines) * lh / 2)
        for i, ln in enumerate(lines):
            tw = d.textlength(ln, font=font)
            x0, y0 = (W - tw) / 2 - pad, top + i * lh
            d.rounded_rectangle((x0, y0, x0 + tw + 2 * pad, y0 + lh - 6), radius=int(fs * 0.24), fill=(255, 255, 255, 255))
            d.text((W / 2, y0 + (lh - 6) / 2), ln, font=font, fill=(18, 18, 18, 255), anchor="mm")
    img.save(out)
    return out


def brand_png(opts: Options, out: Path) -> Path:
    """Top brand mark plus a soft dark gradient so it reads on bright footage."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grad = Image.new("L", (1, int(H * 0.4)))
    for y in range(grad.height):
        grad.putpixel((0, y), int(90 * (1 - y / grad.height)))
    img.paste((0, 0, 0, 255), (0, 0, W, grad.height), grad.resize((W, grad.height)))
    y = int(H * 0.085)
    if opts.logo and opts.logo.exists():
        logo = Image.open(opts.logo).convert("RGBA")
        lh = int(W * 0.075)
        logo = logo.resize((max(1, int(logo.width * lh / logo.height)), lh), Image.LANCZOS)
        img.alpha_composite(logo, ((W - logo.width) // 2, y - lh // 2))
    elif opts.brand.strip():
        txt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(txt)
        font = _font(int(W * 0.034))
        label = " ".join(clean_text(opts.brand).upper())
        d.text((W / 2, y), label, font=font, fill=(0, 0, 0, 170), anchor="mm")
        img.alpha_composite(txt.filter(ImageFilter.GaussianBlur(8)))
        d2 = ImageDraw.Draw(img)
        d2.text((W / 2, y), label, font=font, fill=GOLD, anchor="mm")
    img.save(out)
    return out


def end_card_png(last_frame: Path, opts: Options, out: Path) -> Path:
    base = Image.open(last_frame).convert("RGB").resize((W, H))
    base = base.filter(ImageFilter.GaussianBlur(6)).convert("RGBA")
    base.alpha_composite(Image.new("RGBA", (W, H), (10, 10, 12, 190)))
    d = ImageDraw.Draw(base)
    cy = int(H * 0.42)
    if opts.logo and opts.logo.exists():
        logo = Image.open(opts.logo).convert("RGBA")
        lw = int(W * 0.6)
        logo = logo.resize((lw, max(1, int(logo.height * lw / logo.width))), Image.LANCZOS)
        if logo.height > W * 0.6:
            lh = int(W * 0.6)
            logo = logo.resize((max(1, int(logo.width * lh / logo.height)), lh), Image.LANCZOS)
        base.alpha_composite(logo, ((W - logo.width) // 2, cy - logo.height // 2))
    else:
        d.text((W / 2, cy), clean_text(opts.brand).upper() or "ATA MEBEL", font=_font(int(W * 0.13)), fill=GOLD, anchor="mm")
    cta = clean_text(opts.cta)
    if cta:
        font = _font(int(W * 0.055))
        for i, ln in enumerate(_wrap(d, cta, font, int(W * 0.84))):
            d.text((W / 2, H * 0.6 + i * W * 0.055 * 1.25), ln, font=font, fill=(255, 255, 255, 255), anchor="mm")
    if opts.phone.strip():
        d.text((W / 2, H * 0.72), opts.phone.strip(), font=_font(int(W * 0.05)), fill=GOLD, anchor="mm")
    base.convert("RGB").save(out, quality=95)
    return out


ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"]


def _segment(src: Path, start: float, length: float, cap: Path, brand: Path, out: Path, first: bool) -> None:
    zoom = f"1.02+0.06*t/{length:.3f}"
    if not first:  # quick punch-in at each cut
        zoom += "+0.07*max(0,1-t/0.22)"
    src_in = (["-loop", "1", "-framerate", str(FPS), "-t", f"{length:.3f}", "-i", str(src)] if is_image(src)
              else ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src)])
    flash = "" if first else ",fade=t=in:st=0:d=0.14:color=white"
    fc = (
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,fps={FPS},"
        f"scale=w='trunc({W}*({zoom})/2)*2':h=-2:eval=frame,crop={W}:{H}{flash}[v0];"
        f"[1:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1[cap];"
        f"[v0][2:v]overlay=0:0[v1];[v1][cap]overlay=0:0:shortest=1,format=yuv420p[v]"
    )
    _run(["ffmpeg", "-y", "-loglevel", "error", *src_in,
          "-loop", "1", "-framerate", str(FPS), "-t", f"{length:.3f}", "-i", str(cap),
          "-loop", "1", "-framerate", str(FPS), "-t", f"{length:.3f}", "-i", str(brand),
          "-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=44100:cl=stereo",
          "-filter_complex", fc, "-map", "[v]", "-map", "3:a", "-t", f"{length:.3f}", *ENC, str(out)])


def make_reel(clips: list[Path], opts: Options, out: Path) -> Path:
    if not clips:
        raise ValueError("no clips")
    work = Path(tempfile.mkdtemp(prefix="reel_"))
    try:
        body = max(3.0, opts.total - END_SEC)
        per = body / len(clips)
        captions = opts.captions or DEFAULT_CAPTIONS
        brand = brand_png(opts, work / "brand.png")
        segs: list[Path] = []
        for i, c in enumerate(clips):
            start, length = 0.0, per
            if not is_image(c):
                dur = probe_duration(c) or per
                start = 0.3 if dur > per + 0.6 else 0.0
                length = max(0.6, min(per, dur - start - 0.05))
            cap = caption_png(captions[i] if i < len(captions) else "", work / f"cap{i}.png")
            seg = work / f"seg{i:02d}.mp4"
            _segment(c, start, length, cap, brand, seg, first=(i == 0))
            segs.append(seg)

        last = work / "last.png"
        _run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", "-0.2", "-i", str(segs[-1]), "-frames:v", "1", "-update", "1", str(last)])
        card = end_card_png(last, opts, work / "end.png")
        end = work / "end.mp4"
        _run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-t", str(END_SEC), "-i", str(card),
              "-f", "lavfi", "-t", str(END_SEC), "-i", "anullsrc=r=44100:cl=stereo",
              "-filter_complex", f"[0:v]scale=w='trunc({W}*(1+0.03*t/{END_SEC})/2)*2':h=-2:eval=frame,crop={W}:{H},fade=t=in:st=0:d=0.3,format=yuv420p[v]",
              "-map", "[v]", "-map", "1:a", "-t", str(END_SEC), *ENC, str(end)])
        segs.append(end)

        lst = work / "list.txt"
        lst.write_text("".join(f"file '{s.as_posix()}'\n" for s in segs))
        joined = work / "joined.mp4"
        _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])

        total = probe_duration(joined) or opts.total
        if opts.music and opts.music.exists():
            fade_st = max(0.0, total - 1.2)
            _run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-stream_loop", "-1", "-i", str(opts.music),
                  "-filter_complex", f"[1:a]volume={opts.music_volume},afade=t=out:st={fade_st:.2f}:d=1.2[a]",
                  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
                  "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
        else:
            _run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-c", "copy", "-movflags", "+faststart", str(out)])
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)
