"""Read text out of an uploaded PDF or Word (.docx) file."""
import asyncio
import io
import logging
import re

from fastapi import APIRouter, Request

from ..errors import AppError
from ..security import clean, guard

router = APIRouter()
log = logging.getLogger("prooflearn.extract")

MAX_FILE_BYTES = 4_000_000  # 4 MB
MAX_TEXT = 20000            # same limit the notes screens use
MAX_PDF_PAGES = 30


def kind_of(name: str, data: bytes) -> str | None:
    """The file's first bytes must match the type its name claims."""
    ext = name.lower().rsplit(".", 1)[-1]
    if ext == "pdf" and data[:5] == b"%PDF-":
        return "pdf"
    if ext == "docx" and data[:2] == b"PK":  # a zip header
        return "docx"
    return None


def _read_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                raise AppError("password", 422, "password")
        except AppError:
            raise
        except Exception:  # noqa: BLE001
            raise AppError("password", 422, "password")
    if len(reader.pages) > MAX_PDF_PAGES:
        raise AppError(f"That PDF has {len(reader.pages)} pages. The limit is {MAX_PDF_PAGES}. Upload fewer pages.", 413)
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)


def _read_docx(data: bytes) -> str:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(io.BytesIO(data))
    out = []
    for block in doc.iter_inner_content():  # paragraphs and tables, in reading order
        if isinstance(block, Paragraph):
            out.append(block.text)
        elif isinstance(block, Table):
            for row in block.rows:
                out.append("\t".join(c.text for c in row.cells))
    return "\n\n".join(out)


@router.post("/api/extract")
async def extract(request: Request):
    guard(request, "extract")
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_FILE_BYTES + 100_000:
        raise AppError("That file is too large (4 MB maximum).", 413)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        raise AppError("That upload was not valid.", 400)
    file = form.get("file")
    if file is None or not hasattr(file, "read") or not hasattr(file, "filename"):
        raise AppError("Choose a PDF or Word (.docx) file.", 400)
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise AppError("That file is too large (4 MB maximum).", 413)

    kind = kind_of(file.filename or "", data)
    if not kind:
        raise AppError("I can only read real PDF and Word (.docx) files. Old .doc files: save as .docx first.", 415)

    try:
        reader = _read_pdf if kind == "pdf" else _read_docx
        text = await asyncio.wait_for(asyncio.to_thread(reader, data), timeout=20)
    except AppError as e:
        if e.code == "password":
            raise AppError("This file is password-protected. Remove the password (open it, then save a copy without one) and upload it again.", 422, "password", show_code=True)
        raise
    except asyncio.TimeoutError:
        raise AppError("That file took too long to read.", 422)
    except Exception as e:  # noqa: BLE001
        # Say what really went wrong. The page reads the "code" and, for a PDF, tries again inside the browser.
        why = f"{type(e).__name__} {e}"
        log.error("[extract] parse failed: %s", why[:300])
        if re.search("password|encrypt", why, re.I):
            raise AppError("This file is password-protected. Remove the password (open it, then save a copy without one) and upload it again.", 422, "password", show_code=True)
        if kind == "pdf" and re.search(r"PdfRead|PdfStream|EOF marker|startxref|xref|Invalid|corrupt|not a PDF", why, re.I):
            raise AppError("This PDF looks damaged. Try saving or exporting it again from the program that made it.", 422, "damaged", show_code=True)
        raise AppError("I could not read that file on the server.", 422, "parse" if kind == "pdf" else "damaged", show_code=True)

    text = clean(re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)), 1_000_000)
    if len(text) < 20:
        raise AppError(
            "This PDF has no text inside it. It is probably a scan, or it was printed with “Microsoft Print to PDF”, which turns writing into pictures. It needs to be read like a photo (OCR)."
            if kind == "pdf" else "I found no readable text in that file.", 422, "no_text", show_code=True)
    return {"text": text[:MAX_TEXT], "chars": len(text), "truncated": len(text) > MAX_TEXT}
