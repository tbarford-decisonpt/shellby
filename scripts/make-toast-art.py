"""Draw the pictures Shellby's Windows notifications wear (assets/toast/*.png).

Usage:  python scripts/make-toast-art.py [skin-id]
Requires Pillow. Writes assets/toast/logo.png (the round crab in the corner)
and one banner per tone: hero-default, hero-celebrate, hero-alert and
hero-problem.

Windows shows a banner at about 364x180, so it's drawn at 728x364: twice that.
Each scene is painted on a grid of cells, the crab's own pixels drawn 1:1 from
the skin, and the grid is scaled up 8x at the end. Every pixel then shares his
grain, and it lands on whole screen pixels at 1x and 2x.
"""
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "toast"
W, H = 728, 364
PX = 8  # one cell, in image pixels
GW, GH = W // PX, math.ceil(H / PX)

# The panel's own colours (src/renderer/panel/panel.css), plus a few made from them.
DEEP = (15, 30, 33)
SEA = (37, 72, 79)
SAND = (242, 230, 207)
GLASS = (127, 214, 194)
CORAL = (255, 122, 92)
GOLD = (255, 209, 102)
WEED = (43, 138, 140)
WEED_DARK = (29, 95, 90)
SAND_LIT = (204, 184, 143)  # the dune's lit lip
SAND_WET = (146, 131, 104)
SAND_DEEP = (92, 86, 72)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


class Grid:
    """A scene one cell at a time. Colours are opaque; a translucent one is mixed in."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.im = Image.new("RGB", (w, h))
        self.px = self.im.load()

    def put(self, x, y, color, alpha=1.0):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[x, y] = color if alpha >= 1 else mix(self.px[x, y], color, alpha)

    def cells(self, cells, color, ox=0, oy=0, alpha=1.0):
        for x, y in cells:
            self.put(ox + x, oy + y, color, alpha)

    def sprite(self, rows, palette, ox, oy):
        for y, row in enumerate(rows):
            for x, ch in enumerate(row):
                if ch in palette:
                    self.put(ox + x, oy + y, palette[ch])

    def image(self, w, h):
        return self.im.resize((self.w * PX, self.h * PX), Image.NEAREST).crop((0, 0, w, h))


def water(g, top, bottom, bands=10):
    """Water darkening with depth in quiet steps, the way pixel art does a gradient."""
    band_h = g.h / bands
    for y in range(g.h):
        b = min(bands - 1, int(y / band_h))
        for x in range(g.w):
            g.put(x, y, mix(top, bottom, b / (bands - 1)))


def light(g, color, strength, floor):
    """Shafts of light slanting down from the surface, fading as they sink."""
    for start, width in ((18, 9), (58, 7)):
        for y in range(floor):
            fade = strength * (1 - y / floor) ** 1.4
            x0 = start + y // 3
            for x in range(x0, x0 + width):
                # The shaft's edges are fainter than its core.
                edge = 0.5 if x in (x0, x0 + width - 1) else 1
                g.put(x, y, color, fade * edge)


def drift(g, rng, floor, count=16):
    """Specks of sea snow, far off and faint."""
    for _ in range(count):
        g.put(rng.randrange(g.w), rng.randrange(floor - 4), GLASS, rng.choice((0.18, 0.28, 0.4)))


def dune(g, floor, crest_x, rng):
    """The sea floor: a rise of sand under the crab, a lit lip, a few pebbles."""
    lip, body, deep = SAND_LIT, SAND_WET, SAND_DEEP
    heights = []
    for x in range(g.w):
        rise = 2.4 * math.exp(-((x - crest_x) / 16) ** 2) + 0.6 * math.sin(x / 7)
        top = floor - round(rise)
        heights.append(top)
        for y in range(top, g.h):
            g.put(x, y, lip if y == top else (body if y < top + 3 else deep))
    for _ in range(9):
        x = rng.randrange(g.w)
        g.put(x, heights[x] + rng.randrange(2, 5), rng.choice((SAND_LIT, SAND_DEEP)))
    return heights


def seaweed(g, x, floor, height, phase):
    """A frond swaying in steps: two cells wide, shaded on one side."""
    for i in range(height):
        sway = round(1.2 * math.sin(i / 2.2 + phase))
        g.put(x + sway, floor - i, WEED)
        g.put(x + sway + 1, floor - i, WEED_DARK)
        if i % 3 == 1 and i < height - 1:
            g.put(x + sway + (2 if i % 2 else -1), floor - i, WEED)


def bubble(g, x, y, size=1):
    """A ring of glass with a glint, or a single cell for the smallest."""
    if size == 1:
        g.put(x, y, GLASS, 0.8)
        return
    n = size + 1
    ring = [(i, 0) for i in range(1, n)] + [(i, n) for i in range(1, n)] + [(0, j) for j in range(1, n)] + [(n, j) for j in range(1, n)]
    g.cells(ring, GLASS, x, y, 0.85)
    g.put(x + 1, y + 1, SAND)


def crab(g, skin, ox, oy):
    palette = {ch: tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for ch, c in skin["palette"].items()}
    g.sprite(skin["pixels"], palette, ox, oy)


def scene(skin, tone):
    """The banner for one tone: the crab on his dune, and that tone's one prop."""
    rng = random.Random(f"toast-{tone}")
    g = Grid(GW, GH)
    floor = GH - 7
    top, bottom = (DEEP, SEA) if tone != "problem" else (mix(DEEP, (0, 0, 0), 0.25), mix(SEA, DEEP, 0.45))
    water(g, top, bottom)
    glow = {"default": (GLASS, 0.10), "celebrate": (SAND, 0.08), "alert": (CORAL, 0.09)}.get(tone)
    if glow:
        light(g, glow[0], glow[1], floor)
    drift(g, rng, floor)
    rows = skin["pixels"]
    cw, ch = max(len(r) for r in rows), len(rows)
    cx = 26  # his left edge: the crab sits left of centre, the prop takes the right
    heights = dune(g, floor, cx + cw // 2, rng)
    seaweed(g, 4, heights[4] - 1, 11, 0.0)
    seaweed(g, 8, heights[8] - 1, 7, 1.7)
    seaweed(g, GW - 7, heights[GW - 7] - 1, 9, 0.9)
    crab_y = min(heights[cx:cx + cw]) - ch + 1
    crab(g, skin, cx, crab_y)
    PROPS[tone](g, rng, cx, crab_y, cw)
    return g.image(W, H)


def calm(g, rng, cx, cy, cw):
    # A breath of bubbles rising from his mouth, drifting as they climb.
    mouth_x = cx + cw - 1
    for dx, dy, size in ((1, 2, 1), (2, -2, 2), (0, -7, 1), (3, -12, 3), (1, -18, 2), (4, -24, 3)):
        bubble(g, mouth_x + dx, cy + dy, size)


def celebrate(g, rng, cx, cy, cw):
    # A burst of confetti fanning up and out from just above him, thinning at the edges.
    colors = [CORAL, GOLD, GLASS, SAND]
    ox, oy = cx + cw // 2 + 4, cy - 2
    for i in range(44):
        angle = math.radians(rng.uniform(-165, -15))
        reach = rng.triangular(4, 30, 12) * (1.5 if abs(math.cos(angle)) > 0.6 else 1)
        x = round(ox + math.cos(angle) * reach)
        y = round(oy + math.sin(angle) * reach * 0.62) + round(reach / 9)  # pieces drop as they fly
        if y < 1 or (cx - 1 <= x <= cx + cw and y >= cy - 1):
            continue
        piece = rng.choice(([(0, 0), (1, 0)], [(0, 0), (0, 1)], [(0, 0)]))
        g.cells(piece, colors[i % len(colors)], x, y)
    for sx, sy in ((ox - 15, oy - 15), (ox + 13, oy - 19), (ox + 27, oy - 8), (ox - 26, oy - 5)):
        g.cells([(1, 0), (0, 1), (1, 1), (2, 1), (1, 2)], GOLD, sx, sy)
        g.put(sx + 1, sy + 1, SAND)


def alert(g, rng, cx, cy, cw):
    # A speech bubble at his shoulder with "!" in it, the tail pointing at him.
    bw, bh = 13, 11
    ox, oy = cx + cw + 4, cy - bh - 3
    outline = mix(CORAL, DEEP, 0.15)
    for x in range(bw):
        for y in range(bh):
            corner = (x in (0, bw - 1)) and (y in (0, bh - 1))
            if corner:
                continue
            edge = x in (0, bw - 1) or y in (0, bh - 1) or ((x in (1, bw - 2)) and (y in (1, bh - 2)))
            g.put(ox + x, oy + y, outline if edge else SAND)
    # The tail, stepping down and left towards his eyes.
    g.cells([(1, 0), (2, 0), (0, 1), (1, 1), (-1, 2)], outline, ox, oy + bh)
    g.put(ox + 1, oy + bh - 1, SAND)
    g.put(ox + 2, oy + bh - 1, SAND)
    g.cells([(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2), (0, 3), (1, 3), (0, 4), (1, 4), (0, 6), (1, 6)], CORAL, ox + bw // 2 - 1, oy + 2)
    # Little ticks flicking out from the bubble, so it reads as calling for you.
    for dx, dy in ((bw + 1, 1), (bw + 2, 0), (bw + 1, 5), (bw + 3, 5), (bw + 1, 9), (bw + 2, 10)):
        g.put(ox + dx, oy + dy, CORAL, 0.8)


def problem(g, rng, cx, cy, cw):
    # A storm cloud over him: puffy, shaded from below, rain slanting, a bolt of gold.
    ox, oy = cx - 1, cy - 24
    light_c, mid_c, dark_c = (156, 172, 174), (112, 130, 134), (70, 86, 92)
    puffs = ((6, 6, 4.2), (12, 4, 5.2), (19, 5, 4.5), (24, 7, 3.4), (2, 8, 3))
    base = 10  # the cloud's flat underside
    for x in range(-2, 30):
        for y in range(0, base + 1):
            if not any((x - px) ** 2 + (y - py) ** 2 <= r * r for px, py, r in puffs):
                continue
            lit = not any((x - px + 1) ** 2 + (y - py + 1) ** 2 <= r * r for px, py, r in puffs)
            shade = SAND if lit and y < 5 else (light_c if y < 6 else (mid_c if y < base - 1 else dark_c))
            g.put(ox + x, oy + y, shade)
    # Rain in slanting streaks, a regular march with a little jitter.
    for i in range(9):
        x = ox + 2 + i * 3
        y0 = oy + base + 2 + (i * 5) % 4
        for k in range(2):
            g.cells([(0, 0), (0, 1)], GLASS, x - k * 2, y0 + k * 4, 0.75)
    # The bolt, thick enough to read at half size, between two rain streaks.
    bolt = [(2, 0), (3, 0), (1, 1), (2, 1), (0, 2), (1, 2), (2, 2), (3, 2), (1, 3), (2, 3), (0, 4), (1, 4), (0, 5)]
    g.cells(bolt, GOLD, ox + 14, oy + base + 1)


PROPS = {"default": calm, "celebrate": celebrate, "alert": alert, "problem": problem}


def logo(skin):
    """The crab in a porthole of sea. Windows crops it to a circle, so he sits in the middle."""
    rng = random.Random("toast-logo")
    g = Grid(32, 32)
    water(g, DEEP, SEA, bands=4)
    drift(g, rng, 24, 6)
    rows = skin["pixels"]
    cw, ch = max(len(r) for r in rows), len(rows)
    heights = dune(g, 23, 16, rng)
    crab(g, skin, (32 - cw) // 2, min(heights[5:27]) - ch + 1)
    return g.image(256, 256)


def main():
    skin_id = sys.argv[1] if len(sys.argv) > 1 else "classic"
    skin = json.loads((ROOT / "src" / "skins" / f"{skin_id}.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    logo(skin).save(OUT / "logo.png", optimize=True)
    for tone in PROPS:
        scene(skin, tone).save(OUT / f"hero-{tone}.png", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)}/logo.png and {len(PROPS)} banners")


if __name__ == "__main__":
    main()
