#!/usr/bin/env python3
"""
Build web media from the first-party catalog art in catalog/assets/*.png
(aspect ratio preserved). Two renditions per asset:

  catalog/previews/<slug>.preview.webp  — watermarked, 1000px, shown pre-purchase
  catalog/display/<slug>.display.webp   — clean, 1400px, shown post-purchase

The ORIGINAL PNG in catalog/assets/ is the licensed deliverable — its sha256 is
signed into the CreatorOffer and it is only served by the download link. These
webp renditions exist purely so the site loads fast; they are never hashed.

Usage: python3 scripts/make_media.py   (then: tsx scripts/seed-catalog.ts)
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "catalog", "assets")
PREVIEWS = os.path.join(ROOT, "catalog", "previews")
DISPLAY = os.path.join(ROOT, "catalog", "display")


def scaled(img, target_w):
    w, h = img.size
    if w <= target_w:
        return img.convert("RGB")
    return img.convert("RGB").resize((target_w, round(h * target_w / w)), Image.LANCZOS)


def watermark(img, target_w=1000):
    p = scaled(img, target_w)
    p = Image.eval(p, lambda x: int(x * 0.92))
    draw = ImageDraw.Draw(p, "RGBA")
    W, H = p.size
    step = 86
    for i in range(-H, W + H, step):
        draw.line([(i, 0), (i - H, H)], fill=(235, 238, 246, 11), width=1)
    return p


def main():
    os.makedirs(PREVIEWS, exist_ok=True)
    os.makedirs(DISPLAY, exist_ok=True)
    n = 0
    for name in sorted(os.listdir(ASSETS)):
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        slug = os.path.splitext(name)[0]
        img = Image.open(os.path.join(ASSETS, name))
        watermark(img).save(os.path.join(PREVIEWS, f"{slug}.preview.webp"), quality=78, method=6)
        scaled(img, 1400).save(os.path.join(DISPLAY, f"{slug}.display.webp"), quality=82, method=6)
        pv = os.path.getsize(os.path.join(PREVIEWS, f"{slug}.preview.webp")) // 1024
        dp = os.path.getsize(os.path.join(DISPLAY, f"{slug}.display.webp")) // 1024
        print(f"  {slug}  ({img.size[0]}x{img.size[1]})  preview {pv}KB · display {dp}KB")
        n += 1
    print(f"built {n} preview+display pairs")


if __name__ == "__main__":
    main()
