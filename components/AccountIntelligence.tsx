"use client";
import { useEffect, useState } from "react";
import type { AccountStory, StoryClaim, StorySource } from "@/lib/intelligence/narratives";
import type { IntelligenceEvent } from "@/lib/intelligence/events";

type Version = { id: string; story: AccountStory | null; created_at: string; current: boolean; invalidatedByFeedback: boolean;
  coverage: { sources?: StorySource[]; includedCurrent?: number; availableCurrent?: number; requestLimited?: boolean } };
type Memory = { processingEnabled: boolean; events: IntelligenceEvent[]; story: Version | null; history: Version[];
  coverage: { storyJob: { status: string; last_error: string | null } | null } };
const endpoint = "/api/headhunter/intelligence/story";
function safeUrl(value: string) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
function Claims({ items, sources, hypothesis = false }: { items: StoryClaim[]; sources: StorySource[]; hypothesis?: boolean }) {
  return <div className="space-y-3">{items.map((item, index) => <div key={index}>
    <p className="text-sm leading-relaxed">{hypothesis && <strong>Working hypothesis: </strong>}{item.text}</p>
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">{item.citations.map(id => {
      const source = sources.find(value => value.id === id);
      return source && <a key={id} href={safeUrl(source.url)} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}{source.eventDate ? ` · ${source.eventDate.slice(0, 10)}` : ""}{!source.current ? " · historical" : ""}</a>;
    })}</div>
  </div>)}</div>;
}
function StoryBody({ version }: { version: Version }) {
  const story = version.story, sources = version.coverage.sources ?? [];
  if (!story) return <p className="text-sm text-[var(--text-muted)]">This version referenced evidence you excluded.</p>;
  return <div className="mt-3 space-y-4">
    <Claims items={story.overview} sources={sources} />
    {story.developments.length > 0 && <div><h4 className="mb-2 font-semibold">What changed</h4><Claims items={story.developments} sources={sources} /></div>}
    {story.hypotheses.length > 0 && <div className="rounded border border-[var(--gold)] p-3"><p className="mb-2 text-xs text-[var(--text-muted)]">Operational hypotheses to explore; these are not confirmed pain or buying intent.</p><Claims items={story.hypotheses} sources={sources} hypothesis /></div>}
    {story.contradictions.length > 0 && <div><h4 className="mb-2 font-semibold">Conflicting source claims</h4>{story.contradictions.map((conflict, i) => <div key={i} className="mb-3"><p className="text-xs font-semibold">{conflict.topic}</p><Claims items={[{ text: conflict.description, citations: conflict.citations }]} sources={sources} /></div>)}</div>}
    {story.unknowns.length > 0 && <p className="text-sm text-[var(--text-muted)]"><strong>Still unknown: </strong>{story.unknowns.join("; ")}</p>}
    <p className="text-xs text-[var(--text-muted)]">Written from {version.coverage.includedCurrent ?? sources.filter(source => source.current).length} current source excerpts{typeof version.coverage.availableCurrent === "number" ? ` of ${version.coverage.availableCurrent} available` : ""}{version.coverage.requestLimited ? "; additional evidence remains outside this version" : ""}. Jev’s original judgments remain in the evidence feed.</p>
  </div>;
}
export default function AccountIntelligence({ companyId, active = true, refreshKey }: { companyId: string; active?: boolean; refreshKey?: string | null }) {
  const [data, setData] = useState<Memory | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [message, setMessage] = useState("");
  useEffect(() => { setData(null); setMessage(""); }, [companyId]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${endpoint}?companyId=${encodeURIComponent(companyId)}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const next: Memory = await response.json();
        if (!abort.signal.aborted) { setData(next); setError(""); }
      } catch { if (!abort.signal.aborted) setError("Account research is temporarily unavailable."); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [companyId, refreshKey, refresh, active]);
  async function requestStory() {
    if (!data?.processingEnabled || busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId }) });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setMessage(result.queued ? "Account story queued. It will appear here as writing finishes." : "No new story queued. Existing research is current, or more interpreted evidence is needed.");
      setRefresh(value => value + 1);
    } catch { setMessage("Could not request the account story. Your saved evidence remains available."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Account research and developments" className="mb-6 rounded-lg border bg-[var(--surface)] p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="western text-2xl">Account story and developments</h2><button type="button" disabled={busy || !data?.processingEnabled} onClick={() => void requestStory()} className="rounded border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Requesting…" : data?.story ? "Update account story" : "Write account story"}</button></div>
    {data?.processingEnabled === false && <p className="mt-2 text-xs text-[var(--text-muted)]">New account writing is paused. Saved stories and developments remain available.</p>}
    {error && <p className="mt-2 text-sm" role="status">{error}</p>}
    {message && <p className="mt-2 text-sm" role="status">{message}</p>}
    {!data && !error && <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">Loading saved account story and developments…</p>}
    {data?.story ? <><p className="mt-2 text-xs text-[var(--text-muted)]">Written {new Date(data.story.created_at).toLocaleString()}{!data.story.current ? " · New evidence is awaiting an updated story" : ""}</p><StoryBody version={data.story} /></> : <p className="mt-3 text-sm text-[var(--text-muted)]">No saved account story is available yet. A story requires interpreted evidence; collecting, interpreting and writing are separate steps.</p>}
    {data?.processingEnabled && data.coverage.storyJob && ["queued", "running"].includes(data.coverage.storyJob.status) && <p role="status" className="mt-3 text-xs text-[var(--text-muted)]">Story {data.coverage.storyJob.status === "running" ? "being written" : "queued"}{data.coverage.storyJob.last_error === "budget_deferred" ? " for the next available budget" : ""}.</p>}
    {!!data?.events.length && <div className="mt-5 border-t pt-4"><h3 className="mb-3 font-semibold">Developments and reports</h3>{data.events.map(event => <details key={event.id} className="mb-2 rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{event.title} <span className="font-normal text-[var(--text-muted)]">· {event.event_date?.slice(0, 10) ?? "Date unknown"} · {event.evidence_count} reports</span></summary>{event.sources?.filter(source => !source.excluded).map(source => <div key={source.observationId} className="mt-3 text-sm"><a href={safeUrl(source.url)} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}</a><p className="mt-1 text-xs text-[var(--text-muted)]">{source.current ? "Current source" : "Earlier source version"} · captured {source.observedAt.slice(0, 10)}</p>{source.excerpt && <p className="mt-1 whitespace-pre-wrap">{source.excerpt}</p>}</div>)}</details>)}</div>}
    {data && data.history.length > 1 && <details className="mt-5 border-t pt-4"><summary className="cursor-pointer text-sm font-semibold">Previous account stories</summary>{data.history.slice(1).map(version => <details key={version.id} className="mt-3 rounded border p-3"><summary className="cursor-pointer text-sm">{new Date(version.created_at).toLocaleString()} · historical version</summary><StoryBody version={version} /></details>)}</details>}
  </section>;
}
