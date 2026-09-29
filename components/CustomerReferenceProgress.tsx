"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ReferenceProgress = {
  asOf: string | null; total: number; complete: number; pending: number; blocked: number; running: number;
  announcements?: number; sourceReady?: number; sourceBlocked?: number; sourcePages?: number; withSourceGaps?: number;
  references: { id: string; name: string; website: string | null; status: "pending" | "running" | "complete" | "blocked";
    answered: number; totalQuestions: number; lastError?: string; sourcePages?: number; sourceGaps?: number;
    checkpointUpdatedAt?: string | null; sourceAttempts?: number }[];
  run?: { processed: number; completed: number; stoppedBy: string };
};

const API = "/api/headhunter/intelligence/customer-references";

export function customerReferenceHoldDescription(error: string | null | undefined): string {
  if (!error) return "No answer was saved for the remaining characteristics.";
  if (["reference_continuation", "source_continuation"].includes(error)) return "The legacy reading stopped at a saved checkpoint. Customer research is now handled by Codex.";
  if (/typesafe_timeout|typesafe_http_5\d\d|native_response_unavailable/.test(error)) return "This Jev request failed or timed out. Its exact request and saved answers are held for reconciliation; Stanley will not automatically resend it.";
  if (/evidence_exceeds_native_request_limit|customer_context_relevant_evidence_still_large|typesafe_context_limit|typesafe_http_413/.test(error)) return "The remaining source text does not fit the current request size limit.";
  if (/typesafe_http_(400|422)/.test(error)) return "The provider could not process the remaining reading request.";
  if (/typesafe_http_(402|429)|provider_hold|credit|rate_limit/.test(error)) return "The legacy reading reached a provider availability or account-access hold; saved answers are retained.";
  if (/website.*(missing|unresolved)|missing.*website/.test(error)) return "An official website is still needed.";
  if (/source|fetch|website/.test(error)) return "Some website evidence could not be read.";
  return "The remaining reading needs attention; saved answers are retained.";
}

export function CustomerReferenceProgressRow({ reference }: { reference: ReferenceProgress["references"][number] }) {
  const partial = reference.status !== "complete" && reference.answered > 0;
  return <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
    {reference.website ? <a href={reference.website} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{reference.name} ↗</a> : <span>{reference.name} · Website unresolved</span>}
    <span className="text-[var(--text-muted)]">{reference.status === "complete" ? "Complete" : partial ? "Partial reading" : reference.status === "running" ? "Reading" : reference.status === "blocked" ? "Needs attention" : "Awaiting reading"} · {reference.answered}/{reference.totalQuestions} characteristics answered</span>
    {(reference.status === "blocked" || reference.lastError) && <span className="w-full text-[var(--text-muted)]">{customerReferenceHoldDescription(reference.lastError)}</span>}
    {!!reference.sourceGaps && <span className="w-full text-[var(--text-muted)]">{reference.sourceGaps} source gaps retained.</span>}
  </div>;
}

export function customerReferenceProgressKey(value: ReferenceProgress): string {
  return JSON.stringify([...value.references].sort((a, b) => a.id.localeCompare(b.id))
    .map(ref => [ref.id, ref.status, ref.answered, ref.sourcePages, ref.sourceGaps, ref.checkpointUpdatedAt, ref.sourceAttempts]));
}

/** Legacy readings are retained for inspection; this UI no longer starts paid work. */
export function customerReferenceCanContinue(previous: ReferenceProgress, next: ReferenceProgress): boolean {
  void previous; void next;
  return false;
}

export default function CustomerReferenceProgress({ enabled, onComplete }: { enabled: boolean; onComplete: (progress: ReferenceProgress) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReferenceProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const sequence = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(API, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("reference_progress_unavailable");
      const next: ReferenceProgress = await response.json();
      if (mounted.current && current === sequence.current) { setData(next); onComplete(next); }
    } catch {
      if (mounted.current && current === sequence.current) setError("Could not load customer reading progress. Try Refresh progress.");
    } finally { if (mounted.current && current === sequence.current) setLoading(false); }
  }, [enabled, onComplete]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);

  const filtered = (data?.references ?? []).filter(reference => `${reference.name} ${reference.website ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const partial = data?.references.filter(reference => reference.status !== "complete" && reference.answered > 0).length ?? 0;

  return <details className="mt-4 rounded border p-3 text-xs" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Saved customer reference sources{data ? ` · ${data.complete} of ${data.total} legacy question sets answered` : ""}</summary>
    <p className="mt-2 max-w-3xl leading-relaxed text-[var(--text-muted)]">These are preserved Jev answers under the previous characteristic definitions. They do not mean every website page was researched. Codex is researching the full customer cohort separately, without paid Jev calls. Slack establishes customer status. Missing names or websites remain source gaps. This list is read-only.</p>
    {loading && <p className="mt-3 text-[var(--text-muted)]" role="status">Loading saved progress…</p>}
    {error && <p className="mt-3 text-[var(--gold)]" role="alert">{error}</p>}
    {data && <>
      <p className="mt-3 text-[var(--text-muted)]" role="status">{data.complete} legacy question sets answered · {data.pending} unfinished{data.running ? ` · ${data.running} historical in-progress records` : ""}{data.blocked ? ` · ${data.blocked} held records` : ""}</p>
      {partial > 0 && <p className="mt-1 text-[var(--text-muted)]">Among unfinished records, {partial} have partial readings with saved answers. Those answers can support a comparison when every required characteristic is established; unanswered characteristics remain unanswered.</p>}
      {data.announcements !== undefined && <p className="mt-2 text-[var(--text-muted)]">{data.announcements.toLocaleString()} announcement records accounted for · {data.total.toLocaleString()} customer records · {(data.sourcePages ?? 0).toLocaleString()} website pages captured{data.withSourceGaps ? ` · ${data.withSourceGaps.toLocaleString()} records have source gaps` : ""}.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={!enabled || loading} onClick={() => void refresh()} className="rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh saved progress</button>
      </div>
      <input aria-label="Find a customer reference" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} placeholder="Find a customer or website" className="mt-3 w-full rounded border bg-[var(--background)] px-3 py-2" />
      <div className="mt-3 max-h-72 overflow-auto rounded border divide-y">{visible.map(reference => <CustomerReferenceProgressRow key={reference.id} reference={reference} />)}</div>
      {filtered.length > 50 && <div className="mt-2 flex items-center gap-3"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button><span>Page {currentPage + 1} of {Math.ceil(filtered.length / 50)} · {filtered.length.toLocaleString()} entries</span><button disabled={(currentPage + 1) * 50 >= filtered.length} onClick={() => setPage(currentPage + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button></div>}
    </>}
    {!data && !loading && <button type="button" disabled={!enabled} onClick={() => void refresh()} className="mt-3 rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh progress</button>}
  </details>;
}
