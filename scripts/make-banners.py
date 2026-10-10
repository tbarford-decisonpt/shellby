"""Compose the README banner and lineup cards from the crabs `npm run screenshots`
just captured (docs/img/critter-*.png). Run it after the screenshots:

    npm run screenshots && python scripts/make-banners.py

Needs Pillow. Writes docs/img/banner.png, docs/img/lineup-crabs.png, docs/img/lineup-sets.png
and docs/img/lineup-life.png.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "img"
PIXEL = str(ROOT / "assets" / "fonts" / "PixelifySans.ttf")
BODY = str(ROOT / "assets" / "fonts" / "AtkinsonHyperlegible-Regular.ttf")

# The panel's own colours (src/renderer/panel/panel.css).
DEEP = (15, 30, 33)
SEA = (37, 72, 79)
SAND = (242, 230, 207)
GLASS = (127, 214, 194)
CORAL = (255, 122, 92)
MUTED = (168, 196, 190)


def crab(name, scale=1.0):
    """A captured crab, trimmed to what's drawn (bubble and effects included)."""
    im = Image.open(DOCS / f"critter-{name}.png").convert("RGBA")
    im = im.crop(im.getbbox())
    if scale != 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.NEAREST)
    return im


def backdrop(w, h, radius=0):
    """Deep water fading up to the panel's sea colour, with a sandy floor of pixels."""
    im = Image.new("RGBA", (w, h))
    px = im.load()
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(round(DEEP[i] + (SEA[i] - DEEP[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = (*c, 255)
    # Translucent things go on their own layer: drawing them straight onto an
    # RGBA image replaces the pixels' alpha instead of blending.
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # A few drifting bubbles, placed by a fixed pattern so reruns match.
    for i in range(26):
        x = (i * 397) % w
        y = (i * 211) % max(1, h - 60)
        s = 2 + (i % 3) * 2
        d.rectangle([x, y, x + s, y + s], fill=(*GLASS, 40 + (i % 4) * 18))
    # Sand.
    d.rectangle([0, h - 18, w, h], fill=(*SAND, 22))
    im.alpha_composite(layer)
    if radius:
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius, fill=255)
        im.putalpha(mask)
    return im


def lineup(names, captions, out, title=None, scale=1.0, pad=48):
    crabs = [crab(n, scale) for n in names]
    cap_font = ImageFont.truetype(PIXEL, 20)
    title_font = ImageFont.truetype(PIXEL, 30)
    cell = max(c.width for c in crabs) + pad
    tallest = max(c.height for c in crabs)
    top = 70 if title else 30
    w, h = cell * len(crabs) + pad, top + tallest + 70
    im = backdrop(w, h, radius=22)
    d = ImageDraw.Draw(im)
    if title:
        d.text((w / 2, 38), title, font=title_font, fill=SAND, anchor="mm")
    for i, (c, cap) in enumerate(zip(crabs, captions)):
        cx = pad // 2 + cell * i + cell // 2
        im.alpha_composite(c, (cx - c.width // 2, top + tallest - c.height))
        d.text((cx, top + tallest + 30), cap, font=cap_font, fill=GLASS, anchor="mm")
    im.save(DOCS / out)
    print("wrote", f"docs/img/{out}", im.size)


def banner():
    w, h = 1280, 420
    im = backdrop(w, h)
    d = ImageDraw.Draw(im)
    title = ImageFont.truetype(PIXEL, 112)
    tag = ImageFont.truetype(BODY, 30)
    d.text((70, 172), "Shellby", font=title, fill=SAND, anchor="ls")
    d.text((74, 228), "A pixel hermit crab for your Windows desktop", font=tag, fill=SAND, anchor="ls")
    d.text((74, 268), "who gets things done with Claude Code.", font=tag, fill=MUTED, anchor="ls")
    # The cast, standing on the sand, the star a little bigger and up front.
    cast = [("set-tide-pool", 1.0), ("music", 1.0), ("voice", 1.25)]
    x = w - 30
    for name, s in reversed(cast):
        c = crab(name, s)
        x -= c.width
        im.alpha_composite(c, (x, h - 26 - c.height))
        x += 48  # their effects have room around them; let those overlap, not the words
    d.rectangle([0, h - 6, w, h], fill=(*CORAL, 255))
    im.save(DOCS / "banner.png")
    print("wrote docs/img/banner.png", im.size)


if __name__ == "__main__":
    banner()
    lineup(
        ["idle", "species-fiddler", "species-coconut", "species-porcelain", "species-spider"],
        ["classic", "fiddler", "coconut", "porcelain", "spider"],
        "lineup-crabs.png", title="Not every crab is the classic shape",
    )
    lineup(
        ["set-dev-desk", "set-tide-pool", "set-on-call", "music", "conch"],
        ["dev desk", "tide pool", "on call", "listening along", "golden conch"],
        "lineup-sets.png", title="Dressed head to tail",
    )
    lineup(
        ["voice", "focus", "ci", "hot", "sleeping"],
        ["talks shop", "guards focus", "red build", "GPU at 83°C", "naps"],
        "lineup-life.png", title="He reacts to what's actually happening",
    )
