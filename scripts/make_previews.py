#!/usr/bin/env python3
"""
Build watermarked, downscaled previews from the first-party catalog art in
catalog/assets/*.png (aspect ratio preserved). Run after dropping in new art
and before seed-catalog.ts.

Usage: python3 scripts/make_previews.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "catalog", "assets")
PREVIEWS = os.path.join(ROOT, "catalog", "previews")


def watermark(img, target_w=1000):
    w, h = img.size
    p = img.convert("RGB").resize((target_w, round(h * target_w / w)), Image.LANCZOS)
    p = Image.eval(p, lambda x: int(x * 0.92))
    draw = ImageDraw.Draw(p, "RGBA")
    W, H = p.size
    step = 86
    for i in range(-H, W + H, step):
        draw.line([(i, 0), (i - H, H)], fill=(235, 238, 246, 11), width=1)
    return p


def main():
    os.makedirs(PREVIEWS, exist_ok=True)
    n = 0
    for name in sorted(os.listdir(ASSETS)):
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        slug = os.path.splitext(name)[0]
        img = Image.open(os.path.join(ASSETS, name))
        watermark(img).save(os.path.join(PREVIEWS, f"{slug}.preview.png"))
        print(f"  {slug}  ({img.size[0]}x{img.size[1]})")
        n += 1
    print(f"built {n} previews")


if __name__ == "__main__":
    main()
