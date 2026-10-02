"""Contact sheet for every built-in pack in src/wardrobe/, worn by the crab.

Usage:  python scripts/preview-packs.py [out-dir] [--skin classic]

Writes <out-dir>/<pack-id>.png per pack and <out-dir>/all-packs.png with the lot
stacked, so you can eyeball new art the way it will actually look on the desktop.
Defaults to docs/packs/. Reuses the anchor + pivot maths in preview-wardrobe.py.
"""
import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def load_preview_module():
    """Import preview-wardrobe.py, whose name is not a valid module name."""
    spec = importlib.util.spec_from_file_location("preview_wardrobe", ROOT / "scripts" / "preview-wardrobe.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sheet(pw, pack, skin, scale=6, cols=6):
    anchors = {**pw.DEFAULT_ANCHORS}
    tiles = [(a["id"], [a], skin) for a in pack.get("accessories") or []]
    for s in pack.get("skins") or []:
        merged = {**skin, **s}
        # A reshaped skin can move the anchors its accessories hang off.
        tiles.append((f"skin:{s['id']}", [], merged))

    cell_w, cell_h = pw.W * scale, pw.H * scale + 14
    rows = max(1, (len(tiles) + cols - 1) // cols)
    img = Image.new("RGBA", (cols * cell_w, rows * cell_h), (12, 23, 25, 255))
    draw = ImageDraw.Draw(img)
    for i, (label, worn, base) in enumerate(tiles):
        a = {**anchors, **{k: tuple(v) for k, v in (base.get("anchors") or {}).items()}}
        tile = pw.wear(base, worn, a).resize((cell_w, pw.H * scale), Image.NEAREST)
        x, y = (i % cols) * cell_w, (i // cols) * cell_h
        img.alpha_composite(tile, (x, y))
        draw.text((x + 6, y + pw.H * scale), label, fill=(243, 230, 204, 255))
    return img, len(tiles)


def main():
    pw = load_preview_module()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = Path(args[0]) if args else ROOT / "docs" / "packs"
    skin_id = sys.argv[sys.argv.index("--skin") + 1] if "--skin" in sys.argv else "classic"
    skin = json.loads((ROOT / "src" / "skins" / f"{skin_id}.json").read_text(encoding="utf-8"))

    out_dir.mkdir(parents=True, exist_ok=True)
    sheets = []
    for f in sorted((ROOT / "src" / "wardrobe").glob("*.json")):
        pack = json.loads(f.read_text(encoding="utf-8"))
        img, n = sheet(pw, pack, skin)
        dest = out_dir / f"{pack['id']}.png"
        img.save(dest)
        sheets.append(img)
        print(f"{pack['id']:16} {n:3} tiles -> {dest}")

    if sheets:
        w = max(i.width for i in sheets)
        combined = Image.new("RGBA", (w, sum(i.height for i in sheets)), (12, 23, 25, 255))
        y = 0
        for i in sheets:
            combined.alpha_composite(i, (0, y))
            y += i.height
        combined.save(out_dir / "all-packs.png")
        print(f"combined -> {out_dir / 'all-packs.png'}")


if __name__ == "__main__":
    main()
