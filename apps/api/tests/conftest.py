import pytest
from unittest.mock import patch


@pytest.fixture(autouse=True)
def isolate_data(tmp_path):
    """Redirect all data paths to a temp directory so tests never touch real data."""
    import main

    uploads = tmp_path / "uploads"
    chunks = tmp_path / "chunks"
    chroma = tmp_path / "chroma"
    uploads.mkdir()
    chunks.mkdir()
    chroma.mkdir()

    with (
        patch.object(main, "DATA_DIR", tmp_path),
        patch.object(main, "UPLOAD_DIR", uploads),
        patch.object(main, "CHUNKS_DIR", chunks),
        patch.object(main, "META_FILE", tmp_path / "documents.json"),
        patch.object(main, "CHROMA_DIR", chroma),
        patch.object(main, "CHAT_LOG_FILE", tmp_path / "chat_logs.jsonl"),
        patch.object(main, "FEEDBACK_FILE", tmp_path / "feedback.jsonl"),
    ):
        yield
