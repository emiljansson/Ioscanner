"""Image clean-up: keystone (perspective) correction and white-paper colour correction."""
import io

import numpy as np
from PIL import Image, ImageOps


def _coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """PIL PERSPECTIVE coefficients mapping output (dst) points to input (src) points."""
    a = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = np.array([c for p in src for c in p], dtype=float)
    return np.linalg.solve(np.array(a, dtype=float), b).tolist()


def keystone(im: Image.Image, corners: list[list[float]]) -> Image.Image | None:
    """corners: [[y, x] x4] normalized 0-1000 in order top-left, top-right, bottom-right, bottom-left.
    Returns the straightened page, or None when no correction is needed / corners are implausible."""
    if not isinstance(corners, list) or len(corners) != 4:
        return None
    try:
        pts = [(float(c[1]) / 1000 * im.width, float(c[0]) / 1000 * im.height) for c in corners]
    except (TypeError, ValueError, IndexError):
        return None
    tl, tr, br, bl = pts
    # Already straight and filling the frame (scanner / PDF) -> nothing to do.
    frame = [(0, 0), (im.width, 0), (im.width, im.height), (0, im.height)]
    if max(abs(p[0] - f[0]) / im.width + abs(p[1] - f[1]) / im.height for p, f in zip(pts, frame)) < 0.03:
        return None

    def dist(p, q):
        return ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5
    w = int(max(dist(tl, tr), dist(bl, br)))
    h = int(max(dist(tl, bl), dist(tr, br)))
    # Sanity: page must be a reasonable part of the photo and roughly convex.
    if w < 0.25 * im.width or h < 0.25 * im.height or not (tl[0] < tr[0] and bl[0] < br[0] and tl[1] < bl[1] and tr[1] < br[1]):
        return None
    out = im.transform((w, h), Image.PERSPECTIVE, _coeffs([(0, 0), (w, 0), (w, h), (0, h)], pts), Image.BICUBIC)
    return out


def white_balance(im: Image.Image, sample: np.ndarray | None = None) -> Image.Image:
    """Assume the paper is white: scale each channel so the paper colour becomes white,
    then a gentle contrast stretch. `sample` = pixels known to be paper (else brightest 25 %)."""
    arr = np.asarray(im.convert("RGB")).astype(np.float32)
    px = sample if sample is not None and sample.size else arr.reshape(-1, 3)
    lum = px.mean(axis=1)
    paper = px[lum >= np.percentile(lum, 75)]
    if not paper.size:
        return im
    white = np.median(paper, axis=0)
    if white.min() < 60:  # too dark to be paper – leave untouched
        return im
    arr = np.clip(arr * (245.0 / np.maximum(white, 1)), 0, 255)
    return ImageOps.autocontrast(Image.fromarray(arr.astype(np.uint8)), cutoff=0.5)


def correct_page(data: bytes, corners: list | None) -> tuple[bytes, bool]:
    """Keystone + colour correct a page photo. Returns (jpeg bytes, changed)."""
    with Image.open(io.BytesIO(data)) as src:
        im = src.convert("RGB")
    straight = keystone(im, corners) if corners else None
    out = white_balance(straight or im)
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=90)
    return buf.getvalue(), True


def correct_crop(page: Image.Image, rect: tuple[int, int, int, int]) -> Image.Image:
    """White-balance a figure crop using the ring of (expected white) paper around it."""
    x0, y0, x1, y1 = rect
    m = max(6, int(0.02 * max(page.width, page.height)))
    arr = np.asarray(page.convert("RGB"))
    ring = np.concatenate([
        arr[max(0, y0 - m):y0, x0:x1].reshape(-1, 3), arr[y1:y1 + m, x0:x1].reshape(-1, 3),
        arr[y0:y1, max(0, x0 - m):x0].reshape(-1, 3), arr[y0:y1, x1:x1 + m].reshape(-1, 3),
    ]).astype(np.float32)
    crop = page.convert("RGB").crop(rect)
    return white_balance(crop, ring if len(ring) > 50 else None)
