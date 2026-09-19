"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { buildOperatingProfile } from "@/lib/intelligence/profiles";
type Result = { company: { name: string; subindustry: string | null }; profile: ReturnType<typeof buildOperatingProfile>; nextSources: string[]; pendingJobs: number };
export default function OperatingProfile({ companyId, refreshKey }: { companyId: string; refreshKey?: string | null }) {
  const [data, setData] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);
  const activeCompany = useRef<string | null>(companyId);
  const request = useRef(0);
  const loadBusy = useRef(false);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const version = ++request.current;
    loadBusy.current = true;
    try {
      const response = await fetch(`/api/headhunter/intelligence/profile?companyId=${encodeURIComponent(companyId)}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("profile_unavailable");
      const value: Result = await response.json();
      if (version === request.current && activeCompany.current === companyId && !signal?.aborted) {
        pending.current = value.pendingJobs;
        setData(value);
      }
    } catch { /* Keep the last successful profile while a refresh is unavailable. */ }
    finally { if (version === request.current) loadBusy.current = false; }
  }, [companyId]);
  useEffect(() => {
    activeCompany.current = companyId;
    pending.current = 0;
    setData(null); setMessage(""); setBusy(false);
    return () => { activeCompany.current = null; request.current++; };
  }, [companyId]);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const timer = setInterval(() => {
      if (pending.current > 0 && !loadBusy.current && document.visibilityState === "visible") void reload(controller.signal);
    }, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload, refreshKey]);
  if (!data) return null;
  return <section className="mb-6 rounded-lg border bg-[var(--surface)] p-5" aria-label="Account operating profile">
    <h2 className="western text-2xl">{data.company.name}: operating profile</h2>
    {data.company.subindustry && <p className="text-sm text-[var(--text-muted)]">{data.company.subindustry}</p>}
    <p className="my-3 text-sm">{data.profile.note}</p>
    <div className="grid gap-3 md:grid-cols-2">{data.profile.topics.filter(topic => topic.state === "supported").map(topic =>
      <details key={topic.id} className="rounded border p-3"><summary className="cursor-pointer font-medium">{topic.label} · {topic.sources.length} {topic.sources.length === 1 ? "source" : "sources"}</summary>
        {topic.sources.map(source => <div key={source.observationId} className="mt-3 text-sm">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}</a>
          <div className="text-xs text-[var(--text-muted)]">Event date: {source.eventDate?.slice(0, 10) ?? "Unknown"} · Collected {source.observedAt.slice(0, 10)}</div>
          <p className="mt-1 whitespace-pre-wrap">{source.contextPreview}{source.previewTruncated ? "…" : ""}</p>
          <span className="text-xs text-[var(--text-muted)]">Source context{source.previewTruncated ? " preview" : ""}; interpretation supported by the linked page.</span>
        </div>)}
      </details>)}</div>
    {data.profile.hypotheses.map((hypothesis, index) => <p key={index} className="mt-3 rounded border border-[var(--gold)] p-3 text-sm"><strong>Working hypothesis — unverified: </strong>{hypothesis.text}</p>)}
    {!!data.profile.unknowns.length && <p className="mt-4 text-sm text-[var(--text-muted)]"><strong>Still unknown: </strong>{data.profile.unknowns.join("; ")}.</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">{data.profile.coverage.interpreted} of {data.profile.coverage.observations} current sources interpreted.</p>
    {data.pendingJobs > 0 && <p role="status" className="mt-2 text-xs text-[var(--text-muted)]">{data.pendingJobs} evidence updates pending. This profile refreshes as processing finishes.</p>}
    {data.nextSources.length > 0 && <button disabled={busy} className="mt-4 rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => {
      setBusy(true); setMessage("");
      try {
        const response = await fetch("/api/headhunter/intelligence/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (activeCompany.current !== companyId) return;
        pending.current = result.outcomes.filter((outcome: string) => outcome === "queued").length;
        setMessage(`${result.sources} sources checked. ${pending.current} updates queued; ${result.outcomes.filter((outcome: string) => outcome === "source_failed").length} unavailable. New evidence appears here automatically.`);
        await reload();
      } catch { if (activeCompany.current === companyId) setMessage("Could not refresh research sources. Existing evidence remains available."); }
      finally { if (activeCompany.current === companyId) setBusy(false); }
    }}>{busy ? "Researching…" : "Refresh sources for research gaps"}</button>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </section>;
}
