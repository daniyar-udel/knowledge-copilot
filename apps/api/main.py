from __future__ import annotations

import json
import time
import uuid
from datetime import datetime
from collections import Counter
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_community.retrievers import BM25Retriever
from langchain_core.documents import Document
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter


# ---------- Paths ----------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CHUNKS_DIR = DATA_DIR / "chunks"
META_FILE = DATA_DIR / "documents.json"
CHROMA_DIR = DATA_DIR / "chroma"
CHAT_LOG_FILE = DATA_DIR / "chat_logs.jsonl"
FEEDBACK_FILE = DATA_DIR / "feedback.jsonl"

for path in [DATA_DIR, UPLOAD_DIR, CHUNKS_DIR, CHROMA_DIR]:
    path.mkdir(parents=True, exist_ok=True)


# ---------- App ----------
app = FastAPI(title="Knowledge Copilot API")

llm = ChatOllama(
    model="llama3.2",
    temperature=0,
    num_predict=256,
    keep_alive="10m",
)

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


class FeedbackRequest(BaseModel):
    chat_id: str
    value: int = Field(..., description="1 for thumbs up, -1 for thumbs down")


class PreparedChat(BaseModel):
    chat_id: str
    message: str
    doc_id: Optional[str]
    sources: list[dict[str, Any]]
    prompt_messages: list[tuple[str, str]]


class ChatResult(BaseModel):
    chat_id: str
    answer: str
    sources: list[dict[str, Any]]
    latency_ms: int


# ---------- Meta helpers ----------
def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _load_meta() -> dict[str, Any]:
    if not META_FILE.exists():
        return {"documents": {}}
    return json.loads(META_FILE.read_text(encoding="utf-8"))


def _save_meta(meta: dict[str, Any]) -> None:
    META_FILE.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _chunks_path(doc_id: str) -> Path:
    return CHUNKS_DIR / f"{doc_id}.jsonl"


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _save_chunks(doc_id: str, docs: list[Document]) -> None:
    path = _chunks_path(doc_id)
    with path.open("w", encoding="utf-8") as file:
        for doc in docs:
            row = {"text": doc.page_content, "metadata": doc.metadata}
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def _load_chunks(doc_id: str) -> list[Document]:
    path = _chunks_path(doc_id)
    if not path.exists():
        return []

    docs: list[Document] = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            row = json.loads(line)
            docs.append(
                Document(
                    page_content=row["text"],
                    metadata=row.get("metadata", {}),
                )
            )
    return docs


def _load_all_indexed_docs(meta: dict[str, Any], doc_id: Optional[str]) -> list[Document]:
    if doc_id:
        return _load_chunks(doc_id)

    docs: list[Document] = []
    for current_doc_id, current_doc in meta["documents"].items():
        if current_doc.get("indexed"):
            docs.extend(_load_chunks(current_doc_id))
    return docs


def _get_embeddings() -> OllamaEmbeddings:
    return OllamaEmbeddings(model="nomic-embed-text")


def _get_vectorstore() -> Chroma:
    return Chroma(
        collection_name="knowledge_copilot",
        embedding_function=_get_embeddings(),
        persist_directory=str(CHROMA_DIR),
    )


def _vector_search(query: str, doc_id: Optional[str]) -> list[Document]:
    try:
        vectorstore = _get_vectorstore()

        if doc_id:
            retriever = vectorstore.as_retriever(
                search_kwargs={"k": 5, "filter": {"doc_id": doc_id}}
            )
        else:
            retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

        return retriever.invoke(query)
    except Exception as exc:
        print(f"[vector retrieval error] {exc}")
        return []


def _bm25_search(query: str, docs: list[Document]) -> list[Document]:
    if not docs:
        return []

    retriever = BM25Retriever.from_documents(docs)
    retriever.k = 5
    return retriever.invoke(query)


def _build_sources(hits: list[Document]) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for doc in hits:
        text = doc.page_content or ""
        sources.append(
            {
                "doc_id": doc.metadata.get("doc_id"),
                "source": doc.metadata.get("source"),
                "page": doc.metadata.get("page"),
                "snippet": (text[:260] + "...") if len(text) > 260 else text,
            }
        )
    return sources


def _build_context(hits: list[Document], limit: int = 5, max_chars: int = 12000) -> str:
    context_blocks: list[str] = []
    for doc in hits[:limit]:
        src = doc.metadata.get("source", "doc")
        page = doc.metadata.get("page", "?")
        context_blocks.append(f"({src}, p.{page})\n{doc.page_content}")

    context = "\n\n---\n\n".join(context_blocks)
    return context[:max_chars]


def _prepare_chat(req: ChatRequest) -> PreparedChat | JSONResponse:
    message = req.message.strip()
    if not message:
        return JSONResponse({"error": "message is empty"}, status_code=400)

    meta = _load_meta()
    docs = _load_all_indexed_docs(meta, req.doc_id)

    if not docs:
        return JSONResponse(
            {
                "chat_id": str(uuid.uuid4()),
                "answer": "No indexed documents found. Upload and index a PDF first.",
                "sources": [],
                "latency_ms": 0,
            }
        )

    hits = _vector_search(message, req.doc_id)
    if not hits:
        hits = _bm25_search(message, docs)

    if not hits:
        return JSONResponse(
            {
                "chat_id": str(uuid.uuid4()),
                "answer": "I couldn't find anything relevant in the indexed documents.",
                "sources": [],
                "latency_ms": 0,
            }
        )

    sources = _build_sources(hits)
    context = _build_context(hits)

    prompt_messages = [
        (
            "system",
            "You are Knowledge Copilot. Answer ONLY using the provided CONTEXT. "
            "If the answer is not in the context, say: 'I couldn't find that in the documents.' "
            "When stating facts, cite like (DocName p.X).",
        ),
        ("human", f"CONTEXT:\n{context}\n\nQUESTION:\n{message}"),
    ]

    return PreparedChat(
        chat_id=str(uuid.uuid4()),
        message=message,
        doc_id=req.doc_id,
        sources=sources,
        prompt_messages=prompt_messages,
    )


def _log_chat(result: ChatResult, message: str, doc_id: Optional[str]) -> None:
    _append_jsonl(
        CHAT_LOG_FILE,
        {
            "chat_id": result.chat_id,
            "message": message,
            "doc_id": doc_id,
            "latency_ms": result.latency_ms,
            "source_count": len(result.sources),
            "created_at": _now_iso(),
        },
    )


def _feedback_summary() -> dict[str, int]:
    votes: dict[str, int] = {}
    for row in _read_jsonl(FEEDBACK_FILE):
        chat_id = row.get("chat_id")
        value = row.get("value")
        if chat_id and value in (1, -1):
            votes[chat_id] = value
    return votes


def _build_stats() -> dict[str, Any]:
    chats = _read_jsonl(CHAT_LOG_FILE)
    votes = _feedback_summary()
    query_counter = Counter()
    latencies: list[int] = []

    for row in chats:
        message = str(row.get("message", "")).strip()
        if message:
            query_counter[message] += 1
        latency = row.get("latency_ms")
        if isinstance(latency, (int, float)):
            latencies.append(int(latency))

    avg_latency = round(sum(latencies) / len(latencies), 1) if latencies else 0

    return {
        "total_chats": len(chats),
        "avg_latency_ms": avg_latency,
        "thumbs_up": sum(1 for value in votes.values() if value == 1),
        "thumbs_down": sum(1 for value in votes.values() if value == -1),
        "top_queries": [
            {"query": query, "count": count}
            for query, count in query_counter.most_common(5)
        ],
        "recent_chats": list(reversed(chats[-10:])),
    }


def _run_chat(prepared: PreparedChat) -> ChatResult:
    started_at = time.perf_counter()
    ai_msg = llm.invoke(prepared.prompt_messages)
    latency_ms = int((time.perf_counter() - started_at) * 1000)
    answer_text = str(ai_msg.content)
    return ChatResult(
        chat_id=prepared.chat_id,
        answer=answer_text,
        sources=prepared.sources,
        latency_ms=latency_ms,
    )


def _ndjson(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False) + "\n"


# ---------- Routes ----------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/documents")
def list_documents():
    meta = _load_meta()
    docs = list(meta["documents"].values())
    docs.sort(key=lambda item: item.get("created_at", ""), reverse=True)
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
    doc_meta = meta["documents"].get(doc_id)
    if not doc_meta:
        return JSONResponse({"error": "doc_id not found"}, status_code=404)

    pdf_path = UPLOAD_DIR / doc_meta["stored_as"]
    if not pdf_path.exists():
        return JSONResponse({"error": "file missing on disk"}, status_code=500)

    loader = PyPDFLoader(str(pdf_path))
    pages = loader.load()

    for page_doc in pages:
        page_doc.metadata["doc_id"] = doc_id
        page_doc.metadata["source"] = doc_meta["filename"]
        page_doc.metadata["page"] = int(page_doc.metadata.get("page", 0)) + 1

    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)
    chunks = splitter.split_documents(pages)

    _save_chunks(doc_id, chunks)

    vectorstore = _get_vectorstore()
    new_ids = [f"{doc_id}-{idx}" for idx in range(len(chunks))]

    old_ids = doc_meta.get("vector_ids") or []
    if old_ids:
        try:
            vectorstore.delete(ids=old_ids)
        except Exception as exc:
            print(f"[vector delete warning] {exc}")

    try:
        vectorstore.add_documents(documents=chunks, ids=new_ids)
    except Exception as exc:
        return JSONResponse(
            {"error": f"vector indexing failed: {exc}"},
            status_code=500,
        )

    doc_meta["vector_ids"] = new_ids
    doc_meta["indexed"] = True
    doc_meta["chunk_count"] = len(chunks)
    doc_meta["indexed_at"] = _now_iso()
    meta["documents"][doc_id] = doc_meta
    _save_meta(meta)

    return {"doc_id": doc_id, "pages": len(pages), "chunks": len(chunks)}


@app.get("/stats")
def stats():
    return _build_stats()


@app.post("/feedback")
def feedback(req: FeedbackRequest):
    if req.value not in (1, -1):
        return JSONResponse({"error": "value must be 1 or -1"}, status_code=400)

    _append_jsonl(
        FEEDBACK_FILE,
        {
            "chat_id": req.chat_id,
            "value": req.value,
            "created_at": _now_iso(),
        },
    )
    return {"ok": True}


@app.post("/chat")
def chat(req: ChatRequest):
    prepared = _prepare_chat(req)
    if isinstance(prepared, JSONResponse):
        return prepared

    try:
        result = _run_chat(prepared)
    except Exception as exc:
        return JSONResponse(
            {"error": f"llm invocation failed: {exc}"},
            status_code=500,
        )

    _log_chat(result, prepared.message, prepared.doc_id)
    return result.model_dump()


@app.post("/chat/stream")
def chat_stream(req: ChatRequest):
    prepared = _prepare_chat(req)
    if isinstance(prepared, JSONResponse):
        return prepared

    def generate() -> Iterator[str]:
        started_at = time.perf_counter()
        answer_parts: list[str] = []

        yield _ndjson(
            {
                "type": "meta",
                "chat_id": prepared.chat_id,
                "sources": prepared.sources,
            }
        )

        try:
            for chunk in llm.stream(prepared.prompt_messages):
                token = str(chunk.content or "")
                if not token:
                    continue
                answer_parts.append(token)
                yield _ndjson({"type": "token", "content": token})
        except Exception as exc:
            yield _ndjson({"type": "error", "error": f"llm invocation failed: {exc}"})
            return

        result = ChatResult(
            chat_id=prepared.chat_id,
            answer="".join(answer_parts),
            sources=prepared.sources,
            latency_ms=int((time.perf_counter() - started_at) * 1000),
        )
        _log_chat(result, prepared.message, prepared.doc_id)
        yield _ndjson({"type": "done", **result.model_dump()})

    return StreamingResponse(generate(), media_type="application/x-ndjson")
