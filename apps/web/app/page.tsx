"use client";

import Link from "next/link";
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
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  chatId?: string;
  latencyMs?: number;
  feedback?: 1 | -1 | null;
  pending?: boolean;
};

type StreamEvent =
  | { type: "meta"; chat_id: string; sources?: Source[] }
  | { type: "token"; content?: string }
  | {
      type: "done";
      chat_id: string;
      answer: string;
      sources?: Source[];
      latency_ms?: number;
    }
  | { type: "error"; error?: string };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

export default function Home() {
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
      const res = await fetch(`${API_BASE}/documents`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { documents: DocMeta[] };
      setDocs(data.documents ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch documents");
    }
  }

  useEffect(() => {
    fetchDocs();
  }, []);

  function updateMessage(id: string, updater: (msg: Msg) => Msg) {
    setMsgs((current) => current.map((msg) => (msg.id === id ? updater(msg) : msg)));
  }

  async function handleUpload() {
    setError(null);
    const inputEl = fileRef.current;
    if (!inputEl?.files?.length) {
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

      const res = await fetch(`${API_BASE}/documents/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());

      const data = (await res.json()) as { doc_id: string };
      await fetchDocs();
      setSelectedDocId(data.doc_id);
      inputEl.value = "";
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
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
      const res = await fetch(`${API_BASE}/documents/${selectedDocId}/index`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchDocs();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Index failed");
    } finally {
      setIndexing(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    const assistantId = crypto.randomUUID();
    const nextMsgs: Msg[] = [
      { id: crypto.randomUUID(), role: "user", content: text },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        sources: [],
        feedback: null,
        pending: true,
      },
    ];

    setMsgs((current) => [...current, ...nextMsgs]);
    setInput("");
    setLoading(true);

    try {
      const payload: { message: string; doc_id?: string } = { message: text };
      if (selectedDocId !== "ALL") payload.doc_id = selectedDocId;

      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error("Streaming response body is missing.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;

          if (event.type === "meta") {
            updateMessage(assistantId, (msg) => ({
              ...msg,
              chatId: event.chat_id,
              sources: event.sources ?? [],
            }));
          }

          if (event.type === "token") {
            updateMessage(assistantId, (msg) => ({
              ...msg,
              content: `${msg.content}${event.content ?? ""}`,
            }));
          }

          if (event.type === "done") {
            updateMessage(assistantId, (msg) => ({
              ...msg,
              chatId: event.chat_id,
              content: event.answer,
              sources: event.sources ?? [],
              latencyMs: event.latency_ms,
              pending: false,
            }));
          }

          if (event.type === "error") {
            throw new Error(event.error ?? "Unknown streaming error");
          }
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer) as StreamEvent;
        if (event.type === "done") {
          updateMessage(assistantId, (msg) => ({
            ...msg,
            chatId: event.chat_id,
            content: event.answer,
            sources: event.sources ?? [],
            latencyMs: event.latency_ms,
            pending: false,
          }));
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "unknown error";
      updateMessage(assistantId, (msg) => ({
        ...msg,
        content: `Error: ${message}`,
        pending: false,
      }));
    } finally {
      setLoading(false);
    }
  }

  async function submitFeedback(messageId: string, chatId: string | undefined, value: 1 | -1) {
    if (!chatId) return;

    updateMessage(messageId, (msg) => ({ ...msg, feedback: value }));
    try {
      const res = await fetch(`${API_BASE}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, value }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: unknown) {
      updateMessage(messageId, (msg) => ({ ...msg, feedback: null }));
      setError(e instanceof Error ? e.message : "Feedback failed");
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#fef3c7,_#fff7ed_35%,_#fff_68%)] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">
        <section className="rounded-[28px] border border-amber-200/70 bg-white/90 p-6 shadow-[0_24px_80px_rgba(120,53,15,0.08)] backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-700">
                Stage #4 Demo
              </p>
              <h1 className="mt-2 font-serif text-4xl leading-tight text-slate-950">
                Knowledge Copilot with streaming answers, feedback, and stats.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                Upload a PDF, index it, ask a question, and watch the answer arrive token
                by token like a real product.
              </p>
            </div>

            <div className="grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
              <div className="rounded-2xl border border-amber-100 bg-amber-50/80 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-700">
                  Retrieval
                </div>
                <div className="mt-1 font-medium">Semantic + BM25 fallback</div>
              </div>
              <Link
                href="/stats"
                className="rounded-2xl border border-slate-200 bg-slate-950 px-4 py-3 text-white transition hover:-translate-y-0.5"
              >
                <div className="text-xs uppercase tracking-[0.2em] text-slate-300">
                  Analytics
                </div>
                <div className="mt-1 font-medium">Open Stats dashboard</div>
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_1.8fr]">
          <div className="space-y-6">
            <div className="rounded-[24px] border border-slate-200 bg-white/90 p-5 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
                Documents
              </h2>

              <div className="mt-4">
                <label className="text-sm font-medium text-slate-800">Upload PDF</label>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf"
                    className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  />
                  <button
                    onClick={handleUpload}
                    disabled={uploading}
                    className="rounded-2xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {uploading ? "Uploading..." : "Upload"}
                  </button>
                </div>
              </div>

              <div className="mt-5">
                <label className="text-sm font-medium text-slate-800">Documents</label>
                <div className="mt-2 flex flex-col gap-2">
                  <select
                    value={selectedDocId}
                    onChange={(e) => setSelectedDocId(e.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  >
                    <option value="ALL">All indexed documents</option>
                    {docs.map((d) => (
                      <option key={d.doc_id} value={d.doc_id}>
                        {d.filename} {d.indexed ? "✓" : "..." }
                      </option>
                    ))}
                  </select>

                  <div className="flex gap-2">
                    <button
                      onClick={fetchDocs}
                      className="flex-1 rounded-2xl border border-slate-300 px-4 py-2.5 text-sm transition hover:bg-slate-50"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={handleIndex}
                      disabled={indexing || selectedDocId === "ALL"}
                      className="flex-1 rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {indexing ? "Indexing..." : "Index selected"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                {selectedDoc ? (
                  <>
                    <div className="font-medium text-slate-900">{selectedDoc.filename}</div>
                    <div className="mt-1">
                      Indexed: {selectedDoc.indexed ? "yes" : "no"}
                      {typeof selectedDoc.chunk_count === "number"
                        ? ` • chunks: ${selectedDoc.chunk_count}`
                        : ""}
                    </div>
                  </>
                ) : (
                  <div>Current mode: search across all indexed documents.</div>
                )}
              </div>

              {error ? (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-white/90 p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Chat
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Ask grounded questions and inspect the retrieved excerpts.
                </p>
              </div>
              <div className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                {loading ? "Streaming..." : "Ready"}
              </div>
            </div>

            <div className="mt-4 min-h-[420px] rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,_#fff,_#fffaf0)] p-4">
              {msgs.length === 0 ? (
                <div className="flex h-full min-h-[380px] items-center justify-center text-center text-sm leading-6 text-slate-500">
                  Upload a PDF, run indexing, then ask a specific question about the
                  document to see streamed grounded answers.
                </div>
              ) : (
                <div className="space-y-4">
                  {msgs.map((m) => (
                    <article
                      key={m.id}
                      className={`rounded-3xl px-4 py-3 ${
                        m.role === "user"
                          ? "ml-auto max-w-[85%] bg-slate-950 text-white"
                          : "max-w-[92%] border border-slate-200 bg-white text-slate-900"
                      }`}
                    >
                      <div className="text-[11px] uppercase tracking-[0.18em] opacity-60">
                        {m.role === "user" ? "You" : "Assistant"}
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-sm leading-6">
                        {m.content || (m.pending ? "Thinking..." : "")}
                      </div>

                      {m.role === "assistant" ? (
                        <div className="mt-3 space-y-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            {typeof m.latencyMs === "number" ? (
                              <span>Latency: {m.latencyMs} ms</span>
                            ) : null}
                            {m.chatId ? <span>Chat ID: {m.chatId.slice(0, 8)}...</span> : null}
                          </div>

                          {!m.pending && m.chatId ? (
                            <div className="flex gap-2">
                              <button
                                onClick={() => submitFeedback(m.id, m.chatId, 1)}
                                className={`rounded-full border px-3 py-1 text-xs transition ${
                                  m.feedback === 1
                                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                    : "border-slate-300 hover:bg-slate-50"
                                }`}
                              >
                                👍 Helpful
                              </button>
                              <button
                                onClick={() => submitFeedback(m.id, m.chatId, -1)}
                                className={`rounded-full border px-3 py-1 text-xs transition ${
                                  m.feedback === -1
                                    ? "border-rose-500 bg-rose-50 text-rose-700"
                                    : "border-slate-300 hover:bg-slate-50"
                                }`}
                              >
                                👎 Not helpful
                              </button>
                            </div>
                          ) : null}

                          {m.sources?.length ? (
                            <div className="rounded-2xl bg-slate-50 p-3">
                              <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                                Sources
                              </div>
                              <div className="mt-2 space-y-2">
                                {m.sources.map((s, idx) => (
                                  <div
                                    key={`${m.id}-${idx}`}
                                    className="rounded-2xl border border-slate-200 bg-white p-3"
                                  >
                                    <div className="text-xs text-slate-500">
                                      {s.source ?? "doc"}
                                      {s.page ? ` • p.${s.page}` : ""}
                                      {s.doc_id ? ` • ${String(s.doc_id).slice(0, 8)}...` : ""}
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                                      {s.snippet ?? ""}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="What does the document say about...?"
                className="flex-1 rounded-[20px] border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-amber-400"
              />
              <button
                onClick={send}
                disabled={loading}
                className="rounded-[20px] bg-amber-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Streaming..." : "Send"}
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-500">API: {API_BASE}</div>
          </div>
        </section>
      </div>
    </main>
  );
}
