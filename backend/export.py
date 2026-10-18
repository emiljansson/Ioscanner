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
    return md, figmap


async def build_files(doc: dict) -> dict:
    """Return {"docx": bytes, "txt": str, "images": {name: bytes}}."""
    md, figmap = await document_markdown(doc)
    used = [fid for _, fid in REF_RE.findall(md) if fid in figmap]
    images: dict[str, bytes] = {}
    names: dict[str, str] = {}
    for i, fid in enumerate(dict.fromkeys(used), 1):
        name = f"bild_{i:02d}.jpg"
        try:
            images[name] = await fetch_bytes(figmap[fid])
            names[fid] = name
        except Exception:
            continue
    final_md = REF_RE.sub(lambda m: f"![{m.group(1)}](images/{names[m.group(2)]})" if m.group(2) in names else "", md)
    title = doc.get("title") or "Dokument"

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
                                  extra_args=[f"--resource-path={tmp}", f"--metadata=title:{title}"])
            txt = pypandoc.convert_file(str(src), "plain", format=PANDOC_FMT, extra_args=["--wrap=none"])
            return out.read_bytes(), txt
    docx, txt = await asyncio.to_thread(_convert)
    return {"docx": docx, "txt": txt, "images": images}


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
    return buf.getvalue()
