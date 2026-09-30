"""Render a skin's pixel grid to the app icons (assets/icon.png, assets/icon.ico).

Usage:  python scripts/make-icons.py [skin-id] [--preview out.png]
Requires Pillow (pip install pillow).
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def render(skin, size, pad_ratio=0.1):
    rows = skin["pixels"]
    w, h = max(len(r) for r in rows), len(rows)
    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            color = skin["palette"].get(ch)
            if color:
                grid.putpixel((x, y), tuple(int(color[i:i + 2], 16) for i in (1, 3, 5)) + (255,))
    inner = int(size * (1 - 2 * pad_ratio))
    scale = max(1, inner // max(w, h))
    sprite = grid.resize((w * scale, h * scale), Image.NEAREST)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(sprite, ((size - sprite.width) // 2, (size - sprite.height) // 2))
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    skin_id = args[0] if args else "classic"
    skin = json.loads((ROOT / "src" / "skins" / f"{skin_id}.json").read_text(encoding="utf-8"))

    if "--preview" in sys.argv:
        dest = Path(sys.argv[sys.argv.index("--preview") + 1])
        render(skin, 320, 0.05).save(dest)
        print(f"preview -> {dest}")
        return

    assets = ROOT / "assets"
    render(skin, 512).save(assets / "icon.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(skin, s, 0.04 if s <= 32 else 0.08) for s in sizes]
    frames[-1].save(assets / "icon.ico", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    render(skin, 32, 0.04).save(assets / "tray.png")
    print("wrote assets/icon.png, assets/icon.ico, assets/tray.png")


if __name__ == "__main__":
    main()
