"""Contact sheet of every wardrobe accessory worn by the crab, plus season outfits.

Usage:  python scripts/preview-wardrobe.py [out.png] [--skin classic] [--pack path]
Uses the same anchor + pivot maths as the app (see docs/ADDONS.md).
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ANCHORS = {"head": (15, -1), "face": (15, 0), "neck": (15, 4), "claw": (21, 6), "shellTop": (7, 0)}
SLOT_ANCHOR = {"hat": "head", "face": "face", "neck": "neck", "held": "claw", "shell": "shellTop"}
SEASON_OUTFITS = {
    "halloween": {"hat": "witch-hat", "held": "pumpkin-pail", "shell": "bat-wings"},
    "winter": {"hat": "santa-hat", "neck": "striped-scarf", "held": "candy-cane"},
    "valentine": {"held": "rose"},
    "spring": {"hat": "flower-crown", "shell": "sprout"},
    "summer": {"face": "sunglasses", "held": "ice-cream"},
    "autumn": {"neck": "autumn-scarf"},
}
PAD_TOP, PAD_LEFT, W, H = 10, 2, 28, 24   # canvas in sprite pixels around the 22x13 crab


def hex_rgb(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def paint(img, pixels, palette, ox, oy):
    for y, row in enumerate(pixels):
        for x, ch in enumerate(row):
            if ch in palette:
                px, py = ox + x, oy + y
                if 0 <= px < img.width and 0 <= py < img.height:
                    img.putpixel((px, py), hex_rgb(palette[ch]))


def wear(skin, items, anchors):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    paint(img, skin["pixels"], skin["palette"], PAD_LEFT, PAD_TOP)
    for it in items:
        ax, ay = anchors[it.get("anchor") or SLOT_ANCHOR[it["slot"]]]
        px, py = it["pivot"]
        paint(img, it["pixels"], it["palette"], PAD_LEFT + ax - px, PAD_TOP + ay - py)
    return img


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0]) if args else ROOT / "docs" / "wardrobe-sheet.png"
    skin_id = sys.argv[sys.argv.index("--skin") + 1] if "--skin" in sys.argv else "classic"
    pack_path = Path(sys.argv[sys.argv.index("--pack") + 1]) if "--pack" in sys.argv else ROOT / "src" / "wardrobe" / "base.pack.json"
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    skin = json.loads((ROOT / "src" / "skins" / f"{skin_id}.json").read_text(encoding="utf-8"))
    anchors = {**DEFAULT_ANCHORS, **{k: tuple(v) for k, v in (skin.get("anchors") or {}).items()}}
    items = pack["accessories"]
    by_id = {a["id"]: a for a in items}

    tiles = [(a["id"], [a]) for a in items]
    tiles += [(f"~{s}", [by_id[i] for i in o.values()]) for s, o in SEASON_OUTFITS.items() if all(i in by_id for i in o.values())]
    for s in pack.get("skins", []):
        tiles.append((f"skin:{s['id']}", []))

    scale, cols = 6, 6
    cell_w, cell_h = W * scale, H * scale + 14
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell_w, rows * cell_h), (12, 23, 25, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, worn) in enumerate(tiles):
        base = skin
        if label.startswith("skin:"):
            base = {**skin, **next(s for s in pack["skins"] if s["id"] == label[5:])}
        tile = wear(base, worn, anchors).resize((W * scale, H * scale), Image.NEAREST)
        x, y = (i % cols) * cell_w, (i // cols) * cell_h
        sheet.alpha_composite(tile, (x, y))
        draw.text((x + 6, y + H * scale), label, fill=(243, 230, 204, 255))
    sheet.save(out)
    print(f"wrote {out} ({len(tiles)} tiles)")


if __name__ == "__main__":
    main()
