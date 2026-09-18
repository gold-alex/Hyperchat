#!/usr/bin/env python3
"""Regenerate the extension icons from logo.png.

    pip install Pillow && python3 icons/make-icons.py

The source art is a wide banner (roughly 1.77:1) on a flat background, so it has
to be cropped to its content and centred on a square before Chrome will make
anything sensible of it.

At 16px the speech bubble's tail is a handful of pixels and only muddies an
already tight icon, so that size is built from the bubble body alone. The larger
sizes keep it.
"""

from collections import deque
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
SOURCE = HERE / 'logo.png'
SIZES = (16, 32, 48, 128)

# How far a pixel must sit from the flat background colour to count as artwork.
TOLERANCE = 18

# Breathing room around the art, as a fraction of its longest side.
MARGIN = 0.08


def load():
    image = Image.open(SOURCE).convert('RGBA')
    return image, image.getpixel((2, 2))


def find_blobs(image, background):
    """Bounding boxes of each connected piece of artwork, largest area first."""
    width, height = image.size
    pixels = image.load()

    def is_art(x, y):
        pixel = pixels[x, y]
        return (
            any(abs(pixel[i] - background[i]) > TOLERANCE for i in range(3))
            or pixel[3] != background[3]
        )

    seen = [[False] * width for _ in range(height)]
    blobs = []

    for start_y in range(height):
        for start_x in range(width):
            if seen[start_y][start_x] or not is_art(start_x, start_y):
                continue

            queue = deque([(start_x, start_y)])
            seen[start_y][start_x] = True
            min_x = max_x = start_x
            min_y = max_y = start_y
            area = 0

            while queue:
                x, y = queue.popleft()
                area += 1
                min_x, max_x = min(min_x, x), max(max_x, x)
                min_y, max_y = min(min_y, y), max(max_y, y)

                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height and not seen[ny][nx] and is_art(nx, ny):
                        seen[ny][nx] = True
                        queue.append((nx, ny))

            # Single stray pixels are compression noise, not artwork.
            if area > 16:
                blobs.append((area, (min_x, min_y, max_x, max_y)))

    blobs.sort(reverse=True)
    return blobs


def square(image, background, box, margin):
    left, top, right, bottom = box
    art = image.crop((left, top, right + 1, bottom + 1))
    art_width, art_height = art.size

    side = int(max(art_width, art_height) * (1 + margin))
    canvas = Image.new('RGBA', (side, side), background)
    canvas.paste(art, ((side - art_width) // 2, (side - art_height) // 2), art)
    return canvas


def main():
    image, background = load()
    blobs = find_blobs(image, background)
    if not blobs:
        raise SystemExit('No artwork found in logo.png - is it a flat image?')

    full = (
        min(box[0] for _, box in blobs),
        min(box[1] for _, box in blobs),
        max(box[2] for _, box in blobs),
        max(box[3] for _, box in blobs),
    )
    body = blobs[0][1]

    with_tail = square(image, background, full, MARGIN)
    # No margin for the small one: every pixel of the bubble is worth keeping.
    body_only = square(image, background, body, 0)

    for size in SIZES:
        master = body_only if size <= 16 else with_tail
        master.resize((size, size), Image.LANCZOS).save(HERE / f'icon-{size}.png')
        print(f'icon-{size}.png  from {"bubble body" if size <= 16 else "full logo"}')


if __name__ == '__main__':
    main()
