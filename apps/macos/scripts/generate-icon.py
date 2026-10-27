#!/usr/bin/env python3
"""Render the original SVG into macOS app icon sizes (requires ImageMagick)."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
catalog = root / "Niao/Assets.xcassets"
target = catalog / "AppIcon.appiconset"
target.mkdir(parents=True, exist_ok=True)
images = []
for size in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        pixels = size * scale
        name = f"icon_{size}x{size}@{scale}x.png"
        subprocess.run(["magick", "-background", "none", str(root / "Artwork/Niao.svg"),
                        "-resize", f"{pixels}x{pixels}", str(target / name)], check=True)
        images.append({"filename": name, "idiom": "mac", "size": f"{size}x{size}", "scale": f"{scale}x"})
info = {"author": "xcode", "version": 1}
(target / "Contents.json").write_text(json.dumps({"images": images, "info": info}, indent=2) + "\n")
(catalog / "Contents.json").write_text(json.dumps({"info": info}, indent=2) + "\n")
