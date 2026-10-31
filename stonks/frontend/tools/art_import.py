"""Turn generated PNGs into the site's artwork slots.

Usage: python tools/art_import.py <folder with PNGs>

Each <slot>.png in the folder becomes src/assets/art/<slot>.webp, resized for how the page uses it.
File names are the slot names from ART.md. Pictures with transparency keep it. Needs Pillow.
"""
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'src' / 'assets' / 'art'

# Longest side in pixels, by slot prefix. The site never shows a picture larger than this.
SIZES = {'hero-': 2048, 'login-': 1600, 'banner-': 1200, 'cover-': 1200, 'modal-': 1000, 'footer-': 2048, 'cat-': 640, 'verdict-': 480, 'empty-': 640, 'spot-plan': 1000, 'spot-': 320, 'coin-': 128, 'brand-': 128}


def main(folder: str) -> None:
    for png in sorted(Path(folder).glob('*.png')):
        side = next((s for prefix, s in SIZES.items() if png.stem.startswith(prefix)), None)
        if side is None:
            print(f'skipped {png.name}: not a known slot')
            continue
        im = Image.open(png)
        im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB')
        im.thumbnail((side, side), Image.LANCZOS)
        target = OUT / f'{png.stem}.webp'
        im.save(target, quality=84, method=6)
        print(f'{target.name}: {im.width}x{im.height}, {target.stat().st_size // 1024} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
