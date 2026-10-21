"""Builds a vertical 1080x1920 Reels video from photos/videos with ffmpeg."""
import asyncio
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

W, H, FPS = 1080, 1920, 30
PHOTO_SECONDS = 3
MAX_SECONDS = 90
FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")


class MontageError(Exception):
    pass


@dataclass
class Clip:
    path: Path
    is_photo: bool


async def _run(*args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise MontageError(err.decode(errors="ignore")[-800:])
    return out.decode(errors="ignore")


async def _has_audio(path: Path) -> bool:
    out = await _run("ffprobe", "-v", "error", "-select_streams", "a",
                     "-show_entries", "stream=index", "-of", "json", str(path))
    return bool(json.loads(out).get("streams"))


# Fit the frame inside 1080x1920 over a blurred, zoomed copy of itself,
# so horizontal footage doesn't get black bars.
_FIT = (
    f"split[a][b];"
    f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:5[bg];"
    f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
    f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={FPS},format=yuv420p"
)

_ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
           "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"]


async def _normalize(clip: Clip, out: Path) -> None:
    if clip.is_photo:
        await _run(
            "ffmpeg", "-y", "-loop", "1", "-t", str(PHOTO_SECONDS), "-i", str(clip.path),
            "-f", "lavfi", "-t", str(PHOTO_SECONDS), "-i", "anullsrc=r=44100:cl=stereo",
            "-filter_complex",
            f"[0:v]{_FIT},zoompan=z='min(zoom+0.0008,1.08)':d=1:s={W}x{H}:fps={FPS}[v]",
            "-map", "[v]", "-map", "1:a", *_ENCODE, "-shortest", str(out),
        )
        return

    audio = ["-map", "0:a:0"] if await _has_audio(clip.path) else ["-map", "1:a"]
    await _run(
        "ffmpeg", "-y", "-i", str(clip.path),
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-filter_complex", f"[0:v]{_FIT}[v]",
        "-map", "[v]", *audio, *_ENCODE, "-shortest", "-t", str(MAX_SECONDS), str(out),
    )


async def build_reel(clips: list[Clip], workdir: Path, music: Path | None = None,
                     brand_text: str = "") -> Path:
    if not clips:
        raise MontageError("Материал йўқ")
    if not shutil.which("ffmpeg"):
        raise MontageError("Серверда ffmpeg ўрнатилмаган")

    parts = []
    for i, clip in enumerate(clips):
        part = workdir / f"part{i:03d}.mp4"
        await _normalize(clip, part)
        parts.append(part)

    concat_list = workdir / "list.txt"
    concat_list.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    joined = workdir / "joined.mp4"
    await _run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
               "-c", "copy", str(joined))

    vfilter = "null"
    if brand_text and FONT.exists():
        safe = brand_text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        vfilter = (f"drawtext=fontfile={FONT}:text='{safe}':fontcolor=white@0.85:fontsize=54:"
                   f"x=(w-text_w)/2:y=h-220:shadowcolor=black@0.6:shadowx=3:shadowy=3")

    result = workdir / "reel.mp4"
    if music:
        # Background music replaces the original sound.
        await _run(
            "ffmpeg", "-y", "-i", str(joined), "-stream_loop", "-1", "-i", str(music),
            "-filter_complex", f"[0:v]{vfilter}[v];[1:a]volume=0.8[a]",
            "-map", "[v]", "-map", "[a]", *_ENCODE, "-shortest", "-t", str(MAX_SECONDS),
            "-movflags", "+faststart", str(result),
        )
    else:
        await _run(
            "ffmpeg", "-y", "-i", str(joined), "-vf", vfilter, *_ENCODE,
            "-t", str(MAX_SECONDS), "-movflags", "+faststart", str(result),
        )
    return result
