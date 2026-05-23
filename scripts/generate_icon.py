"""One-shot script to generate the CopyThat app icon (vintage spirit duplicator)
and write the various Expo asset PNGs. Run with:  python scripts/generate_icon.py
"""
import asyncio
import base64
import os
import sys
from pathlib import Path
from io import BytesIO

from PIL import Image
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / "backend" / ".env")

from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "assets" / "images"
OUT.mkdir(parents=True, exist_ok=True)

PROMPT = (
    "App icon, 1024x1024, square, flat vector illustration of a vintage spirit "
    "duplicator (ditto/Banda machine) from the 1950s: cast-iron cylindrical drum "
    "with a hand crank on the right, ink-stained purple/violet paper sheet "
    "rolling out of the front, deep purple ink puddle, art-deco industrial look, "
    "thick clean outlines, soft cream off-white background with very subtle "
    "paper-texture grain, no text, no letters, no logos, centered composition, "
    "iOS app icon style, generous safe-area margin, NO drop shadow background, "
    "rich plum #4B0082 + warm cream #F4E9D8 + soft teal #2E6E6A accents."
)


async def main():
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        print("EMERGENT_LLM_KEY missing")
        sys.exit(1)

    chat = LlmChat(
        api_key=api_key,
        session_id="copythat-icon",
        system_message="You are an expert vector illustrator.",
    ).with_model("gemini", "gemini-3.1-flash-image-preview").with_params(
        modalities=["image", "text"]
    )

    print("Generating master icon...")
    text, images = await chat.send_message_multimodal_response(UserMessage(text=PROMPT))
    if not images:
        print("No image returned. text=", text[:200])
        sys.exit(2)

    raw = base64.b64decode(images[0]["data"])
    master_path = OUT / "icon-source.png"
    master_path.write_bytes(raw)
    print(f"Saved master -> {master_path}")

    # Re-encode + resize variants
    src = Image.open(BytesIO(raw)).convert("RGB")
    # Ensure square 1024
    w, h = src.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    src = src.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.LANCZOS)

    src.save(OUT / "icon.png", "PNG")
    src.save(OUT / "adaptive-icon.png", "PNG")

    # Splash: same icon but inset on cream background
    cream = (244, 233, 216)
    splash = Image.new("RGB", (1024, 1024), cream)
    inset = src.resize((640, 640), Image.LANCZOS)
    splash.paste(inset, ((1024 - 640) // 2, (1024 - 640) // 2))
    splash.save(OUT / "splash-icon.png", "PNG")

    # Favicon 48x48
    src.resize((48, 48), Image.LANCZOS).save(OUT / "favicon.png", "PNG")

    print("Wrote:", ", ".join(p.name for p in OUT.glob("*.png")))


if __name__ == "__main__":
    asyncio.run(main())
