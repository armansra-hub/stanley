"use client";
import { useEffect, useState } from "react";
import type { RegionalContractFact } from "@/lib/regionalContracts/sources";
type Match = { id: string; fact: RegionalContractFact; identity_status: "candidate" | "verified" | "rejected"; identity_method: string; identity_source_url: string | null; identity_note: string | null; last_observed_at: string };
type Coverage = { id: string; name: string; dataset_url: string; scope: string; next_offset: number; snapshot_complete: boolean; last_success_at: string | null; last_error: string | null };
type Result = { matches: Match[]; sources: Coverage[]; hasMore: boolean };
const endpoint = "/api/headhunter/regional-contracts";
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("en-US", { timeZone: "UTC" }) : "not reported";
const money = (value: number | null) => value == null ? "not reported" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
function safeLink(value: string | null) { try { const url = new URL(value ?? ""); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; } }
export default function RegionalContracts({ companyId, active = true }: { companyId: string; active?: boolean }) {
  const [data, setData] = useState<Result | null>(null), [error, setError] = useState("");
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false);
  const [review, setReview] = useState<string | null>(null), [sourceUrl, setSourceUrl] = useState(""), [note, setNote] = useState("");
  useEffect(() => { setData(null); setOffset(0); setReview(null); setError(""); }, [companyId]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    fetch(`${endpoint}?companyId=${encodeURIComponent(companyId)}&offset=${offset}`, { signal: abort.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<Result>; })
      .then(value => { if (!abort.signal.aborted) { setData(value); setError(""); } })
      .catch(() => { if (!abort.signal.aborted) setError("Regional contract data is temporarily unavailable."); });
    return () => abort.abort();
  }, [companyId, active, offset, refresh]);
  const save = async (matchId: string, status: Match["identity_status"]) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId, matchId, status, sourceUrl, note }) });
      if (!response.ok) throw new Error();
      setReview(null); setSourceUrl(""); setNote(""); setRefresh(value => value + 1);
    } catch { setError("Could not save this identity review. Confirmation needs a public supporting source and a short explanation."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Regional government contracts" className="my-3 rounded border border-[var(--border)] p-3 text-xs">
    <h3 className="font-semibold">Regional government contracts</h3>
    <p className="mt-1 text-[var(--text-muted)]">Published supplier records from selected regional sources. Possible name matches are separate from confirmed account identity.</p>
    {error && <p role="alert" className="mt-2 text-red-500">{error}</p>}
    {!data && !error && <p className="mt-2 text-[var(--text-muted)]">Loading stored regional records…</p>}
    {data?.matches.length === 0 && <p className="mt-2 text-[var(--text-muted)]">No matching supplier rows stored yet. Coverage is limited to the sources below.</p>}
    {(["verified", "candidate", "rejected"] as const).map(status => {
      const rows = data?.matches.filter(row => row.identity_status === status) ?? [];
      return rows.length > 0 && <details key={status} open={status !== "rejected"} className="mt-3">
        <summary className="cursor-pointer font-medium">{{ verified: "Confirmed account identity", candidate: "Possible supplier matches — unverified", rejected: "Rejected matches" }[status]} ({rows.length})</summary>
        {rows.map(({ id, fact, identity_note, identity_source_url, identity_method }) => <div key={id} className="mt-2 border-l border-[var(--border)] pl-2">
          <div className="font-medium">{fact.title}</div>
          <p>{fact.supplierName} · {fact.supplierRole}</p><p className="text-[var(--text-muted)]">{fact.agency ?? "Agency not reported"} · Contract {fact.contractNumber ?? "number not reported"}{fact.amendment ? ` · Amendment ${fact.amendment}` : ""}</p>
          {fact.primeSupplierName && fact.primeSupplierName !== fact.supplierName && <p>Reported prime: {fact.primeSupplierName}</p>}
          <p>Term: {date(fact.startDate)} – {date(fact.endDate)} · Reported amount: {money(fact.reportedAmount)}</p>
          <p className="mt-1 text-[var(--text-muted)]">{fact.amountBasis}</p>
          {fact.description && <p className="mt-1 whitespace-pre-line">{fact.description}</p>}
          <a href={safeLink(fact.sourceUrl)} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">Official contract row ↗</a>
          {status === "verified" && <p className="mt-1">{identity_method === "company_site_contract_reference" ? "Confirmed by the account’s published contract reference" : "Confirmed by you"}: {identity_note} {identity_source_url && <a href={safeLink(identity_source_url)} target="_blank" rel="noreferrer" className="underline">Identity source ↗</a>}</p>}
          <div className="mt-2 flex gap-3">
            {status === "candidate" && <button disabled={busy} onClick={() => { setReview(review === id ? null : id); setSourceUrl(""); setNote(""); }} className="text-[var(--accent)] underline">Review identity</button>}
            {status !== "rejected" && <button disabled={busy} onClick={() => void save(id, "rejected")} className="text-[var(--text-muted)] underline">Not this account</button>}
            {status !== "candidate" && <button disabled={busy} onClick={() => void save(id, "candidate")} className="text-[var(--text-muted)] underline">Return to unverified</button>}
          </div>
          {review === id && <form onSubmit={event => { event.preventDefault(); void save(id, "verified"); }} className="mt-2 space-y-2">
            <p>Use a corroborating public source that establishes this supplier is this account. A shared name alone is insufficient.</p>
            <label className="block">Identity source URL<input type="url" required maxLength={2048} value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-transparent p-2" /></label>
            <label className="block">What establishes the identity?<textarea required minLength={12} maxLength={500} value={note} onChange={event => setNote(event.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-transparent p-2" /></label>
            <button type="submit" disabled={busy} className="rounded border border-[var(--border)] px-2 py-1">Confirm account identity</button>
          </form>}
        </div>)}
      </details>;
    })}
    {data && (offset > 0 || data.hasMore) && <div className="mt-3 flex gap-3"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous</button><button disabled={!data.hasMore} onClick={() => setOffset(value => value + 20)}>Next records</button></div>}
    <details className="mt-3 text-[var(--text-muted)]"><summary className="cursor-pointer">Sources and coverage</summary>
      {data?.sources.map(source => <div key={source.id} className="mt-2"><a href={safeLink(source.dataset_url)} target="_blank" rel="noreferrer" className="underline">{source.name} ↗</a>
        <p>{source.scope}</p><p>{source.last_error ? "Source retrieval needs retry" : source.snapshot_complete ? "Latest retrieved source snapshot scanned" : `Snapshot scan in progress · ${source.next_offset.toLocaleString()} rows traversed`}{source.last_success_at ? ` · last successful fetch ${date(source.last_success_at)}` : " · not fetched yet"}</p></div>)}
      <p className="mt-2">Historical awards do not establish a new event or buying intent. Regional amounts remain separate from federal totals.</p>
    </details>
  </section>;
}
