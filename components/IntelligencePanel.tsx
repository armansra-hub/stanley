"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import OperatingProfile from "./OperatingProfile";
import OperatingMatches from "./OperatingMatches";
import IntelligenceHealth, { type IntelligenceHealthData } from "./IntelligenceHealth";
import AccountIntelligence from "./AccountIntelligence";
import AccountLookalikes from "./AccountLookalikes";

type FeedbackReason = "useful" | "wrong_company" | "old_event" | "irrelevant" | "not_now";
type SavedView = { id: string; name: string; question: string; active: boolean; backfill_complete: boolean };
type Observation = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  source_kind: string;
  source_url: string | null;
  title: string | null;
  event_date: string | null;
  observed_at: string;
  attributes: {
    [key: string]: unknown;
    signalType?: string;
    signalTypes?: string[];
    companyRelationship?: string;
    evidenceExcerpt?: string | null;
    operationalComplexity?: number;
    requiresResearch?: number;
  } | null;
  matchProbability?: number;
  feedback?: { reason: FeedbackReason; note?: string | null } | null;
  feedback_excluded?: boolean;
  public_priority_weight?: number;
};
type IntelligenceData = {
  enabled: boolean;
  views: SavedView[];
  observations: Observation[];
  hasMore: boolean;
  spend: { usedUsd: number; reservedUsd: number; limitUsd: number };
  jobs: { queued: number; running: number; failed: number };
  sourceCoverage: { complete: number; partial: number; failed: number };
  health?: IntelligenceHealthData;
};

const API = "/api/headhunter/intelligence";
const buttonClass = "rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--surface-2)] disabled:cursor-wait disabled:opacity-50";
const fieldClass = "w-full rounded-md border bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--gold)] disabled:opacity-50";
const feedbackOptions: [FeedbackReason, string][] = [
  ["useful", "Useful"], ["wrong_company", "Wrong company"], ["old_event", "Old event"],
  ["irrelevant", "Not relevant"], ["not_now", "Not now"],
];
const signalLabels: Record<string, string> = {
  funding: "Funding", new_entity: "New entity", ma: "Acquisition", gov_contract: "Government contract",
  finance_hire: "Finance hiring", press: "Expansion", erp_tech: "ERP / systems", hiring_velocity: "Hiring growth",
  employee_growth: "Employee growth", federal_award: "Federal award", federal_subaward: "Federal subaward",
  sam_award_notice: "SAM award notice", operating_change: "Operating change", news: "Company news", none: "No specific development",
};

function sourceLink(value: string | null): { url: string; host: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? { url: url.href, host: url.hostname.replace(/^www\./, "") } : null;
  } catch { return null; }
}

function dateLabel(value: string | null, captured = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Date(value).toLocaleString(undefined, captured
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ageLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Event age unknown";
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  if (days < 0) return "Future event date";
  if (days === 0) return "Today";
  return `${days.toLocaleString()} ${days === 1 ? "day" : "days"} ago${days >= 90 ? " · Historical" : ""}`;
}

function dollars(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "Unknown";
}

function probability(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : null;
}

export default function IntelligencePanel({ companyId, initialViewId }: { companyId?: string; initialViewId?: string }) {
  const [viewId, setViewId] = useState(initialViewId ?? "");
  const [dismissed, setDismissed] = useState(false);
  const [snapshot, setSnapshot] = useState<{ key: string; data: IntelligenceData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
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
        return { key, data: { ...next, observations: [...previous.data.observations, ...next.observations.filter(item => !seen.has(item.id))] } };
      });
      setUpdatedAt(new Date().toISOString());
      return next;
    } catch {
      if (current === requestId.current) setError("Could not load intelligence. Try Refresh to get the latest findings.");
      return null;
    } finally {
      if (current === requestId.current) { setLoading(false); requestBusy.current = false; }
    }
  }, [companyId, viewId, dismissed, key]);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; requestBusy.current = false; };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !requestBusy.current && !mutating) void load(0, true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [load, mutating]);

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
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Monthly intelligence budget</div>
          <div className="mt-1"><strong className="text-lg">{dollars(data.spend.usedUsd)}</strong><span className="text-[var(--text-muted)]"> used of {dollars(data.spend.limitUsd)}</span></div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">{dollars(data.spend.reservedUsd)} reserved for work in progress</div>
        </div>
        <div className="bg-[var(--surface)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Background work</div>
          <div className="mt-1 text-lg"><strong>{data.jobs.queued.toLocaleString()}</strong> queued <span className="text-[var(--text-muted)]">· {data.jobs.running.toLocaleString()} running</span></div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">{data.jobs.failed ? `${data.jobs.failed.toLocaleString()} failed` : "No failed jobs"}</div>
        </div>
        <div className="bg-[var(--surface)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Source coverage</div>
          <div className="mt-1 text-lg"><strong>{data.sourceCoverage.complete.toLocaleString()}</strong> complete</div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">{data.sourceCoverage.partial.toLocaleString()} partial · {data.sourceCoverage.failed.toLocaleString()} failed</div>
        </div>
      </section>}

      {data?.health && <IntelligenceHealth health={data.health} />}
      {companyId && data?.enabled && <OperatingProfile companyId={companyId} refreshKey={updatedAt} />}
      {companyId && data?.enabled && <AccountIntelligence key={`story:${companyId}`} companyId={companyId} refreshKey={updatedAt} />}
      {companyId && data?.enabled && <AccountLookalikes key={`similar:${companyId}`} companyId={companyId} refreshKey={updatedAt} />}
      <OperatingMatches enabled={data?.enabled === true} refreshKey={updatedAt} />
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
          <p id="question-help" className={`text-xs ${questionBytes > 1_200 ? "text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{questionBytes > 1_200 ? "Please shorten the question; it exceeds the text limit." : "Saved questions match one source at a time as processing completes. Use operating matches above to combine traits across an account’s sources."}</p>
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
          <p className="mt-1 text-xs text-[var(--text-muted)]">{selectedView.backfill_complete ? "Historical evidence queued for matching. Results appear as processing completes." : "Historical evidence is still being queued. Results are incomplete."} Event dates show how old each match is.</p>
        </div>}
        <div aria-live="polite" className="mb-3 text-xs text-[var(--text-muted)]">
          {loading ? "Loading evidence…" : data ? `${data.observations.length.toLocaleString()} findings loaded` : "Evidence has not loaded yet."}
          {updatedAt && ` · Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          <span className="ml-1">· Refreshes every minute while open</span>
        </div>
        {data?.observations.length === 0 && <div className="rounded-lg border border-dashed bg-[var(--surface)] px-6 py-12 text-center">
          <h3 className="text-lg font-medium">{dismissed ? "No dismissed evidence in this view" : viewId ? "No matching evidence yet" : "No evidence captured yet"}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">{viewId ? "Matches will appear as source research and this view’s background processing complete." : "The feed will fill as sources are collected and processed."}</p>
        </div>}
        <div className="space-y-4">
          {data?.observations.map(observation => <EvidenceCard key={observation.id} observation={observation} busy={busy} onFeedback={async (reason, note) => {
            const result = await mutate({ action: reason === null ? "clear_feedback" : "feedback", observationId: observation.id, reason, ...(note.trim() ? { note: note.trim() } : {}) }, reason === null ? "Feedback cleared; evidence restored." : "Feedback saved.");
            return Boolean(result);
          }} />)}
        </div>
        {data?.hasMore && <div className="mt-5 text-center"><button type="button" disabled={busy} className={buttonClass} onClick={() => void load(data.observations.length)}>{loading ? "Loading…" : "Load more evidence"}</button></div>}
      </section>
    </main>
  );
}

function EvidenceCard({ observation, busy, onFeedback }: {
  observation: Observation;
  busy: boolean;
  onFeedback: (reason: FeedbackReason | null, note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState(observation.feedback?.note ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const attributes = observation.attributes;
  const source = sourceLink(observation.source_url);
  const signals = [...new Set(attributes?.signalTypes ?? (attributes?.signalType ? [attributes.signalType] : []))];
  const match = probability(observation.matchProbability);
  const relationship = attributes?.companyRelationship;
  const relationshipLabel = relationship === "direct" ? "Company itself" : relationship === "related" ? "Related company" : relationship === "unrelated" ? "Different company" : "Company relationship unknown";
  return <article className="rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        {observation.company_id ? <Link className="text-sm font-semibold text-[var(--gold)] hover:underline" href={`/headhunter/intelligence?companyId=${encodeURIComponent(observation.company_id)}`}>{observation.company_name || "Company name unavailable"}</Link> : <p className="text-sm text-[var(--text-muted)]">Company not linked</p>}
        <h3 className="mt-1 break-words text-lg font-semibold leading-snug">{observation.title || "Untitled source observation"}</h3>
      </div>
      {match && <span className="rounded-full border px-2.5 py-1 text-xs text-[var(--gold)]" title="Model-estimated probability that the evidence matches this view’s question. This is not a factual accuracy score.">Question match {match}</span>}
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {signals.map(signal => <span key={signal} className="rounded border bg-[var(--surface-2)] px-2 py-1">{signalLabels[signal] ?? signal.replace(/_/g, " ")}</span>)}
      <span className="rounded border px-2 py-1 text-[var(--text-muted)]">{attributes ? relationshipLabel : "Not yet interpreted"}</span>
      {attributes && typeof attributes.requiresResearch === "number" && attributes.requiresResearch >= 0.7 && <span className="rounded border px-2 py-1 text-[var(--gold)]">More context needed</span>}
    </div>
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--text-muted)]">
      <div><dt className="inline">Event: </dt><dd className="inline text-[var(--text)]">{dateLabel(observation.event_date)} <span className="text-[var(--text-muted)]">· {ageLabel(observation.event_date)}</span></dd></div>
      <div><dt className="inline">Captured: </dt><dd className="inline">{dateLabel(observation.observed_at, true)}</dd></div>
    </dl>
    {attributes?.evidenceExcerpt ? <blockquote className="mt-4 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-4 text-sm leading-relaxed">{attributes.evidenceExcerpt}</blockquote> : <p className="mt-4 text-sm text-[var(--text-muted)]">{attributes ? "No supporting passage was selected. Open the source for context." : "This source is awaiting interpretation. Its event type and supporting passage are not yet established."}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
      <span>{observation.source_kind.replace(/_/g, " ")}</span><span aria-hidden="true">·</span>
      {source ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-all text-[var(--gold)] hover:underline">Open {source.host} ↗</a> : <span>Source link unavailable</span>}
    </div>
    <div className="mt-4 border-t pt-3">
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Feedback on this observation">
        {feedbackOptions.map(([reason, label]) => <button key={reason} type="button" disabled={busy} aria-pressed={observation.feedback?.reason === reason} onClick={() => void onFeedback(reason, note)} className={`rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-[var(--surface-2)] disabled:opacity-50 ${observation.feedback?.reason === reason ? "border-[var(--gold)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{label}</button>)}
        <button type="button" disabled={busy} onClick={() => setNoteOpen(open => !open)} aria-expanded={noteOpen} className="px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">{noteOpen ? "Hide note" : "Add context"}</button>
      </div>
      {noteOpen && <label className="mt-3 block text-xs text-[var(--text-muted)]">Optional context · saved with your next feedback selection
        <textarea rows={2} maxLength={500} value={note} disabled={busy} onChange={event => setNote(event.target.value)} className={`${fieldClass} mt-1`} placeholder="What would make this finding more useful?" />
      </label>}
      {observation.feedback && <p className="mt-2 text-xs text-[var(--text-muted)]">Saved feedback: {feedbackOptions.find(([reason]) => reason === observation.feedback?.reason)?.[1] ?? observation.feedback.reason}{observation.feedback.note ? ` · ${observation.feedback.note}` : ""}</p>}
      {observation.feedback && <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
        <button type="button" disabled={busy} className="text-[var(--gold)] underline" onClick={() => void onFeedback(null, "")}>Undo feedback</button>
        <span>{observation.feedback_excluded ? "Excluded from account profiles and matching views." : "Recorded feedback adjusts public priority by at most 10%, softened by four neutral examples. TAM grades stay unchanged."}</span>
      </div>}
      {attributes && <details className="mt-4 rounded border p-3">
        <summary className="cursor-pointer text-sm font-medium">Jev output</summary>
        <p className="mt-2 text-xs text-[var(--text-muted)]">Stored Jev judgments and probabilities for the selected evidence packet, with collected topic references and coverage. These are model outputs; feedback affects ranking separately.</p>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(attributes, null, 2)}</pre>
      </details>}
    </div>
  </article>;
}
