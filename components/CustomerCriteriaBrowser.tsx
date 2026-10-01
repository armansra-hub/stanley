"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { OperatingMatchesProps } from "./OperatingMatches";
import type { CustomerCriteriaAccount, CustomerCriteriaCatalogResult, CustomerCriteriaMatches, CustomerCriterionExample } from "@/lib/intelligence/customerCriteria";
import type { ApprovedCustomerCriterion } from "@/lib/intelligence/customerApprovedCatalog";
import CopyButton, { bareDomain } from "./CopyButton";
import IntelligenceDismissButton from "./IntelligenceDismissButton";
import IntelligenceSelectionBar from "./IntelligenceSelectionBar";
import { hiddenIntelligenceLead } from "./intelligenceLeadStatus";

const field = "rounded-md border bg-[var(--background)] px-3 py-2 text-sm";
export function CustomerExampleEvidence({ example }: { example: CustomerCriterionExample }) {
  return <div className="mt-3 rounded border p-3 text-sm">
    <h4 className="font-semibold">{example.website ? <a href={example.website} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{example.name} ↗</a> : example.name}</h4>
    {example.industry && <p className="mt-1 text-xs text-[var(--text-muted)]">Provider industry: {example.industry}</p>}
    <p className="mt-2"><strong>Offering:</strong> {example.offeringScope}</p><p className="mt-1">{example.whyMatches}</p>
    <details className="mt-2"><summary className="cursor-pointer text-[var(--gold)]">Customer evidence · authored research</summary>
      {example.identityQualification != null && <p className="mt-2 text-xs text-[var(--text-muted)]">Identity qualification: {typeof example.identityQualification === "string" ? example.identityQualification : JSON.stringify(example.identityQualification)}</p>}
      {example.facts.map(fact => <div key={fact.id} className="mt-3">
        <p className="font-medium">{fact.label}</p><p className="mt-1">{fact.value}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Subject: {fact.subject.name} ({fact.subject.kind}) · {fact.explanation}</p>
        {fact.citations.map(c => <div key={`${c.sourceId}:${c.start}:${c.end}`} className="mt-2">
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--gold)] hover:underline">{c.title} ↗</a>
          <blockquote className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 text-xs">{c.quote}</blockquote>
        </div>)}
      </div>)}
      {!!example.sourceGaps.length && <details className="mt-3 text-xs"><summary className="cursor-pointer">Source gaps retained ({example.sourceGaps.length})</summary><ul className="mt-2 list-disc space-y-1 pl-4">{example.sourceGaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></details>}
    </details>
  </div>;
}
export function CustomerCriterionDefinition({ criterion }: { criterion: ApprovedCustomerCriterion }) {
  return <div className="mt-4 text-sm leading-relaxed">
    <h3 className="text-lg font-semibold">{criterion.label}</h3><p className="mt-2">{criterion.predicate}</p>
    <div className="mt-3 grid gap-4 md:grid-cols-2">
      <div><h4 className="font-medium">Required evidence</h4><ul className="mt-1 list-disc space-y-1 pl-4">{criterion.evidenceRules.map((rule, i) => <li key={i}>{rule}</li>)}</ul></div>
      <div><h4 className="font-medium">Exclusions</h4><ul className="mt-1 list-disc space-y-1 pl-4">{criterion.exclusions.map((rule, i) => <li key={i}>{rule}</li>)}</ul></div>
    </div>
    <details className="mt-3 text-xs text-[var(--text-muted)]"><summary className="cursor-pointer">Definition examples and applicability</summary>
      <p className="mt-2">{criterion.applicability.scope === "universal" ? "Universal operating criterion" : `Industry applicability: ${criterion.applicability.industryIds.join(", ")}`}</p>
      {[...criterion.positiveExamples.map(e => ({ ...e, kind: "Qualifies" })), ...criterion.negativeExamples.map(e => ({ ...e, kind: "Does not qualify" }))].map((e, i) => <p key={i} className="mt-2"><strong>{e.kind} (illustrative):</strong> {e.scenario} {e.explanation}</p>)}
      <p className="mt-2">Definition {criterion.definitionVersion} · original proposal {criterion.sourceProposalKey}</p>
    </details>
  </div>;
}
type ExamplesResult = { version: string; criterion: ApprovedCustomerCriterion; examples: CustomerCriterionExample[]; total: number; page: number; hasMore: boolean };
function CriterionExamples({ version, criterion, industry, enabled }: { version: string; criterion: ApprovedCustomerCriterion; industry: string; enabled: boolean }) {
  const [page, setPage] = useState(1), [result, setResult] = useState<ExamplesResult | null>(null), [error, setError] = useState(false);
  useEffect(() => { setPage(1); setResult(null); }, [version, criterion.id, industry]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setError(false); setResult(null);
    const params = new URLSearchParams({ version, criterion: criterion.id, industry, page: String(page) });
    void fetch(`/api/headhunter/intelligence/customer-criteria/examples?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error("unavailable"); return r.json(); })
      .then(r => { if (!controller.signal.aborted) setResult(r); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [version, criterion.id, industry, page, enabled]);
  return <div className="mt-4 border-t pt-3">
    <h4 className="font-medium">Actual customer examples</h4>
    {error ? <p role="alert" className="mt-2 text-sm">Customer examples are unavailable. This is not a zero count.</p> : !result ? <p className="mt-2 text-sm text-[var(--text-muted)]">Loading authored customer evidence…</p> : <>
      {!result.total && <p className="mt-2 text-sm text-[var(--text-muted)]">No supported customer binding in this selection. Field observations alone do not establish this criterion.</p>}
      {result.examples.map((example, i) => <CustomerExampleEvidence key={`${example.customerId}:${i}`} example={example} />)}
      {(page > 1 || result.hasMore) && <div className="mt-3 flex gap-3"><button className={field} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous examples</button><button className={field} disabled={!result.hasMore} onClick={() => setPage(p => p + 1)}>Next examples</button></div>}
    </>}
  </div>;
}
export function ApprovedCustomerMatchCard({ account, selected, busy, onSelect, onStatus, onOpenAccount }: {
  account: CustomerCriteriaAccount; selected: boolean; busy: boolean; onSelect?: (value: boolean) => void;
  onStatus?: OperatingMatchesProps["onStatus"]; onOpenAccount?: OperatingMatchesProps["onOpenAccount"];
}) {
  return <article className="rounded-lg border bg-[var(--background)] p-4">
    <div className="flex items-start justify-between gap-3"><div className="flex gap-3">
      {onSelect && <input type="checkbox" checked={selected} disabled={busy} aria-label={`Select ${account.name}`} onChange={e => onSelect(e.target.checked)} />}
      <div><h3 className="group font-semibold">{onOpenAccount ? <button className="text-[var(--gold)] hover:underline" onClick={() => onOpenAccount(account.companyId, account.name)}>{account.name}</button> : <Link className="text-[var(--gold)]" href={`/headhunter/intelligence?companyId=${encodeURIComponent(account.companyId)}`}>{account.name}</Link>} <CopyButton value={account.name} label="company name">⧉</CopyButton></h3>
        {account.domain && <div className="group mt-1 text-xs text-[var(--text-muted)]">{bareDomain(account.domain)} <CopyButton value={bareDomain(account.domain)} label="website">⧉</CopyButton></div>}
      </div></div>
      {onStatus && <IntelligenceDismissButton companyId={account.companyId} name={account.name} status={account.status} busy={busy} onStatus={(id, status) => onStatus([id], status)} />}
    </div>
    <p className="mt-3 text-xs text-[var(--text-muted)]">Source-supported operating resemblance. This does not establish financial pain or buying intent.</p>
    {account.sharedCriteria.map(c => <details key={c.id} className="mt-3 rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{c.label} · similar to {c.customer.name}</summary>
      <CustomerExampleEvidence example={c.customer} />
      {account.topics.filter(t => t.id === c.id).map(t => <div key={t.id} className="mt-3 text-sm"><h4 className="font-medium">Prospect evidence · {account.name}</h4>
        {t.sources.map(s => <div key={`${s.observationId}:${s.start}:${s.end}`} className="mt-2"><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--gold)]">{s.title} ↗</a><blockquote className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 pl-3 text-xs">{s.contextPreview}</blockquote></div>)}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Raw Jev answer · prospect</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(t.nativeResult, null, 2)}</pre></details>
      </div>)}
    </details>)}
  </article>;
}

export default function CustomerCriteriaBrowser({ enabled, refreshKey, onOpenAccount, showHidden = false, statusBusy = false, statusOverrides = {}, onStatus }: OperatingMatchesProps) {
  const [catalog, setCatalog] = useState<CustomerCriteriaCatalogResult | null>(null), [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [family, setFamily] = useState("all"), [criterion, setCriterion] = useState("all"), [industry, setIndustry] = useState("all"), [page, setPage] = useState(1);
  const [result, setResult] = useState<CustomerCriteriaMatches | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(new Set<string>()), [revision, setRevision] = useState(0), [resultStatus, setResultStatus] = useState("");
  const seq = useRef(0), writing = useRef(false), statusSignature = JSON.stringify(statusOverrides), currentStatus = useRef(statusSignature);
  currentStatus.current = statusSignature;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setCatalogError(null);
    void fetch("/api/headhunter/intelligence/customer-criteria", { cache: "no-store", signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error("The published criteria are unavailable. Saved legacy matches remain available.");
      const data = await r.json(); if (!data.available) throw new Error("The approved criteria have not been selected yet. Saved legacy matches remain available."); return data;
    }).then(data => { if (!controller.signal.aborted) setCatalog(data); }).catch(e => { if (!controller.signal.aborted) setCatalogError(e.message); });
    return () => controller.abort();
  }, [enabled, refreshKey, revision]);
  const version = catalog?.version;
  useEffect(() => {
    if (!enabled || !version || statusBusy) return;
    const controller = new AbortController(), request = ++seq.current, signature = currentStatus.current;
    setBusy(true); setError(null);
    const params = new URLSearchParams({ version, criterion, industry, page: String(page), showHidden: String(showHidden) });
    void fetch(`/api/headhunter/intelligence/customer-criteria/matches?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error("unavailable"); return r.json(); }).then(data => {
        if (request === seq.current && !controller.signal.aborted) { setResult(data); setResultStatus(signature); }
      }).catch(() => { if (!controller.signal.aborted) setError("Could not refresh criterion matches. Loaded accounts and your review decisions remain visible; unavailable data is not a zero count."); })
      .finally(() => { if (request === seq.current) setBusy(false); });
    return () => { controller.abort(); };
  }, [enabled, version, criterion, industry, page, showHidden, statusBusy, statusSignature, refreshKey, revision]);
  const change = (nextCriterion: string, nextIndustry = industry, nextPage = 1) => { seq.current++; setResult(null); setSelected(new Set()); setCriterion(nextCriterion); setIndustry(nextIndustry); setPage(nextPage); };
  const accounts = (result?.accounts ?? []).flatMap(a => { const status = statusOverrides[a.companyId] ?? a.status; return !showHidden && hiddenIntelligenceLead(status) ? [] : [{ ...a, status }]; });
  const updateStatus = useCallback(async (ids: string[], status: "new" | "dismissed") => {
    if (!onStatus || statusBusy || writing.current) return false;
    const loaded = new Set(accounts.map(a => a.companyId)), exact = [...new Set(ids)].filter(id => loaded.has(id));
    if (!exact.length) return false;
    writing.current = true;
    try { const saved = await onStatus(exact, status); if (saved) setSelected(new Set()); else setError("Could not confirm that review decision. Refresh before retrying."); return saved; }
    catch { setError("Could not confirm that review decision. Refresh before retrying."); return false; }
    finally { writing.current = false; }
  }, [onStatus, statusBusy, accounts]);
  const selectedCriterion = catalog?.criteria.find(c => c.id === criterion);
  const visible = catalog?.criteria.filter(c => (family === "all" || c.familyId === family)
    && (!query.trim() || `${c.label} ${c.predicate}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) ?? [];
  const countsCurrent = resultStatus === statusSignature && !statusBusy;
  return <section className="rounded-lg border bg-[var(--surface)] p-4 sm:p-5" aria-label="Approved customer criteria">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="western text-2xl">Similar to recent customers</h2><p className="mt-1 text-sm text-[var(--text-muted)]">Explore the operating criteria and the customer evidence behind them.</p></div><button className={field} disabled={!enabled || busy || statusBusy} onClick={() => setRevision(r => r + 1)}>Refresh matches</button></div>
    {catalogError && <p role="alert" className="mt-3 text-sm">{catalogError}</p>}
    {!catalog && !catalogError && <p className="mt-3 text-sm text-[var(--text-muted)]">{enabled ? "Loading published criteria…" : "Criteria load when this view is active."}</p>}
    {catalog && <>
      <p className="mt-3 text-sm text-[var(--text-muted)]">{catalog.criteria.length} approved criteria · {catalog.families.length} browsing families. {catalog.processing === "paused" ? "Prospect classification is prepared and paused." : catalog.processing === "enabled" ? "Showing saved prospect classifications." : "Processing status is unavailable."} Browsing uses saved evidence.</p>
      <div className="mt-4 flex flex-wrap gap-3"><input className={field} value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a criterion" aria-label="Find a criterion" />
        <select className={field} value={family} onChange={e => setFamily(e.target.value)} aria-label="Browse criteria family"><option value="all">All browsing families</option>{catalog.families.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
        <select className={field} value={industry} disabled={statusBusy} onChange={e => change(criterion, e.target.value)} aria-label="Provider industry"><option value="all">All provider industries</option>{catalog.industries.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">Industry means the provider’s own business. Mixed models may appear in several industries. A browsing family groups definitions; it is not a matching rule.</p>
      <div className="mt-3 flex max-h-64 flex-wrap gap-2 overflow-auto" role="group" aria-label="Approved customer patterns"><button className={`${field} ${criterion === "all" ? "border-[var(--gold)] text-[var(--gold)]" : ""}`} aria-pressed={criterion === "all"} disabled={statusBusy} onClick={() => change("all")}>{industry === "all" ? "All customer patterns" : "All customer patterns within industry"}</button>
        {visible.map(c => <button className={`${field} text-left ${criterion === c.id ? "border-[var(--gold)] text-[var(--gold)]" : ""}`} key={c.id} aria-pressed={criterion === c.id} disabled={statusBusy} onClick={() => change(c.id)}>{c.label}</button>)}
      </div>
      {!visible.length && <p className="mt-2 text-sm">No definitions match this browsing filter.</p>}
      {selectedCriterion ? <><CustomerCriterionDefinition criterion={selectedCriterion} /><CriterionExamples version={catalog.version} criterion={selectedCriterion} industry={industry} enabled={enabled} /></> : <p className="mt-3 text-sm text-[var(--text-muted)]">All patterns includes accounts sharing at least one complete supported criterion with an actual customer. Choose a criterion to read its requirements, exclusions and customer examples.</p>}
      <details className="mt-3 text-xs text-[var(--text-muted)]"><summary className="cursor-pointer">Research coverage and definition version</summary><p className="mt-2">{catalog.customerCoverage.records} maintained customer records: {catalog.customerCoverage.businessScopesClosed} finite business scopes closed and {catalog.customerCoverage.identityOrSourceGaps} identity or source gaps. This does not claim every archive page was read.</p><p className="mt-1">{catalog.customerCoverage.fieldMappedRecords} records have field observations; {catalog.customerCoverage.criterionBoundRecords} have explicit criterion evaluations. These are separate counts. Missing bindings remain unevaluated.</p><p className="mt-1 break-all">{catalog.version}</p></details>
    </>}
    {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
    {catalog && !result && !error && <p role="status" className="mt-4 text-sm text-[var(--text-muted)]">Reading saved prospect matches…</p>}
    {result && <div className="mt-5 border-t pt-4" aria-busy={busy}>
      <p role="status" className="text-sm">{result.state === "not_yet_evaluated" ? "Prospects have not yet been evaluated against this criteria selection." : result.state === "industry_not_established" ? "Provider industry is not yet established for the evaluated prospects." : countsCurrent ? `${result.total?.toLocaleString()} unique matching accounts in the saved evaluations` : `${accounts.length} accounts shown · counts updating`}</p>
      {result.state !== "ready" && <p className="mt-1 text-xs text-[var(--text-muted)]">This is not evidence that no prospects qualify. The separately labeled legacy view retains its original saved results.</p>}
      {!!result.industryUnknownAccounts && industry !== "all" && <p className="mt-1 text-xs text-[var(--text-muted)]">{result.industryUnknownAccounts} prospects have no established provider-industry context and are excluded from this industry selection.</p>}
      {onStatus && <div className="mt-3"><IntelligenceSelectionBar ids={accounts.map(a => a.companyId)} selectedIds={selected} onSelectionChange={setSelected} onStatus={updateStatus} showHidden={showHidden} busy={statusBusy} label="criterion matches" /></div>}
      {!!selected.size && <div className="group mb-3 text-xs"><CopyButton value={accounts.filter(a => selected.has(a.companyId)).map(a => [a.name, a.domain ? bareDomain(a.domain) : ""].filter(Boolean).join("\t")).join("\n")} label="selected companies">Copy selected names and websites</CopyButton></div>}
      <div className="mt-3 space-y-3">{accounts.map(a => <ApprovedCustomerMatchCard key={a.companyId} account={a} selected={selected.has(a.companyId)} busy={statusBusy} onOpenAccount={onOpenAccount} onStatus={onStatus ? updateStatus : undefined} onSelect={onStatus ? value => setSelected(old => { const next = new Set(old); if (value) next.add(a.companyId); else next.delete(a.companyId); return next; }) : undefined} />)}</div>
      {(page > 1 || result.hasMore) && <nav className="mt-4 flex gap-3" aria-label="Criterion match pages"><button className={field} disabled={busy || statusBusy || page <= 1} onClick={() => change(criterion, industry, page - 1)}>Previous 25</button><span className="self-center text-xs">Page {page}</span><button className={field} disabled={busy || statusBusy || !result.hasMore} onClick={() => change(criterion, industry, page + 1)}>Next 25</button></nav>}
    </div>}
  </section>;
}
