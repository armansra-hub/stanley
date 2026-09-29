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

export function customerReferenceProgressKey(value: ReferenceProgress): string {
  return JSON.stringify([...value.references].sort((a, b) => a.id.localeCompare(b.id))
    .map(ref => [ref.id, ref.status, ref.answered, ref.sourcePages, ref.sourceGaps, ref.checkpointUpdatedAt, ref.sourceAttempts]));
}

/** Only a confirmed saved continuation can start another paid foreground pass.
 * Native mapping can advance before the final facet-answer count changes. */
export function customerReferenceCanContinue(previous: ReferenceProgress, next: ReferenceProgress): boolean {
  return next.pending > 0 && next.running === 0
    && ["deadline", "continued", "source_continuation", "references_exhausted"].includes(next.run?.stoppedBy ?? "")
    && customerReferenceProgressKey(next) !== customerReferenceProgressKey(previous);
}

export default function CustomerReferenceProgress({ enabled, onComplete }: { enabled: boolean; onComplete: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReferenceProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const readingRef = useRef(false);
  const stopRequested = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled || readingRef.current) return;
    const current = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(API, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("reference_progress_unavailable");
      const next: ReferenceProgress = await response.json();
      if (mounted.current && current === sequence.current) setData(next);
    } catch {
      if (mounted.current && current === sequence.current) setError("Could not load customer reading progress. Try Refresh progress.");
    } finally { if (mounted.current && current === sequence.current) setLoading(false); }
  }, [enabled]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopRequested.current = true; sequence.current++; }; }, []);
  useEffect(() => { if (!enabled) stopRequested.current = true; }, [enabled]);

  const read = async () => {
    if (!enabled || readingRef.current || !data || !data.pending) return;
    readingRef.current = true; stopRequested.current = false; sequence.current++;
    setReading(true); setError(null);
    try {
      // One explicit action continues the finite saved cohort. A confirmed
      // checkpoint permits the next request; an uncertain response never does.
      let previous = data;
      while (mounted.current && !stopRequested.current) {
        const response = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(290_000) });
        if (!response.ok) throw new Error("reference_reading_unconfirmed");
        const next: ReferenceProgress = await response.json();
        if (mounted.current) { setData(next); onComplete(); }
        if (!next.pending || next.running || stopRequested.current) break;
        if (!customerReferenceCanContinue(previous, next)) {
          if (mounted.current) setError("Reading paused at a saved checkpoint that needs attention. Review the progress before continuing.");
          break;
        }
        previous = next;
      }
    } catch {
      // A long request may finish on the server after the connection closes.
      // Read its saved state; never replay a potentially accepted paid operation.
      if (mounted.current) {
        try {
          const response = await fetch(API, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
          if (response.ok) { setData(await response.json()); onComplete(); }
        } catch { /* Keep the last saved progress; an explicit refresh remains available. */ }
        setError("The reading request ended before its result was confirmed. Check the saved progress below before continuing; the request has not been repeated.");
      }
    } finally { readingRef.current = false; if (mounted.current) { setReading(false); setLoading(false); } }
  };

  const filtered = (data?.references ?? []).filter(reference => `${reference.name} ${reference.website ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);

  return <details className="mt-4 rounded border p-3 text-xs" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Customer reference sources{data ? ` · ${data.complete} of ${data.total} read` : ""}</summary>
    <p className="mt-2 max-w-3xl leading-relaxed text-[var(--text-muted)]">Read the full registered customer set against the same 47 characteristics used for prospects. Saved website evidence and answers are reused. Unresolved companies stay visible here until their identity or website can be established. Opening this list or refreshing progress does not start paid research.</p>
    {loading && <p className="mt-3 text-[var(--text-muted)]" role="status">Loading saved progress…</p>}
    {error && <p className="mt-3 text-[var(--gold)]" role="alert">{error}</p>}
    {data && <>
      <p className="mt-3 text-[var(--text-muted)]" role="status">{data.complete} complete · {data.pending} awaiting reading{data.running ? ` · ${data.running} being read` : ""}{data.blocked ? ` · ${data.blocked} need source or processing attention` : ""}</p>
      {data.announcements !== undefined && <p className="mt-2 text-[var(--text-muted)]">{data.announcements.toLocaleString()} announcement records accounted for · {data.total.toLocaleString()} customer identities and unresolved entries · {(data.sourcePages ?? 0).toLocaleString()} website pages captured{data.withSourceGaps ? ` · ${data.withSourceGaps.toLocaleString()} entries have source gaps` : ""}.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {data.pending > 0 && <button type="button" disabled={!enabled || reading || loading || data.running > 0} onClick={() => void read()}
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{reading ? "Reading customer websites…" : data.complete ? "Continue all unread customers" : "Read all customer websites"}</button>}
        {reading && <button type="button" onClick={() => { stopRequested.current = true; setError("Stopping after the current saved pass. Completed work will be kept."); }} className="rounded border px-3 py-2 text-xs">Stop after this pass</button>}
        <button type="button" disabled={!enabled || reading || loading} onClick={() => void refresh()} className="rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh progress</button>
      </div>
      {reading && <p className="mt-2 text-[var(--text-muted)]" role="status">Keep this view open to continue through the full unread set. Each pass saves its progress; closing this view stops further passes.</p>}
      <input aria-label="Find a customer reference" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} placeholder="Find a customer or website" className="mt-3 w-full rounded border bg-[var(--background)] px-3 py-2" />
      <div className="mt-3 max-h-72 overflow-auto rounded border divide-y">{visible.map(reference => <div key={reference.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
        {reference.website ? <a href={reference.website} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{reference.name} ↗</a> : <span>{reference.name} · Website unresolved</span>}
        <span className="text-[var(--text-muted)]">{reference.status === "complete" ? "Read" : reference.status === "running" ? "Reading" : reference.status === "blocked" ? "Needs attention" : "Awaiting reading"} · {reference.answered}/{reference.totalQuestions} characteristics answered</span>
        {!!reference.sourceGaps && <span className="w-full text-[var(--text-muted)]">{reference.sourceGaps} source gaps retained.</span>}
      </div>)}</div>
      {filtered.length > 50 && <div className="mt-2 flex items-center gap-3"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button><span>Page {currentPage + 1} of {Math.ceil(filtered.length / 50)} · {filtered.length.toLocaleString()} entries</span><button disabled={(currentPage + 1) * 50 >= filtered.length} onClick={() => setPage(currentPage + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button></div>}
    </>}
    {!data && !loading && <button type="button" disabled={!enabled} onClick={() => void refresh()} className="mt-3 rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh progress</button>}
  </details>;
}
