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


async def build_files(doc: dict) -> dict:
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
            return out.read_bytes(), txt
    docx, txt = await asyncio.to_thread(_convert)
    return {"docx": docx, "txt": txt, "images": images, "captions": "\n".join(caption_lines)}


def safe_name(title: str) -> str:
    s = re.sub(r"[^\w\-. åäöÅÄÖ]", "", title or "dokument").strip() or "dokument"
    return s[:80]


def make_zip(files: dict, base: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{base}.docx", files["docx"])
        z.writestr(f"{base}.txt", files["txt"])
        for n, b in files["images"].items():
            z.writestr(f"bilder/{n}", b)
        if files.get("captions"):
            z.writestr("bilder/bildtexter.txt", files["captions"] + "\n")
    return buf.getvalue()
