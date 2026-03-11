from __future__ import annotations

import os

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.retrievers import BM25Retriever
from langchain_core.documents import Document

from langchain_openai import ChatOpenAI
from dotenv import load_dotenv


load_dotenv(Path(__file__).parent / ".env")
assert os.getenv("OPENAI_API_KEY"), "OPENAI_API_KEY is not loaded"


# ---------- Paths ----------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CHUNKS_DIR = DATA_DIR / "chunks"
META_FILE = DATA_DIR / "documents.json"

for p in [DATA_DIR, UPLOAD_DIR, CHUNKS_DIR]:
    p.mkdir(parents=True, exist_ok=True)


# ---------- App ----------
app = FastAPI(title="Knowledge Copilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Models ----------
class ChatRequest(BaseModel):
    message: str
    doc_id: Optional[str] = None  # None => search across all indexed docs


# ---------- Meta helpers ----------
def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _load_meta() -> dict[str, Any]:
    if not META_FILE.exists():
        return {"documents": {}}
    return json.loads(META_FILE.read_text(encoding="utf-8"))


def _save_meta(meta: dict[str, Any]) -> None:
    META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _chunks_path(doc_id: str) -> Path:
    return CHUNKS_DIR / f"{doc_id}.jsonl"


def _save_chunks(doc_id: str, docs: list[Document]) -> None:
    path = _chunks_path(doc_id)
    with path.open("w", encoding="utf-8") as f:
        for d in docs:
            row = {"text": d.page_content, "metadata": d.metadata}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _load_chunks(doc_id: str) -> list[Document]:
    path = _chunks_path(doc_id)
    if not path.exists():
        return []
    docs: list[Document] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            docs.append(Document(page_content=row["text"], metadata=row.get("metadata", {})))
    return docs


def _load_all_indexed_docs(meta: dict[str, Any], doc_id: Optional[str]) -> list[Document]:
    out: list[Document] = []
    if doc_id:
        return _load_chunks(doc_id)
    # all indexed docs
    for did, d in meta["documents"].items():
        if d.get("indexed"):
            out.extend(_load_chunks(did))
    return out


def _retrieve(retriever, query: str):
    # New LangChain (Runnable)
    if hasattr(retriever, "invoke"):
        return retriever.invoke(query)
    # Older LangChain
    if hasattr(retriever, "get_relevant_documents"):
        return retriever.get_relevant_documents(query)
    # Last resort (private)
    return retriever._get_relevant_documents(query)


# ---------- Routes ----------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/documents")
def list_documents():
    meta = _load_meta()
    docs = list(meta["documents"].values())
    docs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"documents": docs}


@app.post("/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    if not file.filename:
        return JSONResponse({"error": "filename is empty"}, status_code=400)

    suffix = Path(file.filename).suffix.lower()
    if suffix != ".pdf":
        return JSONResponse({"error": "Only .pdf supported for now"}, status_code=400)

    doc_id = str(uuid.uuid4())
    save_path = UPLOAD_DIR / f"{doc_id}.pdf"
    save_path.write_bytes(await file.read())

    meta = _load_meta()
    meta["documents"][doc_id] = {
        "doc_id": doc_id,
        "filename": file.filename,
        "stored_as": save_path.name,
        "created_at": _now_iso(),
        "indexed": False,
        "chunk_count": 0,
    }
    _save_meta(meta)
    return {"doc_id": doc_id, "filename": file.filename}


@app.post("/documents/{doc_id}/index")
def index_document(doc_id: str):
    meta = _load_meta()
    doc = meta["documents"].get(doc_id)
    if not doc:
        return JSONResponse({"error": "doc_id not found"}, status_code=404)

    pdf_path = UPLOAD_DIR / doc["stored_as"]
    if not pdf_path.exists():
        return JSONResponse({"error": "file missing on disk"}, status_code=500)

    # 1) load PDF pages
    loader = PyPDFLoader(str(pdf_path))
    pages = loader.load()

    # add our metadata (page -> 1-based)
    for d in pages:
        d.metadata["doc_id"] = doc_id
        d.metadata["source"] = doc["filename"]
        d.metadata["page"] = int(d.metadata.get("page", 0)) + 1

    # 2) split into chunks
    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)
    chunks = splitter.split_documents(pages)

    # 3) persist chunks to disk (jsonl)
    _save_chunks(doc_id, chunks)

    # 4) update meta
    doc["indexed"] = True
    doc["chunk_count"] = len(chunks)
    doc["indexed_at"] = _now_iso()
    meta["documents"][doc_id] = doc
    _save_meta(meta)

    return {"doc_id": doc_id, "pages": len(pages), "chunks": len(chunks)}


@app.post("/chat")
def chat(req: ChatRequest):
    message = req.message.strip()
    if not message:
        return JSONResponse({"error": "message is empty"}, status_code=400)

    meta = _load_meta()

    # load indexed chunks (one doc or all)
    docs = _load_all_indexed_docs(meta, req.doc_id)

    if not docs:
        return {
            "answer": "No indexed documents found. Upload and index a PDF first.",
            "sources": [],
        }

    # BM25 retrieval (stable, no embeddings)
    retriever = BM25Retriever.from_documents(docs)
    retriever.k = 5
    hits = _retrieve(retriever, message)

    sources = []
    for d in hits:
        text = d.page_content or ""
        sources.append(
            {
                "doc_id": d.metadata.get("doc_id"),
                "source": d.metadata.get("source"),
                "page": d.metadata.get("page"),
                "snippet": (text[:260] + "...") if len(text) > 260 else text,
            }
        )

    if not sources:
        return {
            "answer": "I couldn't find anything relevant in the indexed documents.",
            "sources": [],
        }

    # Build context for LLM from top hits
    context_blocks = []
    for i, d in enumerate(hits, start=1):
        src = d.metadata.get("source", "doc")
        page = d.metadata.get("page", "?")
        context_blocks.append(f"[{i}] ({src}, p.{page})\n{d.page_content}")

    context = "\n\n".join(context_blocks) if context_blocks else "NO_CONTEXT"

    system = (
        "You are Knowledge Copilot. Answer ONLY using the provided context from documents. "
        "If the answer is not in the context, say: 'I couldn't find that in the documents.' "
        "Cite sources using (DocName p.X). Keep the answer concise and factual."
        )

    llm = ChatOpenAI(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        temperature=0,
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        )

    prompt = (
        f"{system}\n\n"
        f"CONTEXT:\n{context}\n\n"
        f"QUESTION:\n{message}\n\n"
        f"ANSWER:"
        )

    resp = llm.invoke(prompt)
    answer_text = resp.content if hasattr(resp, "content") else str(resp)

    return {"answer": answer_text, "sources": sources}