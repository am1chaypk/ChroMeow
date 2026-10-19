"""Dev tool: renders public/icons/*.png from the procedural cat.

Usage (from the repo root, with esbuild and Playwright for Python available):
    npx esbuild scripts/render-icons.ts --bundle --format=iife --outfile=scripts/.icons.js
    python3 scripts/render-icons.py
"""
import base64
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "scripts" / ".icons.js"
OUT = ROOT / "public" / "icons"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    html = f"<!doctype html><html><body><script>{BUNDLE.read_text()}</script></body></html>"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content(html)
        page.wait_for_function("!!window.__icons", timeout=10000)
        icons = page.evaluate("window.__icons")
        browser.close()
    for key, data_url in icons.items():
        name = "icon-preview.png" if key == "preview" else f"icon{key}.png"
        target = (ROOT / "scripts" / name) if key == "preview" else (OUT / name)
        target.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
        print("wrote", target.relative_to(ROOT))


if __name__ == "__main__":
    main()
