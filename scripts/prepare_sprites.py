#!/usr/bin/env python3
"""Bake the AI creature art down to web-sized WebP sprites.

Reads the untouched masters in docs/art_image/sprites/ and writes
aquarium/public/sprites/. Re-runnable: it only ever reads the masters.

The masters live one level above this repository and are not published; the
baked sprites in public/sprites/ are the shipped assets, so a clone does not
need to run this. It is kept here to document how they were produced.

  python3 aquarium/scripts/prepare_sprites.py [--debug]

Steps per sprite
  1. trim the transparent margin (alpha bbox)
  2. resize to the target width — roughly 2x the largest on-screen size
  3. the small fish are letterboxed onto one shared aspect ratio so
     sprites.js can describe them with a single box + hull
  4. whale_blue is derived from whale_gold: the gold/amber glow is hue-rotated
     to cyan with a feathered mask, the blue body is left alone
  5. WebP, quality 90, alpha preserved

--debug additionally writes scripts/_debug/<name>.png: the sprite on a
deep-sea background with a tenths grid and the proposed hull ellipse drawn on
top plus a dot on the mouth, which is how the hull/mouth numbers in
sprites.js were measured.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / 'docs' / 'art_image' / 'sprites'
OUT = ROOT / 'public' / 'sprites'
DEBUG_OUT = ROOT / 'scripts' / '_debug'   # scratch, gitignored

TRIM_ALPHA = 4        # anything fainter than this is empty margin
WEBP_QUALITY = 90


def pick(*names: str) -> str:
    """First master that exists, preferring the correctly spelled name.

    The art masters are kept exactly as the artist saved them, and a couple of
    those names are off: 'dolphine.png' is a misspelling of dolphin, and
    'kurage.png' is Japanese for jellyfish. Accepting either spelling means the
    masters can be renamed later without touching this script.
    """
    for name in names:
        if (SRC / name).exists():
            return name
    return names[0]   # nothing found — fail later on the canonical name


# name -> (master file, target width px)
#
# Each species is painted in several colourways: the body is the same navy
# animal throughout, only the bioluminescence differs, so every colourway of a
# species bakes at that species' width and shares its box in sprites.js.
PLAIN = [
    ('shark',           'shark.png',                          620),
    ('shark_mint',      'shark_mint.png',                     620),
    ('shark_magenta',   'shark_magenta.png',                  620),
    ('dolphin',         pick('dolphin.png', 'dolphine.png'),  480),
    ('dolphin_mint',    'dolphin_mint.png',                   480),
    ('dolphin_rose',    'dolphin_rose.png',                   480),
    ('jelly',           pick('jelly.png', 'kurage.png'),      240),
]

# the small fish share one box: scaled to fit, centred, padded to FISH_ASPECT.
# Their masters are not all the same shape — fish_pearl is a 3:2 canvas where
# the rest are square — so the letterbox is what makes one hull fit them all.
FISH = [
    ('fish_cyan',     'fish_1.png'),
    ('fish_lavender', 'Fish_2.png'),
    ('fish_pink',     'Fish_3.png'),
    ('fish_mint',     'fish_mint.png'),
    ('fish_pearl',    'fish_pearl.png'),
]
FISH_W = 260
FISH_ASPECT = 1.28

WHALE_SRC = 'whale_2.png'
WHALE_W = 800

# --- gold -> cyan --------------------------------------------------------
# The art's glow sits at hue ~40-50 deg; the whale's own body is 209-226 deg
# and its cheek is ~330 deg, so a window over the warm end touches only the
# glow. Both edges are feathered (smoothstep) so no hard seam appears where
# the halo fades into the body or into the transparent background.
HUE_IN, HUE_FULL_LO, HUE_FULL_HI, HUE_OUT = 8.0, 30.0, 66.0, 88.0
SAT_IN, SAT_FULL = 6.0, 38.0         # near-neutral pixels barely move either way,
                                     # so the floor is low enough to sweep up the
                                     # faint warm grain at the outer halo edge
HUE_SHIFT_DEG = 151.0                # 42 deg gold -> 193 deg (#4FD8FF)


def smoothstep(t: float) -> float:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def _hue_weight(i: int) -> int:
    deg = i * 360.0 / 256.0
    if deg <= HUE_IN or deg >= HUE_OUT:
        w = 0.0
    elif deg < HUE_FULL_LO:
        w = smoothstep((deg - HUE_IN) / (HUE_FULL_LO - HUE_IN))
    elif deg <= HUE_FULL_HI:
        w = 1.0
    else:
        w = smoothstep((HUE_OUT - deg) / (HUE_OUT - HUE_FULL_HI))
    return int(round(w * 255))


def _sat_weight(i: int) -> int:
    return int(round(smoothstep((i - SAT_IN) / (SAT_FULL - SAT_IN)) * 255))


def gold_to_cyan(img: Image.Image) -> Image.Image:
    """Hue-rotate only the warm glow of an RGBA sprite."""
    alpha = img.getchannel('A')
    rgb = img.convert('RGB')
    h, s, v = rgb.convert('HSV').split()

    mask = ImageChops.multiply(h.point(_hue_weight), s.point(_sat_weight))

    shift = int(round(HUE_SHIFT_DEG * 256.0 / 360.0))
    rotated = Image.merge('HSV', (h.point(lambda i: (i + shift) % 256), s, v)).convert('RGB')

    out = Image.composite(rotated, rgb, mask)
    out.putalpha(alpha)
    return out


# --- pipeline ------------------------------------------------------------

def load_trimmed(name: str) -> Image.Image:
    img = Image.open(SRC / name).convert('RGBA')
    box = img.getchannel('A').point(lambda v: 255 if v > TRIM_ALPHA else 0).getbbox()
    return img.crop(box) if box else img


def fit_width(img: Image.Image, width: int) -> Image.Image:
    if img.width <= width:
        return img
    h = max(1, round(img.height * width / img.width))
    return img.resize((width, h), Image.LANCZOS)


def letterbox(img: Image.Image, width: int, aspect: float) -> Image.Image:
    """Scale to fit inside width x width/aspect, centred on a clear canvas."""
    height = round(width / aspect)
    scale = min(width / img.width, height / img.height)
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    canvas.paste(img.resize((w, h), Image.LANCZOS), ((width - w) // 2, (height - h) // 2))
    return canvas


def save(img: Image.Image, name: str) -> None:
    path = OUT / f'{name}.webp'
    img.save(path, 'WEBP', quality=WEBP_QUALITY, method=6, exact=True)
    kb = path.stat().st_size / 1024
    flag = '  <-- over 250KB' if kb > 250 else ''
    print(f'  {path.name:22s} {img.width:4d}x{img.height:<4d} aspect {img.width / img.height:5.3f}  {kb:6.1f} KB{flag}')


# --- debug overlay -------------------------------------------------------
# The hull ellipse (cx, cy, rx, ry) and the mouth (x, y), as fractions of the
# sprite box. These MUST stay in step with SPECIES in src/sprites.js — this is
# the overlay the numbers there were read off, so a drifting copy would send
# the next measurement to the wrong place.
#
# One entry per species, shared by all of its colourways: the colourways are
# repaints of the same pose, and after the trim their aspect ratios agree to
# well under a percent, so a single hull covers every one of them.
SPECIES_BOX = {
    'whale':   {'hull': (0.40, 0.57, 0.36, 0.29), 'mouth': (0.09, 0.51)},
    'shark':   {'hull': (0.42, 0.51, 0.39, 0.22), 'mouth': (0.05, 0.62)},
    'dolphin': {'hull': (0.47, 0.47, 0.33, 0.33), 'mouth': (0.05, 0.46)},
    'fish':    {'hull': (0.38, 0.51, 0.33, 0.35), 'mouth': (0.06, 0.54)},
}


# Mirrors TILT in src/sprites.js: the dolphin master is a mid-leap pose that
# the page levels off with a CSS rotate on the <img>. The rotation spins the
# art inside an unchanged box, so the hull and mouth fractions describe the
# *rotated* dolphin — and the overlay has to rotate it too, or the numbers it
# is meant to verify land in open water.
TILT = {'dolphin': -22}


def species_of(name: str) -> str:
    """'shark_magenta' -> 'shark', 'whale_gold' -> 'whale', 'fish_pearl' -> 'fish'."""
    return name.split('_')[0]


HULLS = {}
MOUTHS = {}
for _sprite in ['whale_gold', 'whale_blue', *(n for n, *_ in PLAIN), *(n for n, _ in FISH)]:
    _box = SPECIES_BOX.get(species_of(_sprite))
    if _box:
        HULLS[_sprite] = _box['hull']
        MOUTHS[_sprite] = _box['mouth']

DEBUG_MIN_W = 620


def debug_sheet(img: Image.Image, name: str) -> None:
    if img.width < DEBUG_MIN_W:
        img = img.resize((DEBUG_MIN_W, round(img.height * DEBUG_MIN_W / img.width)), Image.LANCZOS)
    tilt = TILT.get(species_of(name))
    if tilt:
        # CSS rotates clockwise for positive angles, PIL counter-clockwise
        img = img.rotate(-tilt, resample=Image.BICUBIC, center=(img.width / 2, img.height / 2))
    bg = Image.new('RGBA', img.size, (10, 26, 51, 255))
    bg.alpha_composite(img)
    d = ImageDraw.Draw(bg)
    w, h = img.size
    for i in range(1, 10):
        x, y = w * i / 10, h * i / 10
        col = (255, 255, 255, 90) if i != 5 else (255, 209, 102, 150)
        d.line([(x, 0), (x, h)], fill=col)
        d.line([(0, y), (w, y)], fill=col)
        d.text((x + 2, 2), f'.{i}', fill=(255, 255, 255, 180))
        d.text((2, y + 2), f'.{i}', fill=(255, 255, 255, 180))
    hull = HULLS.get(name)
    if hull:
        cx, cy, rx, ry = hull
        d.ellipse([(w * (cx - rx), h * (cy - ry)), (w * (cx + rx), h * (cy + ry))],
                  outline=(255, 100, 160, 255), width=4)
    mouth = MOUTHS.get(name)
    if mouth:
        mx, my = w * mouth[0], h * mouth[1]
        d.ellipse([(mx - 7, my - 7), (mx + 7, my + 7)], fill=(255, 209, 102, 255))
    DEBUG_OUT.mkdir(parents=True, exist_ok=True)
    bg.convert('RGB').save(DEBUG_OUT / f'{name}.png')


def main() -> None:
    debug = '--debug' in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    print(f'sprites -> {OUT}')

    made = {}

    whale = fit_width(load_trimmed(WHALE_SRC), WHALE_W)
    made['whale_gold'] = whale
    made['whale_blue'] = gold_to_cyan(whale)

    for name, src, width in PLAIN:
        made[name] = fit_width(load_trimmed(src), width)

    for name, src in FISH:
        made[name] = letterbox(load_trimmed(src), FISH_W, FISH_ASPECT)

    for name, img in made.items():
        save(img, name)
        if debug:
            debug_sheet(img, name)


if __name__ == '__main__':
    main()
