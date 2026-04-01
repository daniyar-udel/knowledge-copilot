"""
Basic API tests.

Run from apps/api/:
    pip install -r requirements-dev.txt
    pytest tests/
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

# ---------- /health ----------

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ---------- /documents ----------

def test_list_documents_empty():
    response = client.get("/documents")
    assert response.status_code == 200
    data = response.json()
    assert "documents" in data
    assert data["documents"] == []


def test_upload_rejects_non_pdf():
    response = client.post(
        "/documents/upload",
        files={"file": ("notes.txt", b"hello world", "text/plain")},
    )
    assert response.status_code == 400
    assert "pdf" in response.json()["error"].lower()


def test_upload_pdf_succeeds(tmp_path):
    minimal_pdf = (
        b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n"
        b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
        b"0000000058 00000 n \n0000000115 00000 n \n"
        b"trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF"
    )
    response = client.post(
        "/documents/upload",
        files={"file": ("paper.pdf", minimal_pdf, "application/pdf")},
    )
    assert response.status_code == 200
    data = response.json()
    assert "doc_id" in data
    assert data["filename"] == "paper.pdf"


def test_upload_then_appears_in_list():
    minimal_pdf = b"%PDF-1.4\n%%EOF"
    upload = client.post(
        "/documents/upload",
        files={"file": ("report.pdf", minimal_pdf, "application/pdf")},
    )
    assert upload.status_code == 200
    doc_id = upload.json()["doc_id"]

    response = client.get("/documents")
    ids = [d["doc_id"] for d in response.json()["documents"]]
    assert doc_id in ids


def test_index_unknown_doc_returns_404():
    response = client.post("/documents/nonexistent-id/index")
    assert response.status_code == 404


def test_delete_unknown_doc_returns_404():
    response = client.delete("/documents/nonexistent-id")
    assert response.status_code == 404


def test_delete_removes_document():
    minimal_pdf = b"%PDF-1.4\n%%EOF"
    upload = client.post(
        "/documents/upload",
        files={"file": ("to_delete.pdf", minimal_pdf, "application/pdf")},
    )
    doc_id = upload.json()["doc_id"]

    delete = client.delete(f"/documents/{doc_id}")
    assert delete.status_code == 200
    assert delete.json()["ok"] is True

    docs = client.get("/documents").json()["documents"]
    assert all(d["doc_id"] != doc_id for d in docs)


# ---------- /stats ----------

def test_stats_returns_expected_keys():
    response = client.get("/stats")
    assert response.status_code == 200
    data = response.json()
    for key in (
        "total_chats",
        "avg_latency_ms",
        "avg_sources_per_chat",
        "thumbs_up",
        "thumbs_down",
        "feedback_total",
        "positive_feedback_rate",
        "total_documents",
        "indexed_documents",
        "top_queries",
        "recent_chats",
    ):
        assert key in data, f"Missing key: {key}"


def test_stats_empty_state():
    response = client.get("/stats")
    data = response.json()
    assert data["total_chats"] == 0
    assert data["total_documents"] == 0
    assert data["positive_feedback_rate"] == 0


# ---------- /feedback ----------

def test_feedback_rejects_invalid_value():
    response = client.post(
        "/feedback",
        json={"chat_id": "abc", "value": 0},
    )
    assert response.status_code == 400


def test_feedback_thumbs_up():
    response = client.post(
        "/feedback",
        json={"chat_id": "test-chat-id", "value": 1},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_feedback_thumbs_down():
    response = client.post(
        "/feedback",
        json={"chat_id": "test-chat-id", "value": -1},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_feedback_reflected_in_stats():
    client.post("/feedback", json={"chat_id": "id-1", "value": 1})
    client.post("/feedback", json={"chat_id": "id-2", "value": -1})

    stats = client.get("/stats").json()
    assert stats["thumbs_up"] == 1
    assert stats["thumbs_down"] == 1
    assert stats["feedback_total"] == 2
    assert stats["positive_feedback_rate"] == 50.0


# ---------- /chat ----------

def test_chat_empty_message_returns_400():
    response = client.post("/chat", json={"message": "   "})
    assert response.status_code == 400


def test_chat_no_indexed_docs_returns_guidance():
    response = client.post("/chat", json={"message": "What is this about?"})
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    # Without indexed documents the API returns a helpful message, not an LLM call
    assert data["answer"] != ""
