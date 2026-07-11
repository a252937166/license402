#!/usr/bin/env python3
"""
Generate the full first-party catalog: 7 art pieces (1024px) + watermarked
low-res previews (640px, darkened + diagonal stripes baked in for payment
isolation). Deterministic. Run before seed-catalog.ts.

Usage: python3 scripts/gen_catalog.py
"""
import os
from PIL import Image, ImageDraw
from gen_art import generate

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "catalog", "assets")
PREVIEWS = os.path.join(ROOT, "catalog", "previews")

# slug, seed, palette
SPECS = [
    ("cyber-dragon", 7, "dragon"),
    ("neon-city", 13, "city"),
    ("synth-portal", 21, "portal"),
    ("aurora-koi", 34, "koi"),
    ("glitch-mask", 55, "glitch"),
    ("expired-relic", 89, "relic"),
    ("editorial-only", 144, "editorial"),
]


def watermark(img, size=768):
    # Preview is a downscaled, very lightly marked copy — enough to signal
    # "not licensed" without destroying the art (heavy stripes read as cheap).
    p = img.resize((size, size), Image.LANCZOS)
    p = Image.eval(p, lambda x: int(x * 0.9))
    draw = ImageDraw.Draw(p, "RGBA")
    step = 84
    for i in range(-size, size * 2, step):
        draw.line([(i, 0), (i - size, size)], fill=(235, 238, 246, 12), width=1)
    return p


def main():
    os.makedirs(ASSETS, exist_ok=True)
    os.makedirs(PREVIEWS, exist_ok=True)
    for slug, seed, palette in SPECS:
        art = generate(seed, palette)
        art.save(os.path.join(ASSETS, f"{slug}.png"))
        watermark(art).save(os.path.join(PREVIEWS, f"{slug}.preview.png"))
        print(f"  {slug:16s} palette={palette}")
    print(f"generated {len(SPECS)} assets + previews")


if __name__ == "__main__":
    main()
