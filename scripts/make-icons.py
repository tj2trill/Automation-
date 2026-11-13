"""Draw the dashboard's app icons: four survival-tier bars rising on an ink field.

Run: python3 scripts/make-icons.py   (needs Pillow). Output is committed, so
this only needs re-running when the icon changes.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "host" / "dashboard"
INK = (23, 35, 30)
BARS = [(179, 38, 62), (198, 132, 28), (38, 148, 110), (36, 128, 184)]  # critical, low, normal, high
HEIGHTS = [0.22, 0.38, 0.58, 0.80]

def draw(size: int) -> Image.Image:
    scale = 4  # supersample, then downscale for clean edges
    s = size * scale
    img = Image.new("RGB", (s, s), INK)
    d = ImageDraw.Draw(img)
    # Keep the drawing inside the central 60% so maskable crops never clip it.
    left, right, bottom, top = 0.22 * s, 0.78 * s, 0.74 * s, 0.24 * s
    gap = 0.035 * s
    width = (right - left - gap * 3) / 4
    for i, (color, h) in enumerate(zip(BARS, HEIGHTS)):
        x0 = left + i * (width + gap)
        y0 = bottom - (bottom - top) * h
        d.rectangle([x0, y0, x0 + width, bottom], fill=color)
    # Baseline: the zero-balance line every bar stands on.
    d.rectangle([left - 0.03 * s, bottom + 0.025 * s, right + 0.03 * s, bottom + 0.05 * s], fill=(238, 241, 236))
    return img.resize((size, size), Image.LANCZOS)

for size in (180, 192, 512):
    draw(size).save(OUT / f"icon-{size}.png", optimize=True)
    print(f"wrote icon-{size}.png")
