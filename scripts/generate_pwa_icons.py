from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icons"
ICON_DIR.mkdir(parents=True, exist_ok=True)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("arial.ttf", "seguisym.ttf", "calibri.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_icon(size: int, filename: str, maskable: bool = False) -> None:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = int(size * (0.04 if maskable else 0.0))
    radius = int(size * 0.22)

    draw.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=radius,
        fill=(18, 103, 243, 255),
    )
    draw.ellipse(
        (int(size * 0.58), int(size * 0.06), int(size * 1.08), int(size * 0.56)),
        fill=(121, 169, 255, 95),
    )
    draw.ellipse(
        (int(size * -0.08), int(size * 0.64), int(size * 0.36), int(size * 1.08)),
        fill=(76, 201, 176, 90),
    )

    mark_font = font(int(size * 0.43))
    text = "√x"
    bbox = draw.textbbox((0, 0), text, font=mark_font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (size - text_w) / 2
    y = (size - text_h) / 2 - int(size * 0.03)
    draw.text((x, y), text, font=mark_font, fill=(255, 255, 255, 255))

    image.save(ICON_DIR / filename)


for icon_size in (192, 512):
    draw_icon(icon_size, f"icon-{icon_size}.png")
    draw_icon(icon_size, f"maskable-{icon_size}.png", maskable=True)
