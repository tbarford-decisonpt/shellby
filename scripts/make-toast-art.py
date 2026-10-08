"""Draw the pictures Shellby's Windows notifications wear (assets/toast/*.png).

Usage:  python scripts/make-toast-art.py [skin-id]
Requires Pillow. Writes assets/toast/logo.png (the round crab in the corner)
and one banner per tone: hero-default, hero-celebrate, hero-alert and
hero-problem. Windows shows banners at 2:1, so they're drawn at 728x364 and
scaled down crisply on ordinary screens.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module  # noqa: E402

icons = import_module("make-icons")
banners = import_module("make-banners")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "toast"
W, H = 728, 364
PX = 8  # one art pixel, in image pixels

SAND, GLASS, CORAL, DEEP = banners.SAND, banners.GLASS, banners.CORAL, banners.DEEP
GOLD = (255, 209, 102)


def blocks(d, cells, color, ox, oy):
    """Chunky pixels, so the extras match the crab's own grain."""
    for x, y in cells:
        d.rectangle([ox + x * PX, oy + y * PX, ox + (x + 1) * PX - 1, oy + (y + 1) * PX - 1], fill=color)


def celebrate(d):
    # Confetti, placed by a fixed pattern so reruns match.
    colors = [CORAL, GOLD, GLASS, SAND]
    for i in range(34):
        x = 24 + (i * 173) % (W - 48)
        y = 16 + (i * 97) % (H - 120)
        if 250 < x < 480 and y > 90:
            continue  # keep the crab clear
        c = colors[i % len(colors)]
        cells = [(0, 0), (1, 0)] if i % 2 else [(0, 0), (0, 1)]
        blocks(d, cells, (*c, 230), x, y)


def alert(d):
    # A speech bubble with "!" above his shoulder: he wants you.
    ox, oy = 470, 54
    bubble = [(x, y) for x in range(9) for y in range(8) if not ((x in (0, 8)) and (y in (0, 7)))]
    blocks(d, bubble, (*SAND, 255), ox, oy)
    blocks(d, [(1, 8), (0, 9)], (*SAND, 255), ox, oy)
    blocks(d, [(4, 1), (4, 2), (4, 3), (4, 4), (4, 6)], (*CORAL, 255), ox, oy)


def problem(d):
    # A small storm cloud drizzling over him.
    ox, oy = 300, 22
    cloud = [(x, y) for y in range(4) for x in range(1 if y in (0, 3) else 0, 15 if y in (0, 3) else 16)]
    blocks(d, cloud, (120, 138, 142, 255), ox, oy)
    drops = [(x, y0 + dy) for i, x in enumerate(range(2, 15, 3)) for y0 in [5 + (i * 2) % 3] for dy in (0, 1)]
    blocks(d, drops, (*GLASS, 200), ox, oy)


def hero(skin, extra=None, tint=None):
    im = banners.backdrop(W, H)
    if tint:
        wash = Image.new("RGBA", (W, H), (*tint, 34))
        im.alpha_composite(wash)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if extra:
        extra(ImageDraw.Draw(layer))
    im.alpha_composite(layer)
    crab = icons.render(skin, 232, 0.02)
    crab = crab.crop(crab.getbbox())
    im.alpha_composite(crab, ((W - crab.width) // 2, H - 22 - crab.height))
    return im.convert("RGB")


def logo(skin):
    """The crab on a deep-sea square. Windows crops it to a circle."""
    size = 256
    im = Image.new("RGBA", (size, size), (*DEEP, 255))
    crab = icons.render(skin, 176, 0.02)
    im.alpha_composite(crab, ((size - crab.width) // 2, (size - crab.height) // 2 + 8))
    return im.convert("RGB")


def main():
    skin_id = sys.argv[1] if len(sys.argv) > 1 else "classic"
    skin = json.loads((ROOT / "src" / "skins" / f"{skin_id}.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    logo(skin).save(OUT / "logo.png", optimize=True)
    hero(skin).save(OUT / "hero-default.png", optimize=True)
    hero(skin, celebrate).save(OUT / "hero-celebrate.png", optimize=True)
    hero(skin, alert).save(OUT / "hero-alert.png", optimize=True)
    hero(skin, problem, tint=(0, 0, 0)).save(OUT / "hero-problem.png", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)}/logo.png and 4 banners")


if __name__ == "__main__":
    main()
