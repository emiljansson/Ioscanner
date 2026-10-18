"""Build Markdown for a document and convert to Word (.docx) / ZIP with Pandoc."""
import re
import io
import zipfile
import asyncio
import tempfile
from pathlib import Path

import pypandoc

from core import db, fetch_bytes

FIG_RE = re.compile(r"\[\[FIGURE:(\d+)\]\]")
REF_RE = re.compile(r"!\[([^\]]*)\]\(fig:([a-f0-9]+)\)")
PANDOC_FMT = "markdown+tex_math_dollars+pipe_tables"
PREVIEW_CSS = """<style>
html { background: #e9e9ee; }
body { max-width: 760px; margin: 16px auto; padding: 48px 56px; background: #fff; color: #111;
  font-family: Calibri, "Segoe UI", -apple-system, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.5;
  box-shadow: 0 1px 6px rgba(0,0,0,.15); box-sizing: border-box; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #999; padding: 4px 8px; }
@media (max-width: 700px) { body { margin: 0; padding: 20px 18px; box-shadow: none; } html { background: #fff; } }
@media print { html { background: #fff; } body { box-shadow: none; margin: 0; padding: 0; max-width: none; } }
</style>"""
HTML_TAG_RE = re.compile(r"</?(div|span|br|p|hr|center|font)\b[^>]*>", re.I)


def strip_html(md: str) -> str:
    """Remove stray HTML tags (e.g. page-break divs) that AI models sometimes emit."""
    return re.sub(r"\n{3,}", "\n\n", HTML_TAG_RE.sub("", md or "")).strip()


def page_markdown_with_refs(page: dict) -> str:
    """Replace [[FIGURE:n]] with ![caption](fig:ID) references."""
    figs = {f["n"]: f for f in page.get("figures", []) if not f.get("deleted")}

    def rep(m):
        f = figs.get(int(m.group(1)))
        return f"![{f.get('caption', '')}](fig:{f['id']})" if f else ""
    return FIG_RE.sub(rep, page.get("markdown") or "")


async def document_markdown(doc: dict) -> tuple[str, dict]:
    """Return (markdown with fig:ID refs, {fig_id: url})."""
    figmap: dict = {}
    if doc.get("kind") == "generated":
        md = doc.get("markdown") or ""
        figmap = doc.get("figures") or {}
    else:
        pages = await db.pages.find({"document_id": doc["id"], "status": "done"}, {"_id": 0}).sort("order", 1).to_list(2000)
        parts = []
        for p in pages:
            for f in p.get("figures", []):
                if not f.get("deleted"):
                    figmap[f["id"]] = f["url"]
            parts.append(page_markdown_with_refs(p))
        md = "\n\n".join(x for x in parts if x.strip())
    md = strip_html(md)
    return md, figmap


async def figure_labels(doc: dict) -> dict:
    """{fig_id: (file name, caption line)} for every non-deleted image, in page order."""
    out: dict = {}
    if doc.get("kind") == "generated":
        caps = doc.get("figure_captions") or {}
        for i, fid in enumerate(doc.get("source_figures") or doc.get("figures") or {}, 1):
            out[fid] = (f"bild_{i:02d}.jpg", caps.get(fid, ""))
        return out
    pages = await db.pages.find({"document_id": doc["id"], "status": "done"}, {"_id": 0, "figures": 1}).sort("order", 1).to_list(2000)
    i = 0
    for pi, p in enumerate(pages, 1):
        for f in p.get("figures", []):
            if not f.get("deleted"):
                i += 1
                out[f["id"]] = (f"sida_{pi:02d}_bild_{i:02d}.jpg", f"Sida {pi}: {f.get('caption') or ''}".strip())
    return out


async def build_files(doc: dict, html: bool = False, pdf: bool = False) -> dict:
    """Return {"docx": bytes, "txt": str, "images": {name: bytes}, "captions": str}.

    The ZIP gets EVERY extracted image (not only those referenced in the text)."""
    md, figmap = await document_markdown(doc)
    allfigs = {**figmap, **(doc.get("source_figures") or {})}
    labels = await figure_labels(doc)
    images: dict[str, bytes] = {}
    names: dict[str, str] = {}
    caption_lines = []
    for fid, (name, cap) in labels.items():
        if fid not in allfigs:
            continue
        try:
            images[name] = await fetch_bytes(allfigs[fid])
            names[fid] = name
            caption_lines.append(f"{name}\t{cap}")
        except Exception:
            continue
    final_md = REF_RE.sub(lambda m: f"![{m.group(1)}](images/{names[m.group(2)]})" if m.group(2) in names else "", md)
    final_md = strip_html(final_md)

    def _convert():
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            (t / "images").mkdir()
            for n, b in images.items():
                (t / "images" / n).write_bytes(b)
            src = t / "doc.md"
            src.write_text(final_md, encoding="utf-8")
            out = t / "doc.docx"
            pypandoc.convert_file(str(src), "docx", format=PANDOC_FMT, outputfile=str(out),
                                  extra_args=[f"--resource-path={tmp}"])
            txt = pypandoc.convert_file(str(src), "plain", format=PANDOC_FMT, extra_args=["--wrap=none"])
            page = ""
            if html:
                (t / "style.html").write_text(PREVIEW_CSS, encoding="utf-8")
                page = pypandoc.convert_file(str(src), "html5", format=PANDOC_FMT, extra_args=[
                    f"--resource-path={tmp}", "--standalone", "--embed-resources", "--mathml",
                    f"--include-in-header={t / 'style.html'}", f"--metadata=pagetitle:{doc.get('title') or 'Dokument'}"])
            pdf_bytes = _html_to_pdf(_math_to_images(pypandoc.convert_file(str(src), "html5", format=PANDOC_FMT, extra_args=["--mathjax"]), t), tmp) if pdf else b""
            return out.read_bytes(), txt, page, pdf_bytes
    docx, txt, page, pdf_bytes = await asyncio.to_thread(_convert)
    return {"docx": docx, "txt": txt, "html": page, "pdf": pdf_bytes, "images": images,
            "captions": "\n".join(caption_lines)}


PDF_CSS = """
body { font-family: sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
figure { margin: 8pt 0; text-align: center; }
figcaption { font-size: 9.5pt; color: #444; text-align: center; margin-top: 3pt; }
table { border-collapse: collapse; } th, td { border: 1px solid #999; padding: 3px 6px; }
"""


MATH_RE = re.compile(r'<span\s+class="math (inline|display)">\\[(\[](.*?)\\[)\]]</span>', re.S)
MATH_FONT_PT = 11


def _render_tex(tex: str, path: Path, size: float = MATH_FONT_PT) -> tuple[float, float] | None:
    """Render TeX with matplotlib mathtext to a 300-dpi PNG. Returns (width_pt, height_pt) or None."""
    from matplotlib import mathtext
    from matplotlib.font_manager import FontProperties
    from PIL import Image
    tex = re.sub(r"\\(begin|end)\{(aligned|align\*?|gathered|split)\}", "", tex).replace("&", "")
    tex = re.sub(r"\\(dfrac|tfrac)", r"\\frac", tex).replace("\\displaystyle", "")
    lines = [x.strip() for x in re.split(r"\\\\", tex) if x.strip()] or [tex]
    try:
        imgs = []
        for i, line in enumerate(lines):
            lp = path.with_name(f"{path.stem}_{i}.png")
            mathtext.math_to_image(f"${line}$", str(lp), prop=FontProperties(size=size), dpi=300, format="png")
            im = Image.open(lp).convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[3])
            imgs.append(bg)
            lp.unlink()
    except Exception:
        return None
    w, h = max(i.width for i in imgs), sum(i.height for i in imgs) + 20 * (len(imgs) - 1)
    out = Image.new("RGB", (w, h), (255, 255, 255))
    y = 0
    for im in imgs:
        out.paste(im, (0, y))
        y += im.height + 20
    out.save(path)
    return w * 72 / 300, h * 72 / 300


def _math_to_images(body_html: str, tmpdir: Path) -> str:
    """Replace Pandoc's TeX math spans with rendered formula images (PyMuPDF can't render MathML)."""
    import html as htmlmod
    (tmpdir / "math").mkdir(exist_ok=True)
    count = [0]

    def rep(m):
        kind, tex = m.group(1), " ".join(htmlmod.unescape(m.group(2)).split())
        count[0] += 1
        name = f"math/m{count[0]}.png"
        size = _render_tex(tex, tmpdir / name, MATH_FONT_PT + (2 if kind == "display" else 0))
        if not size:
            return f"<code>{htmlmod.escape(tex)}</code>"  # unsupported by mathtext: show plain TeX
        img = f'<img src="{name}" width="{size[0]:.1f}" height="{size[1]:.1f}"/>'
        return f'<span style="display:block;text-align:center;margin:6pt 0">{img}</span>' if kind == "display" else img
    return MATH_RE.sub(rep, body_html)


IMG_TAG_RE = re.compile(r'<img src="(images/[^"]+)"')
PDF_IMG_MAX_W, PDF_IMG_MAX_H = 420, 640  # pt; same 14.8 cm max width as the Word export


def _size_images(body_html: str, resource_dir: str) -> str:
    """Give every figure an explicit size like Pandoc does in Word (1 px = 1 pt, capped to the text width)."""
    from PIL import Image

    def rep(m):
        try:
            with Image.open(Path(resource_dir) / m.group(1)) as im:
                w, h = im.size
        except Exception:
            return m.group(0)
        scale = min(1.0, PDF_IMG_MAX_W / w, PDF_IMG_MAX_H / h)
        return f'<img width="{w * scale:.0f}" height="{h * scale:.0f}" src="{m.group(1)}"'
    return IMG_TAG_RE.sub(rep, body_html)


def _html_to_pdf(body_html: str, resource_dir: str) -> bytes:
    """Render HTML to an A4 PDF with PyMuPDF Story, one top-level block at a time, so figures are
    moved to the next page instead of being shrunk to fit the space left on the current one."""
    import pymupdf as fitz
    from html import escape
    from lxml import html as lh
    body_html = _size_images(body_html, resource_dir)
    blocks = [f"<p>{escape(f)}</p>" if isinstance(f, str) else lh.tostring(f, encoding="unicode")
              for f in lh.fragments_fromstring(body_html) if not isinstance(f, str) or f.strip()]
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    page_rect = fitz.paper_rect("a4")
    area = page_rect + (56, 56, -56, -56)
    state = {"dev": None, "y": area.y0}

    def new_page():
        if state["dev"] is not None:
            writer.end_page()
        state["dev"], state["y"] = writer.begin_page(page_rect), area.y0

    def story(b):
        return fitz.Story(html=b, user_css=PDF_CSS, archive=resource_dir)

    new_page()
    for b in blocks:
        is_fig = "<img" in b and "math/" not in b
        if re.match(r"<h[1-6]", b) and area.y1 - state["y"] < 80:
            new_page()  # keep headings with the text that follows
        st = story(b)
        while True:
            more, filled = st.place(fitz.Rect(area.x0, state["y"], area.x1, area.y1))
            if more and is_fig and state["y"] > area.y0:
                new_page()  # whole figure on the next page instead of a shrunken one
                st = story(b)
                continue
            st.draw(state["dev"])
            if not more:
                state["y"] = fitz.Rect(filled).y1
                break
            new_page()
    writer.end_page()
    writer.close()
    return buf.getvalue()


def safe_name(title: str) -> str:
    s = re.sub(r"[^\w\-. åäöÅÄÖ]", "", title or "dokument").strip() or "dokument"
    return s[:80]


def make_zip(files: dict, base: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{base}.docx", files["docx"])
        z.writestr(f"{base}.txt", files["txt"])
        if files.get("pdf"):
            z.writestr(f"{base}.pdf", files["pdf"])
        for n, b in files["images"].items():
            z.writestr(f"bilder/{n}", b)
        if files.get("captions"):
            z.writestr("bilder/bildtexter.txt", files["captions"] + "\n")
    return buf.getvalue()
