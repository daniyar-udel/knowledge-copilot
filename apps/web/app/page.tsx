"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type DocMeta = {
  doc_id: string;
  filename: string;
  created_at?: string;
  indexed?: boolean;
  indexed_at?: string;
  chunk_count?: number;
};

type Source = {
  doc_id?: string;
  source?: string;
  page?: number;
  snippet?: string;
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

export default function Home() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("ALL");

  const [uploading, setUploading] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const selectedDoc = useMemo(() => {
    if (selectedDocId === "ALL") return null;
    return docs.find((d) => d.doc_id === selectedDocId) ?? null;
  }, [docs, selectedDocId]);

  async function fetchDocs() {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/documents`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { documents: DocMeta[] };
      setDocs(data.documents ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch documents");
    }
  }

  useEffect(() => {
    fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload() {
    setError(null);
    const inputEl = fileRef.current;
    if (!inputEl || !inputEl.files || inputEl.files.length === 0) {
      setError("Please choose a PDF file first.");
      return;
    }

    const file = inputEl.files[0];
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only .pdf supported for now.");
      return;
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch(`${apiBase}/documents/upload`, {
        method: "POST",
        body: fd,
      });

      if (!res.ok) throw new Error(await res.text());

      const data = (await res.json()) as { doc_id: string; filename: string };

      // Refresh docs and select the new one
      await fetchDocs();
      setSelectedDocId(data.doc_id);

      // Clear file input
      inputEl.value = "";
    } catch (e: any) {
      setError(e?.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleIndex() {
    setError(null);
    if (selectedDocId === "ALL") {
      setError("Select a document to index (not ALL).");
      return;
    }

    setIndexing(true);
    try {
      const res = await fetch(`${apiBase}/documents/${selectedDocId}/index`, {
        method: "POST",
      });

      if (!res.ok) throw new Error(await res.text());

      await fetchDocs();
    } catch (e: any) {
      setError(e?.message ?? "Index failed");
    } finally {
      setIndexing(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);

    try {
      const payload: any = { message: text };
      if (selectedDocId !== "ALL") payload.doc_id = selectedDocId;

      const res = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(await res.text());

      const data = (await res.json()) as { answer: string; sources?: Source[] };

      setMsgs((m) => [
        ...m,
        { role: "assistant", content: data.answer, sources: data.sources ?? [] },
      ]);
    } catch (e: any) {
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: `Error: ${e?.message ?? "unknown error"}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Knowledge Copilot (Stage #1)</h1>
        <p className="mt-1 text-sm text-slate-600">
          Upload PDF → Index → Ask questions → See relevant excerpts (sources).
        </p>

        <div className="mt-4 rounded-xl border border-slate-200 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            {/* Upload */}
            <div className="flex-1">
              <label className="text-sm font-medium">Upload PDF</label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  onClick={handleUpload}
                  disabled={uploading}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  {uploading ? "Uploading..." : "Upload"}
                </button>
              </div>
            </div>

            {/* Documents */}
            <div className="flex-1">
              <label className="text-sm font-medium">Documents</label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  value={selectedDocId}
                  onChange={(e) => setSelectedDocId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="ALL">All indexed documents</option>
                  {docs.map((d) => (
                    <option key={d.doc_id} value={d.doc_id}>
                      {d.filename} {d.indexed ? "✅" : "⏳"}
                    </option>
                  ))}
                </select>

                <button
                  onClick={fetchDocs}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                >
                  Refresh
                </button>
              </div>

              <div className="mt-2 text-xs text-slate-600">
                {selectedDoc ? (
                  <div>
                    <div>
                      Selected: <span className="font-medium">{selectedDoc.filename}</span>
                    </div>
                    <div>
                      Indexed:{" "}
                      <span className="font-medium">
                        {selectedDoc.indexed ? "yes" : "no"}
                      </span>
                      {typeof selectedDoc.chunk_count === "number" ? (
                        <>
                          {" "}
                          · chunks:{" "}
                          <span className="font-medium">{selectedDoc.chunk_count}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div>Mode: search across all indexed documents.</div>
                )}
              </div>
            </div>

            {/* Index */}
            <div className="flex-none">
              <label className="text-sm font-medium">Index selected</label>
              <div className="mt-2">
                <button
                  onClick={handleIndex}
                  disabled={indexing || selectedDocId === "ALL"}
                  className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
                  title={selectedDocId === "ALL" ? "Select a specific doc to index" : ""}
                >
                  {indexing ? "Indexing..." : "Index"}
                </button>
              </div>
              <div className="mt-2 text-xs text-slate-600">
                Indexing is required before search.
              </div>
            </div>
          </div>

          {error ? (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          ) : null}
        </div>

        {/* Chat */}
        <div className="mt-4 rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium">Chat</div>

          <div className="mt-3 min-h-[320px] rounded-xl border border-slate-200 p-3">
            {msgs.length === 0 ? (
              <div className="text-sm text-slate-600">
                Upload a PDF → Index → Ask: “What does the document say about …?”
              </div>
            ) : (
              <div className="space-y-4">
                {msgs.map((m, i) => (
                  <div key={i}>
                    <div className="text-xs text-slate-500">{m.role}</div>
                    <div className="whitespace-pre-wrap text-sm">{m.content}</div>

                    {m.role === "assistant" && m.sources && m.sources.length > 0 ? (
                      <div className="mt-2 rounded-lg bg-slate-50 p-3">
                        <div className="text-xs font-medium text-slate-700">
                          Sources
                        </div>
                        <div className="mt-2 space-y-2">
                          {m.sources.map((s, j) => (
                            <div
                              key={j}
                              className="rounded-lg border border-slate-200 bg-white p-2"
                            >
                              <div className="text-xs text-slate-600">
                                {s.source ?? "doc"}{" "}
                                {s.page ? `· p.${s.page}` : ""}{" "}
                                {s.doc_id ? `· ${String(s.doc_id).slice(0, 8)}…` : ""}
                              </div>
                              <div className="mt-1 text-sm text-slate-800 whitespace-pre-wrap">
                                {s.snippet ?? ""}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Type your question..."
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              onClick={send}
              disabled={loading}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
            >
              {loading ? "..." : "Send"}
            </button>
          </div>

          <div className="mt-2 text-xs text-slate-500">API: {apiBase}</div>
        </div>
      </div>
    </main>
  );
}