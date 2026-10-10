"""Turn the frames recorded by `npm run reel` (src/main/reel.js) into the README GIF
and, when imageio-ffmpeg is installed, an MP4 for social posts.

Usage:  python scripts/make-reel.py [frames_dir]
        (default frames_dir: %TEMP%/shellby-reel, or $SHELLBY_REEL_DIR)
Writes: docs/img/shellby-demo.gif  (960x540, for the README)
        docs/img/shellby-demo.mp4  (1920x1080, if `pip install imageio-ffmpeg`)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "assets" / "fonts"
SCENE_W, SCENE_H = 1300, 731          # logical px, 16:9
PANEL_AT = (190, 80)                  # where the panel's top-left lands in the scene
CAPTION_FADE_MS = 350
HOLD_END_MS = 1400                    # linger on the last frame before the loop restarts
SAND, GLASS, CORAL = (243, 230, 204), (127, 214, 194), (255, 122, 92)


def wallpaper(w, h):
    """Deep tidepool gradient with soft light, like Shellby's panel but bigger."""
    top, bottom = (14, 46, 56), (5, 18, 22)
    bg = Image.new("RGB", (w, h))
    px = bg.load()
    for y in range(h):
        k = y / (h - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * k) for i in range(3))
        for x in range(w):
            px[x, y] = row
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    for (cx, cy, r, col) in [(0.82, 0.15, 0.42, (*GLASS, 38)), (0.12, 0.95, 0.5, (*CORAL, 26)), (0.6, 0.9, 0.35, (*GLASS, 20))]:
        d.ellipse([(cx - r) * w, cy * h - r * w, (cx + r) * w, cy * h + r * w], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(w * 0.08))
    out = bg.convert("RGBA")
    out.alpha_composite(glow)
    return out


def font(name, size):
    try:
        return ImageFont.truetype(str(FONTS / name), size)
    except OSError:
        return ImageFont.load_default()


def caption_at(marks, t):
    """(text, alpha 0..1) for time t, crossfading at each mark."""
    current = None
    for i, m in enumerate(marks):
        if t >= m["t"]:
            current = (i, m)
    if current is None:
        return None, 0
    i, m = current
    a = min(1, (t - m["t"]) / CAPTION_FADE_MS)
    nxt = marks[i + 1]["t"] if i + 1 < len(marks) else None
    if nxt is not None:
        a = min(a, max(0, (nxt - t) / CAPTION_FADE_MS))
    return m["caption"], a


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SHELLBY_REEL_DIR", Path(tempfile.gettempdir()) / "shellby-reel"))
    meta = json.loads((src / "frames.json").read_text())
    frames, marks, fps = meta["frames"], meta["marks"], meta["fps"]
    first = frames[0]
    scale = Image.open(src / f"p{first['i']}.jpg").width / first["panel"]["width"]   # capture DPI (1.5 on a 150% display)
    S = scale
    W, H = round(SCENE_W * S), round(SCENE_H * S)
    ox = PANEL_AT[0] - first["panel"]["x"]
    oy = PANEL_AT[1] - first["panel"]["y"]

    base = wallpaper(W, H)
    cap_font = font("PixelifySans.ttf", round(34 * S))
    step_font = font("MartianMono.ttf", round(13 * S))
    brand_font = font("PixelifySans.ttf", round(24 * S))
    url_font = font("AtkinsonHyperlegible-Regular.ttf", round(14 * S))

    # Panel drop shadow (the panel window never moves).
    pb = first["panel"]
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [(pb["x"] + ox) * S + 6 * S, (pb["y"] + oy) * S + 14 * S, (pb["x"] + ox + pb["width"]) * S + 6 * S, (pb["y"] + oy + pb["height"]) * S + 14 * S],
        radius=12 * S, fill=(0, 0, 0, 150))
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18 * S)))

    # Brand, top right.
    d = ImageDraw.Draw(base)
    d.text((W - 40 * S, 28 * S), "Shellby", font=brand_font, fill=SAND, anchor="ra")
    d.text((W - 40 * S, 58 * S), "getshellby.com", font=url_font, fill=(*GLASS, 255), anchor="ra")

    total = frames[-1]["t"] + HOLD_END_MS
    out = []
    n = int(total * fps / 1000)
    j = 0
    for k in range(n):
        t = k * 1000 / fps
        while j + 1 < len(frames) and frames[j + 1]["t"] <= t:
            j += 1
        fr = frames[j]
        img = base.copy()
        p = Image.open(src / f"p{fr['i']}.jpg").convert("RGBA")
        img.alpha_composite(p, (round((fr["panel"]["x"] + ox) * S), round((fr["panel"]["y"] + oy) * S)))
        c = Image.open(src / f"c{fr['i']}.png").convert("RGBA")
        img.alpha_composite(c, (round((fr["critter"]["x"] + ox) * S), round((fr["critter"]["y"] + oy) * S)))
        text, a = caption_at(marks, min(t, frames[-1]["t"]))
        if text and a > 0:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            step = marks.index(next(m for m in marks if m["caption"] == text)) + 1
            ld.text((PANEL_AT[0] * S, 22 * S), f"{step}/{len(marks)}", font=step_font, fill=(*CORAL, round(255 * a)))
            ld.text((PANEL_AT[0] * S + 44 * S, 14 * S), text, font=cap_font, fill=(*SAND, round(255 * a)))
            img.alpha_composite(layer)
        out.append(img.convert("RGB"))

    docs = ROOT / "docs" / "img"
    # ---- GIF: one shared palette (no flicker), no dithering (flat UI colours stay clean)
    gw, gh = 960, 540
    small = [f.resize((gw, gh), Image.LANCZOS) for f in out]
    sample = Image.new("RGB", (gw, gh * 6))
    for i in range(6):
        sample.paste(small[int(i * (len(small) - 1) / 5)], (0, gh * i))
    palette = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    gif = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in small]
    durations = [round(1000 / fps)] * len(gif)
    durations[-1] = HOLD_END_MS
    gif_path = docs / "shellby-demo.gif"
    gif[0].save(gif_path, save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"wrote {gif_path.relative_to(ROOT)} ({gif_path.stat().st_size / 1e6:.1f} MB, {len(gif)} frames)")

    # ---- MP4 for social (optional)
    try:
        import imageio_ffmpeg
    except ImportError:
        print("skipped MP4 (pip install imageio-ffmpeg to make one)")
        return
    vw, vh = 1920, 1080
    mp4_path = docs / "shellby-demo.mp4"
    writer = imageio_ffmpeg.write_frames(str(mp4_path), (vw, vh), fps=fps, codec="libx264", quality=None, macro_block_size=1,
                                         output_params=["-crf", "18", "-preset", "slow", "-movflags", "+faststart"])
    writer.send(None)
    for f in out + [out[-1]] * round(HOLD_END_MS * fps / 1000):
        writer.send(f.resize((vw, vh), Image.LANCZOS).tobytes())
    writer.close()
    print(f"wrote {mp4_path.relative_to(ROOT)} ({mp4_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
