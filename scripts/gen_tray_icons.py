"""Generate Phase 2a tray icons (32x32) for the four recorder states.

Run from repo root:
    python scripts/gen_tray_icons.py

Outputs to frontend/src-tauri/icons/tray/.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = "frontend/src-tauri/icons/tray"
os.makedirs(OUT_DIR, exist_ok=True)

states = {
    "idle":       ("#FF6B35", None),       # orange
    "potential":  ("#3B82F6", "ring"),     # blue with ring
    "recording":  ("#DC2626", "dot"),      # red with dot
    "finalizing": ("#6B7280", None),       # gray
}

for name, (color, marker) in states.items():
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((2, 2, 30, 30), radius=6, fill=color)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
    draw.text((6, 7), "NR", fill="white", font=font)
    if marker == "dot":
        draw.ellipse((22, 4, 28, 10), fill="white")
    elif marker == "ring":
        draw.ellipse((1, 1, 31, 31), outline="white", width=1)
    img.save(os.path.join(OUT_DIR, f"tray-{name}.png"))

print(f"Tray icons generated in {OUT_DIR}")
