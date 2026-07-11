#!/usr/bin/env python3
"""
First-party generative art for the LICENSE402 catalog. Domain-warped fractal
noise (fbm) through curated cyberpunk/synthwave palettes + grain + vignette +
bloom. Deterministic per seed. No external models — this is our original work,
which is exactly what a first-party signed catalog should be.

Usage: python3 scripts/gen_art.py <slug> <seed> <palette> <out.png> [size]
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SIZE = 1024

# Curated dark, refined palettes: list of (stop, (r,g,b)). Stops in [0,1].
PALETTES = {
    "dragon": [(0.0,(9,6,20)),(0.35,(74,14,86)),(0.6,(196,32,110)),(0.8,(240,86,72)),(1.0,(255,214,150))],
    "city":   [(0.0,(6,10,24)),(0.4,(14,60,90)),(0.65,(28,150,170)),(0.85,(90,220,225)),(1.0,(235,250,255))],
    "portal": [(0.0,(8,4,16)),(0.3,(40,18,84)),(0.58,(150,36,150)),(0.8,(232,86,40)),(1.0,(255,196,96))],
    "koi":    [(0.0,(5,16,18)),(0.4,(16,80,64)),(0.64,(30,170,150)),(0.84,(120,230,200)),(1.0,(224,255,240))],
    "glitch": [(0.0,(12,12,18)),(0.4,(30,52,120)),(0.62,(96,80,210)),(0.82,(150,170,235)),(1.0,(232,236,246))],
    "relic":  [(0.0,(16,13,9)),(0.45,(58,44,28)),(0.7,(120,92,52)),(0.88,(176,150,104)),(1.0,(222,206,168))],
    "editorial":[(0.0,(12,14,18)),(0.45,(40,50,66)),(0.72,(96,112,138)),(0.9,(158,176,198)),(1.0,(226,234,244))],
}


def _rng(seed):
    return np.random.default_rng(seed)


def value_noise(h, w, cells, rng):
    """Smooth value noise: random coarse grid bilinearly upsampled to (h,w)."""
    g = rng.random((cells + 1, cells + 1)).astype(np.float32)
    img = Image.fromarray((g * 255).astype(np.uint8), "L").resize((w, h), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def fbm(h, w, rng, octaves=5, base=3, gain=0.55, lac=2.0):
    out = np.zeros((h, w), np.float32)
    amp, tot, cells = 1.0, 0.0, base
    for _ in range(octaves):
        out += amp * value_noise(h, w, int(cells), rng)
        tot += amp
        amp *= gain
        cells *= lac
    return out / tot


def domain_warp(h, w, seed):
    rng = _rng(seed)
    base = fbm(h, w, rng, octaves=6, base=3)
    wx = fbm(h, w, _rng(seed + 101), octaves=5, base=4) - 0.5
    wy = fbm(h, w, _rng(seed + 202), octaves=5, base=4) - 0.5
    wx2 = fbm(h, w, _rng(seed + 303), octaves=4, base=6) - 0.5
    wy2 = fbm(h, w, _rng(seed + 404), octaves=4, base=6) - 0.5
    ys, xs = np.mgrid[0:h, 0:w]
    amp1, amp2 = w * 0.28, w * 0.10
    xi = np.clip(xs + amp1 * wx + amp2 * wx2, 0, w - 1).astype(np.int32)
    yi = np.clip(ys + amp1 * wy + amp2 * wy2, 0, h - 1).astype(np.int32)
    warped = base[yi, xi]
    # a second warp pass for that painterly, folded look
    v2 = fbm(h, w, _rng(seed + 505), octaves=5, base=3)
    field = 0.6 * warped + 0.4 * v2[yi, xi]
    # normalize
    field = (field - field.min()) / (np.ptp(field) + 1e-6)
    return field


def ramp(field, stops):
    xs = np.array([s[0] for s in stops], np.float32)
    cols = np.array([s[1] for s in stops], np.float32)
    out = np.empty(field.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(field, xs, cols[:, c])
    return out


def radial_gradient(h, w, cx=0.5, cy=0.42, power=1.5):
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (xs / w - cx)
    dy = (ys / h - cy)
    r = np.sqrt(dx * dx + dy * dy) / 0.72
    return np.clip(1 - r, 0, 1) ** power


def generate(seed, palette):
    h = w = SIZE
    field = domain_warp(h, w, seed)
    glow = radial_gradient(h, w)
    # push contrast where the light is; keep shadows deep
    lit = np.clip(field * (0.55 + 0.85 * glow), 0, 1)
    lit = lit ** 0.92
    rgb = ramp(lit, PALETTES[palette])

    # bloom: blend a blurred bright pass for that expensive glow
    bright = np.clip((lit[..., None] - 0.6) * 2.4, 0, 1) * rgb
    bloom = np.asarray(
        Image.fromarray(bright.astype(np.uint8)).filter(ImageFilter.GaussianBlur(14)),
        np.float32,
    )
    rgb = np.clip(rgb + 0.5 * bloom, 0, 255)

    # fine film grain
    grain = _rng(seed + 999).normal(0, 5.0, (h, w, 1)).astype(np.float32)
    rgb = np.clip(rgb + grain, 0, 255)

    # vignette
    vig = 0.35 + 0.65 * radial_gradient(h, w, 0.5, 0.5, 1.1)[..., None]
    rgb = np.clip(rgb * (0.6 + 0.4 * vig), 0, 255)

    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def main():
    seed = int(sys.argv[2])
    palette = sys.argv[3]
    out = sys.argv[4]
    generate(seed, palette).save(out)
    print(out)


if __name__ == "__main__":
    main()
