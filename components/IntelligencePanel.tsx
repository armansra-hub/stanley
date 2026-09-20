"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import AccountResearchPanel from "./AccountResearchPanel";
import OperatingMatches from "./OperatingMatches";
import IntelligenceHealth, { type IntelligenceHealthData } from "./IntelligenceHealth";
import IntelligenceCost from "./IntelligenceCost";
import type { JevCostSnapshot } from "@/lib/intelligence/costMetricsTypes";
import { EvidenceCard, type FeedbackReason, type Observation } from "./IntelligenceEvidenceCard";

type SavedView = { id: string; name: string; question: string; active: boolean; backfill_complete: boolean };
type AccountMatch = { company_id: string; company_name: string; probability: number; evaluated_at: string;
  result: { native: unknown; coverage: unknown; citations: Array<{ observationId: string; url: string; title: string; date: string | null; text: string }> } };
type IntelligenceData = {
  enabled: boolean;
  views: SavedView[];
  observations: Observation[];
  accountMatches?: AccountMatch[];
  accountQuestionPending?: number;
  hasMore: boolean;
  spend: { available?: boolean; usedUsd: number; reservedUsd: number; limitUsd: number };
  jobs: { queued: number; running: number; failed: number };
  sourceCoverage: { complete: number; partial: number; failed: number; empty?: number; unavailable?: number; unsupported?: number; unknown?: number; withWarnings?: number; accountsWithSuccess48h?: number; scope?: string };
  health?: IntelligenceHealthData;
  jevCost?: JevCostSnapshot;
};

const API = "/api/headhunter/intelligence";
const buttonClass = "rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--surface-2)] disabled:cursor-wait disabled:opacity-50";
const fieldClass = "w-full rounded-md border bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--gold)] disabled:opacity-50";
function dollars(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "Unknown";
}

export default function IntelligencePanel({ companyId, initialViewId }: { companyId?: string; initialViewId?: string }) {
  const [frames, setFrames] = useState<Array<{ id: string; name: string }>>(companyId ? [{ id: companyId, name: "Account intelligence" }] : []);
  const openAccount = (id: string, name: string) => setFrames(previous => previous.at(-1)?.id === id ? previous : [...previous, { id, name }]);
  return <>
    <div hidden={frames.length > 0}><GlobalIntelligencePanel active={frames.length === 0} initialViewId={initialViewId} onOpenAccount={openAccount} /></div>
    {frames.map((frame, index) => <div key={index + ":" + frame.id} hidden={index !== frames.length - 1} className="fixed inset-0 z-20 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto max-w-5xl p-5"><header className="sticky top-0 z-10 mb-4 border-b bg-[var(--background)] pb-3"><button type="button" className="mb-3 text-sm text-[var(--gold)]" onClick={() => setFrames(previous => previous.slice(0, -1))}>← Back to {index ? frames[index - 1].name : "Intelligence"}</button><h1 className="western text-3xl">{frame.name}</h1></header>
        <AccountResearchPanel companyId={frame.id} active={index === frames.length - 1} onOpenAccount={openAccount} />
      </div>
    </div>)}
  </>;
}
function GlobalIntelligencePanel({ active, initialViewId, onOpenAccount }: { active: boolean; initialViewId?: string; onOpenAccount: (id: string, name: string) => void }) {
  const companyId: string | undefined = undefined;
  const [viewId, setViewId] = useState(initialViewId ?? "");
  const [dismissed, setDismissed] = useState(false);
  const [snapshot, setSnapshot] = useState<{ key: string; data: IntelligenceData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const [fallbackCost, setFallbackCost] = useState<JevCostSnapshot>();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const requestId = useRef(0);
  const requestBusy = useRef(false);
  const key = `${companyId ?? ""}:${viewId}:${dismissed}`;
  const data = snapshot?.key === key ? snapshot.data : null;
  const views = (data ?? snapshot?.data)?.views.filter(view => view.active) ?? [];
  const selectedView = views.find(view => view.id === viewId);
  const questionBytes = new TextEncoder().encode(question.trim()).length;

  const load = useCallback(async (offset = 0, quiet = false): Promise<IntelligenceData | null> => {
    const current = ++requestId.current;
    requestBusy.current = true;
    if (!quiet) setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (companyId) params.set("companyId", companyId);
    if (viewId) params.set("viewId", viewId);
    if (dismissed) params.set("dismissed", "true");
    if (offset) params.set("offset", String(offset));
    try {
      const response = await fetch(`${API}?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("load_failed");
      const next: IntelligenceData = await response.json();
      if (!Array.isArray(next.views) || !Array.isArray(next.observations)) throw new Error("invalid_response");
      if (current !== requestId.current) return null;
      setSnapshot(previous => {
        if (!offset || previous?.key !== key) return { key, data: next };
        const seen = new Set(previous.data.observations.map(item => item.id));
        const seenAccounts = new Set(previous.data.accountMatches?.map(item => item.company_id) ?? []);
        return { key, data: { ...next, observations: [...previous.data.observations, ...next.observations.filter(item => !seen.has(item.id))],
          accountMatches: [...(previous.data.accountMatches ?? []), ...(next.accountMatches ?? []).filter(item => !seenAccounts.has(item.company_id))] } };
      });
      setUpdatedAt(new Date().toISOString());
      return next;
    } catch {
      if (current === requestId.current) {
        setError("Could not load intelligence. Try Refresh to get the latest findings.");
        try {
          const costResponse = await fetch(`${API}/cost`, { cache: "no-store" });
          const cost: JevCostSnapshot = costResponse.ok ? await costResponse.json() : { available: false };
          if (current === requestId.current) setFallbackCost(cost);
        } catch { if (current === requestId.current) setFallbackCost({ available: false }); }
      }
      return null;
    } finally {
      if (current === requestId.current) { setLoading(false); requestBusy.current = false; }
    }
  }, [companyId, viewId, dismissed, key]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => { requestId.current += 1; requestBusy.current = false; };
  }, [load, active]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !requestBusy.current && !mutating) void load(0, true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [load, mutating, active]);

  async function mutate(body: Record<string, unknown>, message: string): Promise<Record<string, unknown> | null> {
    if (mutating) return null;
    setMutating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("save_failed");
      const result: Record<string, unknown> = await response.json().catch(() => ({}));
      setNotice(message);
      await load();
      return result;
    } catch {
      setError("Could not save this change. Refresh to check its current status before trying again.");
      return null;
    } finally { setMutating(false); }
  }

  async function saveView(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || question.trim().length < 8 || questionBytes > 1_200) return;
    const result = await mutate({ action: "save_view", name: name.trim(), question: question.trim() }, "View saved. Matching evidence will appear as it is processed.");
    if (result) {
      const createdId = result.viewId ?? result.id;
      if (typeof createdId === "string") setViewId(createdId);
      setName(""); setQuestion("");
    }
  }

  async function archiveView() {
    const result = await mutate({ action: "archive_view", viewId }, "View archived.");
    if (result) setViewId("");
  }

  const busy = loading || mutating;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/headhunter" className="mb-3 inline-block text-sm text-[var(--gold)] hover:underline">← Back to Triggered</Link>
          <h1 className="western text-4xl sm:text-5xl">Intelligence</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">Find the business changes that matter. Save a research question and build a living view of the evidence.</p>
        </div>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button>
      </header>

      {error && <div role="alert" className="mb-4 rounded-lg border border-[var(--accent)] bg-[var(--surface)] p-3 text-sm">{error}</div>}
      {notice && <div role="status" className="mb-4 rounded-lg border bg-[var(--surface)] p-3 text-sm text-[var(--gold)]">{notice}</div>}
      {data && !data.enabled && <div className="mb-5 rounded-lg border border-[var(--gold)] bg-[var(--surface)] p-4">
        <h2 className="font-semibold text-[var(--gold)]">Intelligence setup is pending</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">The background engine has not been enabled yet. Existing evidence appears below when available.</p>
      </div>}

      {data && <section aria-label="Intelligence activity" className="mb-6 grid gap-px overflow-hidden rounded-lg border bg-[var(--border)] text-sm sm:grid-cols-3">
        <div className="bg-[var(--surface)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Global monthly budget accounting</div>
          {data.spend.available === false ? <p className="mt-1 text-sm text-[var(--text-muted)]">Global budget details are unavailable.</p> : <>
            <div className="mt-1"><strong className="text-lg">{dollars(data.spend.usedUsd)}</strong><span className="text-[var(--text-muted)]"> accounted against {dollars(data.spend.limitUsd)}</span></div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">{dollars(data.spend.reservedUsd)} reserved for work in progress</div>
          </>}
          <div className="mt-1 text-xs text-[var(--text-muted)]">All intelligence models; includes conservative allowances when usage is unknown.</div>
        </div>
        <div className="bg-[var(--surface)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Global evidence / view jobs</div>
          <div className="mt-1 text-lg"><strong>{data.jobs.queued.toLocaleString()}</strong> queued <span className="text-[var(--text-muted)]">· {data.jobs.running.toLocaleString()} running</span></div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">{data.jobs.failed ? `${data.jobs.failed.toLocaleString()} failed` : "No failed jobs"}</div>
        </div>
        <div className="bg-[var(--surface)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">TAM source checkpoints</div>
          <div className="mt-1 text-lg"><strong>{data.sourceCoverage.complete.toLocaleString()}</strong> complete checks</div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">{data.sourceCoverage.partial.toLocaleString()} partial with saved content · {(data.sourceCoverage.unavailable ?? data.sourceCoverage.failed).toLocaleString()} unavailable</div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{data.sourceCoverage.empty !== undefined ? data.sourceCoverage.empty.toLocaleString() + " quiet / empty · " : ""}{data.sourceCoverage.unsupported !== undefined ? data.sourceCoverage.unsupported.toLocaleString() + " unsupported · " : ""}{data.sourceCoverage.unknown !== undefined ? data.sourceCoverage.unknown.toLocaleString() + " unknown" : ""}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Checkpoints are company/source pairs, not accounts.{data.sourceCoverage.withWarnings ? ` ${data.sourceCoverage.withWarnings.toLocaleString()} checks saved content with warnings.` : ""}{data.sourceCoverage.accountsWithSuccess48h !== undefined ? " " + data.sourceCoverage.accountsWithSuccess48h.toLocaleString() + " distinct TAM accounts checked successfully in 48 hr." : ""} Partial means usable content was saved; depth can still be in progress.</p>
        </div>
      </section>}

      {data?.health && <IntelligenceHealth health={data.health} />}
      <IntelligenceCost cost={data?.jevCost ?? fallbackCost} />
      <OperatingMatches onOpenAccount={onOpenAccount} enabled={data?.enabled === true} refreshKey={updatedAt} />
      <section className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5" aria-labelledby="new-view-heading">
        <h2 id="new-view-heading" className="western text-2xl">Follow a question</h2>
        <form onSubmit={saveView} className="mt-3 space-y-3">
          <label className="block text-sm">Research question
            <textarea value={question} onChange={event => setQuestion(event.target.value)} minLength={8} maxLength={600} rows={2} required disabled={!data?.enabled || mutating}
              placeholder="Which companies show evidence of adding facilities, entities, or complex project billing?"
              aria-describedby="question-help" className={`${fieldClass} mt-1 resize-y`} />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1 text-sm">View name
              <input value={name} onChange={event => setName(event.target.value)} maxLength={80} required disabled={!data?.enabled || mutating} placeholder="Expansion and complexity" className={`${fieldClass} mt-1`} />
            </label>
            <button type="submit" disabled={!data?.enabled || busy || !name.trim() || question.trim().length < 8 || questionBytes > 1_200} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">Save view</button>
          </div>
          <p id="question-help" className={`text-xs ${questionBytes > 1_200 ? "text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{questionBytes > 1_200 ? "Please shorten the question; it exceeds the text limit." : "Jev combines relevant passages across each account’s sources. Results show its native answer, supporting passages and research coverage."}</p>
        </form>
      </section>

      <section aria-labelledby="findings-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="findings-heading" className="western text-2xl">{companyId ? "Account evidence" : "Evidence feed"}</h2>
            {companyId && <Link href="/headhunter/intelligence" className="text-xs text-[var(--gold)] hover:underline">Show all accounts</Link>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="intelligence-view" className="text-xs text-[var(--text-muted)]">View</label>
            <select id="intelligence-view" value={viewId} disabled={busy} onChange={event => { setViewId(event.target.value); setNotice(null); }} className="max-w-full rounded-md border bg-[var(--surface)] px-3 py-2 text-sm sm:max-w-72">
              <option value="">All evidence</option>
              {viewId && !selectedView && <option value={viewId}>Selected view</option>}
              {views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
            {selectedView && <button type="button" onClick={() => void archiveView()} disabled={busy} className={buttonClass}>Archive view</button>}
            <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><input type="checkbox" checked={dismissed} disabled={busy} onChange={event => setDismissed(event.target.checked)} />Review dismissed evidence</label>
          </div>
        </div>
        {selectedView && <div className="mb-4 rounded-lg border bg-[var(--surface-2)] px-4 py-3 text-sm">
          <p>{selectedView.question}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{selectedView.backfill_complete ? "Account evidence queued for matching. Results appear as processing completes." : "Historical evidence is still being queued. Results are incomplete."} {data?.accountQuestionPending ?? 0} accounts awaiting an updated answer. Source dates show how old the evidence is.</p>
        </div>}
        <div aria-live="polite" className="mb-3 text-xs text-[var(--text-muted)]">
          {loading ? "Loading evidence…" : data ? viewId ? `${(data.accountMatches?.length ?? 0).toLocaleString()} account answers loaded` : `${data.observations.length.toLocaleString()} evidence items loaded` : "Evidence has not loaded yet."}
          {updatedAt && ` · Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          <span className="ml-1">· Refreshes every minute while open</span>
        </div>
        {data?.observations.length === 0 && !data?.accountMatches?.length && <div className="rounded-lg border border-dashed bg-[var(--surface)] px-6 py-12 text-center">
          <h3 className="text-lg font-medium">{dismissed ? "No dismissed evidence in this view" : viewId ? "No matching evidence yet" : "No evidence captured yet"}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">{viewId ? "Matches will appear as source research and this view’s background processing complete." : "The feed will fill as sources are collected and processed."}</p>
        </div>}
        <div className="space-y-4">
          {viewId && data?.accountMatches?.map(match => <article key={match.company_id} className="rounded-lg border bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><button className="font-semibold text-[var(--gold)]" onClick={() => onOpenAccount(match.company_id, match.company_name)}>{match.company_name} →</button><span className="text-sm">Jev: {(match.probability * 100).toFixed(1)}% match</span></div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Native answer combining the account’s selected evidence · {new Date(match.evaluated_at).toLocaleString()}</p>
            <div className="mt-3 space-y-2">{(match.result.citations ?? []).map((citation, index) => <details key={`${citation.observationId}:${index}`} className="rounded border p-2 text-xs"><summary className="cursor-pointer">{citation.title}{citation.date ? ` · ${citation.date.slice(0, 10)}` : " · date unknown"}</summary><p className="mt-2 whitespace-pre-wrap">{citation.text}</p><a href={citation.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[var(--gold)]">Open source</a></details>)}</div>
            <details className="mt-3 text-xs"><summary className="cursor-pointer text-[var(--gold)]">Raw Jev answer and coverage</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ native: match.result.native, coverage: match.result.coverage }, null, 2)}</pre></details>
          </article>)}
          {data?.observations.map(observation => <EvidenceCard key={observation.id} observation={observation} busy={busy} onOpenAccount={onOpenAccount} onFeedback={async (reason, note) => {
            const result = await mutate({ action: reason === null ? "clear_feedback" : "feedback", observationId: observation.id, reason, ...(note.trim() ? { note: note.trim() } : {}) }, reason === null ? "Feedback cleared; evidence restored." : "Feedback saved.");
            return Boolean(result);
          }} />)}
        </div>
        {data?.hasMore && <div className="mt-5 text-center"><button type="button" disabled={busy} className={buttonClass} onClick={() => void load(viewId ? data.accountMatches?.length ?? 0 : data.observations.length)}>{loading ? "Loading…" : viewId ? "Load more accounts" : "Load more evidence"}</button></div>}
      </section>
    </main>
  );
}
