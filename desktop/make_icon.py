#!/usr/bin/env python3
"""
Generate desktop/AppIcon.icns for the Fitness Tracker app: a white dumbbell on a
blue->purple gradient squircle (matches the app's #60a5fa -> #a78bfa palette).

Run:  desktop/.venv/bin/python3 desktop/make_icon.py
Needs Pillow (build-time only):  pip install Pillow
Then rebuild the app:  bash desktop/build_app.sh
"""
import pathlib
import subprocess
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
SS = 4                      # supersample for crisp antialiasing
W = 1024 * SS
RADIUS = int(0.2237 * W)    # Apple "continuous corner" approximation
C_TOP = (96, 165, 250)      # #60a5fa
C_BOT = (167, 139, 250)     # #a78bfa
WHITE = (255, 255, 255, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, c0, c1):
    g = Image.linear_gradient("L").resize((size, size))     # 0 (top) -> 255 (bottom)
    return Image.composite(Image.new("RGB", (size, size), c1),
                           Image.new("RGB", (size, size), c0), g)


def rrect(draw, cx, cy, w, h, r, fill):
    draw.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=r, fill=fill)


def make_master():
    base = gradient(W, C_TOP, C_BOT).convert("RGBA")

    # soft top-left sheen
    hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([-W * 0.30, -W * 0.45, W * 0.75, W * 0.55], fill=(255, 255, 255, 36))
    base = Image.alpha_composite(base, hl)

    # dumbbell on its own layer so we can rotate it for a bit of energy
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = cy = W / 2
    barlen = W * 0.34
    barth = W * 0.075
    rrect(d, cx, cy, barlen, barth, barth / 2, WHITE)                       # central bar
    for s in (-1, 1):
        rrect(d, cx + s * (barlen / 2 + W * 0.045), cy, W * 0.072, W * 0.30, W * 0.030, WHITE)  # inner plate
        rrect(d, cx + s * (barlen / 2 + W * 0.118), cy, W * 0.060, W * 0.20, W * 0.026, WHITE)  # outer plate
        rrect(d, cx + s * (barlen / 2 + W * 0.160), cy, W * 0.036, W * 0.10, W * 0.018, WHITE)  # end knob
    layer = layer.rotate(-25, resample=Image.BICUBIC, center=(cx, cy))
    base = Image.alpha_composite(base, layer)

    base.putalpha(rounded_mask(W, RADIUS))                  # clip to the squircle
    return base.resize((1024, 1024), Image.LANCZOS)


def build_icns(master):
    iconset = HERE / "AppIcon.iconset"
    iconset.mkdir(exist_ok=True)
    for s in (16, 32, 128, 256, 512):
        master.resize((s, s), Image.LANCZOS).save(iconset / f"icon_{s}x{s}.png")
        master.resize((s * 2, s * 2), Image.LANCZOS).save(iconset / f"icon_{s}x{s}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", "-o", str(HERE / "AppIcon.icns"), str(iconset)], check=True)
    # also keep a PNG preview
    master.save(HERE / "AppIcon.png")
    print(f"Wrote {HERE / 'AppIcon.icns'} and {HERE / 'AppIcon.png'}")


if __name__ == "__main__":
    build_icns(make_master())
