"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type StatQuery = {
  query: string;
  count: number;
};

type RecentChat = {
  chat_id: string;
  message: string;
  latency_ms: number;
  source_count: number;
  created_at: string;
};

type StatsResponse = {
  total_chats: number;
  avg_latency_ms: number;
  avg_sources_per_chat: number;
  thumbs_up: number;
  thumbs_down: number;
  feedback_total: number;
  positive_feedback_rate: number;
  total_documents: number;
  indexed_documents: number;
  top_queries: StatQuery[];
  recent_chats: RecentChat[];
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

export default function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const topQueryMax = useMemo(() => {
    if (!stats?.top_queries?.length) return 1;
    return Math.max(...stats.top_queries.map((item) => item.count), 1);
  }, [stats]);

  async function loadStats() {
    try {
      const res = await fetch(`${API_BASE}/stats`, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as StatsResponse;
      setStats(data);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function boot() {
      if (!active) return;
      await loadStats();
    }

    void boot();
    const intervalId = window.setInterval(() => {
      if (active) {
        void loadStats();
      }
    }, 10000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,_#fff,_#f8fafc_35%,_#ecfeff)] px-4 py-8 text-slate-900 md:px-6">
      <div className="mx-auto max-w-6xl">
        <section className="rounded-[28px] border border-cyan-100 bg-white/90 p-6 shadow-[0_24px_80px_rgba(8,145,178,0.10)]">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-700">
                Live Stats
              </p>
              <h1 className="mt-2 font-serif text-4xl text-slate-950">
                Signals recruiters can actually inspect.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                This dashboard auto-refreshes every 10 seconds and tracks usage,
                performance, and feedback from the chat experience.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setLoading(true);
                  void loadStats();
                }}
                className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Refresh now
              </button>
              <Link
                href="/"
                className="inline-flex rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Back to chat
              </Link>
            </div>
          </div>
        </section>

        {error ? (
          <div className="mt-6 rounded-3xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-4 text-xs uppercase tracking-[0.18em] text-slate-500">
          {loading ? "Loading metrics..." : `Last updated ${lastUpdated}`}
        </div>

        <section className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              label: "Total chats",
              value: stats?.total_chats ?? 0,
              accent: "from-amber-100 to-white",
            },
            {
              label: "Avg latency",
              value: `${stats?.avg_latency_ms ?? 0} ms`,
              accent: "from-cyan-100 to-white",
            },
            {
              label: "Positive feedback",
              value: `${stats?.positive_feedback_rate ?? 0}%`,
              accent: "from-emerald-100 to-white",
            },
            {
              label: "Avg sources/chat",
              value: stats?.avg_sources_per_chat ?? 0,
              accent: "from-violet-100 to-white",
            },
          ].map((card) => (
            <article
              key={card.label}
              className={`rounded-[24px] border border-slate-200 bg-gradient-to-br ${card.accent} p-5 shadow-sm`}
            >
              <div className="text-xs uppercase tracking-[0.22em] text-slate-500">
                {card.label}
              </div>
              <div className="mt-4 text-3xl font-semibold text-slate-950">
                {loading ? "..." : card.value}
              </div>
            </article>
          ))}
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-500">
              Document coverage
            </div>
            <div className="mt-4 text-3xl font-semibold text-slate-950">
              {loading ? "..." : `${stats?.indexed_documents ?? 0}/${stats?.total_documents ?? 0}`}
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Indexed documents available for semantic search.
            </p>
          </article>

          <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-500">
              Thumbs up
            </div>
            <div className="mt-4 text-3xl font-semibold text-slate-950">
              {loading ? "..." : stats?.thumbs_up ?? 0}
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Helpful responses users explicitly approved.
            </p>
          </article>

          <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-500">
              Feedback volume
            </div>
            <div className="mt-4 text-3xl font-semibold text-slate-950">
              {loading ? "..." : stats?.feedback_total ?? 0}
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Total explicit user ratings collected so far.
            </p>
          </article>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_1.35fr]">
          <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
              Top queries
            </h2>

            <div className="mt-4 space-y-3">
              {stats?.top_queries?.length ? (
                stats.top_queries.map((item) => (
                  <div
                    key={item.query}
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-slate-900">{item.query}</div>
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        {item.count}
                      </div>
                    </div>
                    <div className="mt-3 h-2 rounded-full bg-slate-200">
                      <div
                        className="h-2 rounded-full bg-cyan-500"
                        style={{ width: `${(item.count / topQueryMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-sm text-slate-500">
                  No chat history yet. Ask a few questions in the main chat to populate
                  this view.
                </div>
              )}
            </div>
          </article>

          <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
              Recent chats
            </h2>

            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
              <div className="grid grid-cols-[1.8fr_0.6fr_0.6fr] bg-slate-50 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                <div>Query</div>
                <div>Latency</div>
                <div>Sources</div>
              </div>

              <div className="divide-y divide-slate-200">
                {stats?.recent_chats?.length ? (
                  stats.recent_chats.map((chat) => (
                    <div
                      key={chat.chat_id}
                      className="grid grid-cols-[1.8fr_0.6fr_0.6fr] gap-3 px-4 py-3 text-sm text-slate-700"
                    >
                      <div>
                        <div className="font-medium text-slate-900">{chat.message}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {new Date(chat.created_at).toLocaleString()}
                        </div>
                      </div>
                      <div>{chat.latency_ms} ms</div>
                      <div>{chat.source_count}</div>
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-8 text-sm text-slate-500">
                    No recent chats yet.
                  </div>
                )}
              </div>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
