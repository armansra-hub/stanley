"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import OperatingProfile from "./OperatingProfile";
import AccountIntelligence from "./AccountIntelligence";
import AccountLookalikes from "./AccountLookalikes";
import { EvidenceCard, type Observation, type FeedbackReason } from "./IntelligenceEvidenceCard";

/** Account-only composition. Reading a lead never brings global queues or budgets into its record. */
export default function AccountResearchPanel({ companyId, active = true, onOpenAccount }: {
  companyId: string; active?: boolean; onOpenAccount: (id: string, name: string) => void;
}) {
  const [data, setData] = useState<{ observations: Observation[]; hasMore: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  const loaded = useRef(false), loading = useRef(false), mutating = useRef(false);
  const loadedCount = useRef(0);
  const load = useCallback(async (offset = 0, quiet = false) => {
    const version = ++request.current;
    loading.current = true;
    if (!quiet) setBusy(true);
    try {
      const params = new URLSearchParams({ companyId, scope: "account", dismissed: String(dismissed), offset: String(offset) });
      const response = await fetch(`/api/headhunter/intelligence?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const next = await response.json();
      if (!Array.isArray(next.observations)) throw new Error();
      if (version !== request.current) return;
      loaded.current = true;
      setData(previous => {
        const value = offset && previous ? { ...next, observations: [...previous.observations,
          ...next.observations.filter((item: Observation) => !previous.observations.some(prior => prior.id === item.id))] } : next;
        loadedCount.current = value.observations.length;
        return value;
      });
      setUpdatedAt(new Date().toISOString()); setError("");
    } catch { if (version === request.current) setError("Account evidence could not refresh. Previously loaded evidence remains available."); }
    finally { if (version === request.current) { loading.current = false; if (!mutating.current) setBusy(false); } }
  }, [companyId, dismissed]);
  useEffect(() => { loaded.current = false; loadedCount.current = 0; setData(null); setError(""); }, [companyId, dismissed]);
  useEffect(() => {
    if (!active) return;
    if (!loaded.current) void load();
    else if (!mutating.current) setBusy(false);
    // Preserve additional pages and expanded evidence when navigating back.
    // Explicit Refresh still reloads the first page after a long review.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !loading.current && !mutating.current && loadedCount.current <= 50) void load(0, true);
    }, 60_000);
    return () => { request.current++; loading.current = false; clearInterval(timer); };
  }, [active, load]);
  async function feedback(observationId: string, reason: FeedbackReason | null, note: string) {
    if (mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/headhunter/intelligence", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: reason === null ? "clear_feedback" : "feedback", observationId, reason, ...(note.trim() ? { note: note.trim() } : {}) }) });
      if (!response.ok) throw new Error();
      await load(); setRefresh(value => value + 1); return true;
    } catch { setError("Feedback could not be confirmed. Refresh before trying again."); return false; }
    finally { mutating.current = false; setBusy(false); }
  }
  return <section aria-label="Account intelligence">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-[var(--text-muted)]">Research for this account{updatedAt ? ` · Checked ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</p>
      <button type="button" disabled={busy} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => { void load(); setRefresh(value => value + 1); }}>Refresh research</button>
    </div>
    <>
      <AccountIntelligence active={active} companyId={companyId} refreshKey={String(refresh)} />
      <OperatingProfile active={active} companyId={companyId} refreshKey={String(refresh)} />
    </>
    <section aria-label="Account evidence" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="western text-2xl">Account evidence</h2>
        <label className="text-xs"><input type="checkbox" checked={dismissed} disabled={busy} onChange={event => setDismissed(event.target.checked)} /> Review dismissed evidence</label></div>
      {error && <p role="alert" className="mb-3 text-sm text-[var(--gold)]">{error}</p>}
      <p role="status" className="mb-3 text-xs text-[var(--text-muted)]">{!data ? busy ? "Loading account evidence…" : "Evidence has not loaded." : `${data.observations.length} evidence items loaded${data.hasMore ? "; more available" : ""}. Original Jev output is expandable on interpreted items.`}</p>
      {data?.observations.length === 0 && <p className="rounded border border-dashed p-4 text-sm text-[var(--text-muted)]">{dismissed ? "No dismissed evidence for this account." : "No current evidence is stored for this account yet. This does not establish an absence of activity."}</p>}
      <div className="space-y-4">{data?.observations.map(observation => <EvidenceCard key={observation.id} observation={observation} busy={busy}
        onOpenAccount={onOpenAccount} onFeedback={(reason, note) => feedback(observation.id, reason, note)} />)}</div>
      {data?.hasMore && <button type="button" disabled={busy} className="mt-3 rounded border px-3 py-2 text-sm" onClick={() => void load(data.observations.length)}>Load more evidence</button>}
    </section>
    <AccountLookalikes active={active} companyId={companyId} refreshKey={String(refresh)} onOpenAccount={onOpenAccount} />
  </section>;
}
