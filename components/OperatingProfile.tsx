"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { buildOperatingProfile } from "@/lib/intelligence/profiles";
import type { readAtsHiringContext } from "@/lib/intelligence/atsLifecycle";
import AccountHiring from "./AccountHiring";
import type { ResearchRankingResult } from "@/lib/intelligence/researchRanking";
type Result = { company: { name: string; subindustry: string | null }; profile: ReturnType<typeof buildOperatingProfile>; nextSources: string[]; pendingJobs: number; hiringCoverage?: "available" | "unavailable"; researchFocus?: string; discoveredSourceCount?: number; newSourceCount?: number; hiring?: Awaited<ReturnType<typeof readAtsHiringContext>> | null };
export default function OperatingProfile({ companyId, active = true, refreshKey }: { companyId: string; active?: boolean; refreshKey?: string | null }) {
  const [findingsOpen, setFindingsOpen] = useState(false), [findingsLimit, setFindingsLimit] = useState(20);
  const [data, setData] = useState<Result | null>(null);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ranking, setRanking] = useState<ResearchRankingResult | null>(null);
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
        setData(value); setLoadError("");
      }
    } catch { if (!signal?.aborted && version === request.current) setLoadError("The operating profile could not refresh. Previously loaded research remains available."); }
    finally { if (version === request.current) loadBusy.current = false; }
  }, [companyId]);
  useEffect(() => {
    activeCompany.current = companyId;
    pending.current = 0;
    setData(null); setLoadError(""); setFindingsOpen(false); setFindingsLimit(20); setMessage(""); setBusy(false); setRanking(null);
    return () => { activeCompany.current = null; request.current++; };
  }, [companyId]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void reload(controller.signal);
    const timer = setInterval(() => {
      if (pending.current > 0 && !loadBusy.current && document.visibilityState === "visible") void reload(controller.signal);
    }, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload, refreshKey, active]);
  if (!data) return <section aria-label="Account operating profile" className="mb-6 rounded-lg border p-5"><h2 className="western text-2xl">Operating profile and hiring</h2><p role="status" className="mt-3 text-sm text-[var(--text-muted)]">{loadError || "Loading operating profile and hiring coverage…"}</p></section>;
  return <section className="mb-6 rounded-lg border bg-[var(--surface)] p-5" aria-label="Account operating profile">
    <h2 className="western text-2xl">{data.company.name}: operating profile</h2>
    {data.company.subindustry && <p className="text-sm text-[var(--text-muted)]">{data.company.subindustry}</p>}
    {loadError && <p role="status" className="mt-2 text-sm text-[var(--gold)]">{loadError}</p>}
    <p className="my-3 text-sm">{data.profile.note}</p>
    {data.researchFocus && <p className="mb-3 text-xs text-[var(--text-muted)]">Research focus: {data.company.subindustry || "Business services"}</p>}
    <div className="grid gap-3 md:grid-cols-2">{data.profile.topics.filter(topic => topic.state === "supported").map(topic =>
      <details key={topic.id} className="rounded border p-3"><summary className="cursor-pointer font-medium">{topic.label} · {topic.sources.length} {topic.sources.length === 1 ? "source" : "sources"}</summary>
        {topic.sources.map(source => <div key={source.observationId} className="mt-3 text-sm">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}</a>
          <div className="text-xs text-[var(--text-muted)]">Event date: {source.eventDate?.slice(0, 10) ?? "Unknown"} · Collected {source.observedAt.slice(0, 10)}</div>
          <p className="mt-1 whitespace-pre-wrap">{source.contextPreview}{source.previewTruncated ? "…" : ""}</p>
          <span className="text-xs text-[var(--text-muted)]">Source context{source.previewTruncated ? " preview" : ""}; interpretation supported by the linked page.</span>
        </div>)}
      </details>)}</div>
    {data.profile.findings?.length > 0 && <details className="mt-4 rounded border p-3" open={findingsOpen} onToggle={event => setFindingsOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold">Jev findings · {data.profile.findings.length} stored interpretations</summary><p className="mt-2 text-xs text-[var(--text-muted)]">Original packet judgments include useful account context with unknown or historical event dates. A finding does not always qualify for a timely trigger card.</p><div className="mt-3 space-y-3">{findingsOpen && [...data.profile.findings].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, findingsLimit).map(finding => <article key={finding.id} className="rounded border p-3 text-sm"><a href={finding.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{finding.title}</a><p className="mt-1 text-xs text-[var(--text-muted)]">{finding.dateState === "unknown" ? "Event date unknown" : finding.dateState === "historical" ? "Historical event" : finding.dateState === "future" ? "Future event date" : "Dated event"}{finding.eventDate ? " · " + finding.eventDate.slice(0, 10) : ""} · Captured {finding.observedAt.slice(0, 10)}</p>{typeof finding.excerpt === "string" && <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--gold)] pl-3">{finding.excerpt}</blockquote>}<details className="mt-2"><summary className="cursor-pointer text-xs">Original Jev output and publication result</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(finding, null, 2)}</pre></details></article>)}{findingsOpen && data.profile.findings.length > findingsLimit && <button type="button" className="rounded border px-3 py-2 text-xs" onClick={() => setFindingsLimit(value => value + 20)}>Load more Jev findings ({findingsLimit} of {data.profile.findings.length} shown)</button>}</div></details>}
    {data.profile.hypotheses.map((hypothesis, index) => <p key={index} className="mt-3 rounded border border-[var(--gold)] p-3 text-sm"><strong>Working hypothesis — unverified: </strong>{hypothesis.text}</p>)}
    {!!data.profile.unknowns.length && <p className="mt-4 text-sm text-[var(--text-muted)]"><strong>Still unknown: </strong>{data.profile.unknowns.join("; ")}.</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">{data.profile.coverage.interpreted} of {data.profile.coverage.observations} current sources interpreted.</p>
    <AccountHiring hiring={data.hiring} coverage={data.hiringCoverage} />
    {data.newSourceCount !== undefined && <p className="mt-2 text-xs text-[var(--text-muted)]">{data.newSourceCount} discovered sources not yet read{data.discoveredSourceCount !== undefined ? ` of ${data.discoveredSourceCount} available next sources` : ""}.</p>}
    {data.pendingJobs > 0 && <p role="status" className="mt-2 text-xs text-[var(--text-muted)]">{data.pendingJobs} evidence updates pending. This profile refreshes as processing finishes.</p>}
    {data.nextSources.length > 0 && <button disabled={busy} className="mt-4 rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => {
      setBusy(true); setMessage("");
      try {
        const response = await fetch("/api/headhunter/intelligence/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (activeCompany.current !== companyId) return;
        setRanking(result.ranking ?? null);
        pending.current = result.outcomes.filter((outcome: string) => outcome === "queued").length;
        const retryAt = result.nextAttemptAt && Number.isFinite(Date.parse(result.nextAttemptAt)) ? new Date(result.nextAttemptAt).toLocaleString() : null;
        setMessage(result.outcome === "deadline_deferred" ? "Research was deferred before reading sources. Try again later; saved evidence is unchanged."
          : result.outcome === "sources_leased" ? "These sources are already being researched. Results will appear when that work finishes."
          : result.outcome === "no_sources_due" ? "No sources are due for another read" + (retryAt ? " until " + retryAt : " yet") + ". Unknown traits remain unknown."
          : `${result.sources} sources checked. ${pending.current} updates queued; ${result.outcomes.filter((outcome: string) => outcome === "source_failed").length} unavailable; ${result.outcomes.filter((outcome: string) => outcome === "source_empty").length} empty. New evidence appears here as processing finishes.`);
        await reload();
      } catch { if (activeCompany.current === companyId) setMessage("Could not refresh research sources. Existing evidence remains available."); }
      finally { if (activeCompany.current === companyId) setBusy(false); }
    }}>{busy ? "Researching…" : "Research next sources"}</button>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    {ranking?.providerUsed && <details className="mt-3 rounded border p-3 text-xs"><summary className="cursor-pointer">Jev research selection · original output</summary><p className="mt-2 text-[var(--text-muted)]">Jev rates which supplied links to read next. This is research usefulness, not buying intent.</p><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(ranking, null, 2)}</pre></details>}
  </section>;
}
