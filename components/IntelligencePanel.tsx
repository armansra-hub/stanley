"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AccountResearchPanel from "./AccountResearchPanel";
import RecentCustomerMatches from "./RecentCustomerMatches";
import { saveIntelligenceLeadStatus, type IntelligenceLeadStatus, type IntelligenceStatusOverrides } from "./intelligenceLeadStatus";

export default function IntelligencePanel({ companyId }: { companyId?: string }) {
  const [frames, setFrames] = useState<Array<{ id: string; name: string }>>(companyId ? [{ id: companyId, name: "Account intelligence" }] : []);
  const openAccount = (id: string, name: string) => setFrames(previous => previous.at(-1)?.id === id ? previous : [...previous, { id, name }]);
  return <>
    <div hidden={frames.length > 0}><GlobalIntelligencePanel active={frames.length === 0} onOpenAccount={openAccount} /></div>
    {frames.map((frame, index) => <div key={index + ":" + frame.id} hidden={index !== frames.length - 1} className="fixed inset-0 z-20 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto max-w-5xl p-5"><header className="sticky top-0 z-10 mb-4 border-b bg-[var(--background)] pb-3"><button type="button" className="mb-3 text-sm text-[var(--gold)]" onClick={() => setFrames(previous => previous.slice(0, -1))}>← Back to {index ? frames[index - 1].name : "Explore Jev Intelligence"}</button><h1 className="western text-3xl">{frame.name}</h1></header>
        <AccountResearchPanel companyId={frame.id} active={index === frames.length - 1} onOpenAccount={openAccount} />
      </div>
    </div>)}
  </>;
}

function GlobalIntelligencePanel({ active, onOpenAccount }: { active: boolean; onOpenAccount: (id: string, name: string) => void }) {
  const [showHidden, setShowHidden] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const statusInFlight = useRef(false);
  const [statusOverrides, setStatusOverrides] = useState<IntelligenceStatusOverrides>({});
  const statusOverridesRef = useRef<IntelligenceStatusOverrides>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function changeCompanyStatus(ids: string[], status: IntelligenceLeadStatus): Promise<boolean> {
    if (statusInFlight.current || !ids.length) return false;
    const exactIds = [...new Set(ids)];
    const previous = statusOverridesRef.current;
    const next = { ...previous, ...Object.fromEntries(exactIds.map(id => [id, status])) };
    statusInFlight.current = true;
    statusOverridesRef.current = next;
    setStatusOverrides(next);
    setStatusBusy(true); setError(null); setNotice(null);
    try {
      await saveIntelligenceLeadStatus(exactIds, status);
      setNotice(status === "dismissed" ? `${exactIds.length} lead${exactIds.length === 1 ? "" : "s"} dismissed. Use Show hidden to restore. Research is kept.` : `${exactIds.length} lead${exactIds.length === 1 ? "" : "s"} restored.`);
      return true;
    } catch {
      statusOverridesRef.current = previous;
      setStatusOverrides(previous);
      setError("Could not confirm the review decision. Refresh matches to check its current status before trying again.");
      return false;
    } finally { statusInFlight.current = false; setStatusBusy(false); }
  }

  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link href="/headhunter" className="mb-3 inline-block text-sm text-[var(--gold)] hover:underline">← Back to Triggered</Link>
        <h1 className="western text-4xl sm:text-5xl">Explore Jev Intelligence</h1>
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><input type="checkbox" checked={showHidden} disabled={statusBusy} onChange={event => setShowHidden(event.target.checked)} />Show hidden (reviewed / dismissed)</label>
    </header>
    {error && <div role="alert" className="mb-4 rounded-lg border border-[var(--accent)] bg-[var(--surface)] p-3 text-sm">{error}</div>}
    {notice && <div role="status" className="mb-4 rounded-lg border bg-[var(--surface)] p-3 text-sm text-[var(--gold)]">{notice}</div>}
    <RecentCustomerMatches onOpenAccount={onOpenAccount} enabled={active} showHidden={showHidden} statusBusy={statusBusy} statusOverrides={statusOverrides} onStatus={changeCompanyStatus} />
  </main>;
}
