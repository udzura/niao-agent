#!/usr/bin/env python3
"""Reuse Niao's original bird with an opaque, full-bleed iOS background."""
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root.parent / "macos/Artwork/Niao.svg").read_text()
source = re.sub(r'  <rect[^>]+/>\n', '', source)
source = source.replace('  <path', '  <rect width="1024" height="1024" fill="#BE6346"/>\n  <path', 1)
subprocess.run(["magick", "-background", "#BE6346", "svg:-", "-alpha", "off",
                str(root / "Assets.xcassets/AppIcon.appiconset/Niao.png")],
               input=source.encode(), check=True)
