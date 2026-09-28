"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ReferenceProgress = {
  asOf: string; total: number; complete: number; pending: number; blocked: number; running: number;
  references: { id: string; name: string; website: string; status: "pending" | "running" | "complete" | "blocked";
    answered: number; totalQuestions: number; lastError?: string }[];
  run?: { processed: number; completed: number; stoppedBy: string };
};

const API = "/api/headhunter/intelligence/customer-references";

export default function CustomerReferenceProgress({ enabled, onComplete }: { enabled: boolean; onComplete: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReferenceProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readingRef = useRef(false);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);

  const read = async () => {
    if (!enabled || readingRef.current || !data || !data.pending) return;
    readingRef.current = true; sequence.current++;
    setReading(true); setError(null);
    try {
      const response = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(290_000) });
      if (!response.ok) throw new Error("reference_reading_unconfirmed");
      const next: ReferenceProgress = await response.json();
      if (mounted.current) { setData(next); onComplete(); }
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

  return <details className="mt-4 rounded border p-3 text-xs" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Customer reference sources{data ? ` · ${data.complete} of ${data.total} read` : ""}</summary>
    <p className="mt-2 max-w-3xl leading-relaxed text-[var(--text-muted)]">Read each customer’s website against the same 47 characteristics used for prospects. Saved answers are reused; only missing or changed reference evidence is sent to Jev. Opening this list or refreshing progress does not start paid research.</p>
    {loading && <p className="mt-3 text-[var(--text-muted)]" role="status">Loading saved progress…</p>}
    {error && <p className="mt-3 text-[var(--gold)]" role="alert">{error}</p>}
    {data && <>
      <p className="mt-3 text-[var(--text-muted)]" role="status">{data.complete} complete · {data.pending} awaiting reading{data.running ? ` · ${data.running} being read` : ""}{data.blocked ? ` · ${data.blocked} need source or processing attention` : ""}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {data.pending > 0 && <button type="button" disabled={!enabled || reading || loading || data.running > 0} onClick={() => void read()}
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{reading ? "Reading customer websites…" : data.complete ? "Continue reading" : "Start customer reference reading"}</button>}
        <button type="button" disabled={!enabled || reading || loading} onClick={() => void refresh()} className="rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh progress</button>
      </div>
      {reading && <p className="mt-2 text-[var(--text-muted)]" role="status">Jev is reading the customer evidence. Answers are saved as they finish; this pass may take a few minutes.</p>}
      <div className="mt-3 max-h-72 overflow-auto rounded border divide-y">{data.references.map(reference => <div key={reference.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
        <a href={reference.website} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{reference.name} ↗</a>
        <span className="text-[var(--text-muted)]">{reference.status === "complete" ? "Read" : reference.status === "running" ? "Reading" : reference.status === "blocked" ? "Needs attention" : "Awaiting reading"} · {reference.answered}/{reference.totalQuestions} characteristics answered</span>
      </div>)}</div>
    </>}
    {!data && !loading && <button type="button" disabled={!enabled} onClick={() => void refresh()} className="mt-3 rounded border px-3 py-2 text-xs disabled:opacity-50">Refresh progress</button>}
  </details>;
}
