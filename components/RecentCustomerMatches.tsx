"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CustomerMatchesResult } from "@/lib/intelligence/customerMatches";
import type { OperatingMatchesProps } from "./OperatingMatches";
import CopyButton, { bareDomain } from "./CopyButton";
import IntelligenceDismissButton from "./IntelligenceDismissButton";
import IntelligenceSelectionBar from "./IntelligenceSelectionBar";
import { hiddenIntelligenceLead } from "./intelligenceLeadStatus";
import CustomerReferenceProgress, { customerReferenceHoldDescription, type ReferenceProgress } from "./CustomerReferenceProgress";
import type { CustomerCohortSummary, CustomerCohortSlice } from "@/lib/intelligence/customerCohortSummary";
import { OPERATING_FACETS } from "@/lib/intelligence/operatingCatalog";

type CustomerMatch = CustomerMatchesResult["accounts"][number];
type ReferenceReadingCounts = Pick<ReferenceProgress, "total" | "complete" | "pending" | "running" | "blocked">;

export const customerMatchesNeedRefresh = (previousCompleted: number, completed: number, previousAnswered = 0, answered = 0) =>
  completed > previousCompleted || answered > previousAnswered;

export function CustomerReferenceCoverage({ coverage, progress }: {
  coverage: CustomerMatchesResult["referenceCoverage"]; progress?: ReferenceReadingCounts | null;
}) {
  const total = progress?.total ?? coverage.total ?? coverage.verified + coverage.pending;
  const complete = progress?.complete ?? coverage.verified;
  const partial = coverage.partial ?? 0;
  return <div className="mt-4 rounded-md border border-[var(--gold)]/40 bg-[var(--background)] p-3 text-xs leading-relaxed">
    <p className="font-semibold">Website analysis complete: {complete.toLocaleString()} of {total.toLocaleString()} customer records</p>
    <p className="mt-1 text-[var(--text-muted)]">Slack establishes that these companies are customers. This match snapshot uses {coverage.verified.toLocaleString()} complete{partial ? ` and ${partial.toLocaleString()} partial` : ""} website analyses of their operations. Missing names or websites are source gaps, not questions about customer status.</p>
    {partial > 0 && <p className="mt-1 text-[var(--text-muted)]">Partial analyses contribute only saved answers. Every required characteristic must be supported for a match; unanswered characteristics stay unanswered. The {partial.toLocaleString()} partial analyses are not included in the completed count.</p>}
    {complete < total && <p className="mt-1 text-[var(--text-muted)]">This is a partial customer cohort. Existing matches remain available while research continues; they do not establish how common a characteristic is across all customers.</p>}
    {progress && <p className="mt-1 text-[var(--text-muted)]">{progress.pending.toLocaleString()} awaiting completion · {progress.blocked.toLocaleString()} need attention{progress.running ? ` · ${progress.running.toLocaleString()} being read` : ""}.</p>}
    <details className="mt-2 text-[var(--text-muted)]"><summary className="cursor-pointer">Where the characteristics came from</summary>
      <p className="mt-2">The 47 definitions came from the broader research across 704 announcement entries. Those entries were not all fully read against the definitions. Customer comparisons use saved, source-supported answers under the same definitions as prospects, including usable answers from partial readings.</p>
      <p className="mt-1">Announcement coverage through {dated(coverage.asOf)}; this date does not mean all registered customers have been researched.</p>
    </details>
  </div>;
}

export function CustomerCohortCounts({ cohort }: { cohort: CustomerCohortSummary }) {
  const [period, setPeriod] = useState<"all" | "recent" | "older">("all");
  const [industry, setIndustry] = useState("");
  const selected = cohort.industries.find(group => (group.industry ?? "") === industry) ?? cohort.industries[0];
  const group: CustomerCohortSlice | undefined = selected?.[period];
  return <details className="mt-3 rounded border p-3 text-xs">
    <summary className="cursor-pointer font-medium">Characteristics in the saved customer reads</summary>
    <p className="mt-2 leading-relaxed text-[var(--text-muted)]">Counts cover {cohort.customers.toLocaleString()} customer references in this match snapshot: {(cohort.completedCustomers ?? cohort.customers).toLocaleString()} complete and {(cohort.partialCustomers ?? 0).toLocaleString()} partial. This is not the full registry or the original 704 research entries. These are saved Jev answers, not newly discovered categories or a win rate. Recent means an announcement within 180 days; announcements can be new customers, expansions or renewals.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <select aria-label="Customer count industry" value={selected?.industry ?? ""} onChange={event => setIndustry(event.target.value)} className="rounded border bg-[var(--background)] p-2">
        {cohort.industries.map(item => <option key={item.industry ?? "unknown"} value={item.industry ?? ""}>{item.industry ?? "Industry not recorded"}</option>)}
      </select>
      <select aria-label="Customer announcement period" value={period} onChange={event => setPeriod(event.target.value as typeof period)} className="rounded border bg-[var(--background)] p-2">
        <option value="all">All announcement dates</option><option value="recent">Past 180 days</option><option value="older">Older announcements</option>
      </select>
    </div>
    {group && <>
      <p className="mt-3 text-[var(--text-muted)]">{group.customers.toLocaleString()} customer references in this group: {(group.completedCustomers ?? group.customers).toLocaleString()} complete and {(group.partialCustomers ?? 0).toLocaleString()} partial. Each row uses that same denominator; unanswered, unknown and conflicting answers stay separate from negative answers.</p>
      <div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-left text-[10px]">
        <thead><tr className="border-b"><th className="p-2">Characteristic</th><th className="p-2">Supported</th><th className="p-2">Not supported</th><th className="p-2">Insufficient evidence</th><th className="p-2">Conflicting</th><th className="p-2">Unanswered</th></tr></thead>
        <tbody>{OPERATING_FACETS.map(facet => { const count = group.traits[facet.id]; return <tr key={facet.id} className="border-b"><th className="p-2 font-normal">{facet.label}</th>
          <td className="p-2">{count?.supported ?? 0}</td><td className="p-2">{count?.not_supported ?? 0}</td><td className="p-2">{count?.insufficient_evidence ?? 0}</td><td className="p-2">{count?.conflicting ?? 0}</td><td className="p-2">{count?.unanswered ?? group.customers}</td></tr>; })}</tbody>
      </table></div>
    </>}
  </details>;
}

function dated(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "Date unavailable";
}

/** Apply the shared review decisions last, including to an older in-flight read. */
export function customerMatchesWithStatus<T extends { companyId: string; status?: string }>(
  accounts: readonly T[], overrides: Record<string, "new" | "dismissed">, showHidden: boolean,
): T[] {
  const seen = new Set<string>();
  return accounts.flatMap(account => {
    if (seen.has(account.companyId)) return [];
    seen.add(account.companyId);
    const status = overrides[account.companyId] ?? account.status;
    return !showHidden && hiddenIntelligenceLead(status) ? [] : [{ ...account, status }];
  });
}

export function CustomerMatchCard({ account, selected, statusBusy, onSelect, onStatus, onOpenAccount }: {
  account: CustomerMatch;
  selected: boolean;
  statusBusy: boolean;
  onSelect?: (selected: boolean) => void;
  onStatus?: (ids: string[], status: "new" | "dismissed") => Promise<boolean>;
  onOpenAccount?: (id: string, name: string) => void;
}) {
  return <article className={`rounded-lg border bg-[var(--background)] p-4 sm:p-5 ${selected ? "border-[var(--gold)]" : ""}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {onSelect && <input type="checkbox" className="mt-1" aria-label={`Select ${account.name}`} checked={selected}
          disabled={statusBusy} onChange={event => onSelect(event.target.checked)} />}
        <div>
          <h3 className="group flex items-center gap-1.5 font-semibold">
            {onOpenAccount
              ? <button type="button" className="text-[var(--gold)] hover:underline" onClick={() => onOpenAccount(account.companyId, account.name)}>{account.name}</button>
              : <Link className="text-[var(--gold)] hover:underline" href={`/headhunter/intelligence?companyId=${encodeURIComponent(account.companyId)}`}>{account.name}</Link>}
            <CopyButton value={account.name} label="company name">⧉</CopyButton>
          </h3>
          {account.domain && <div className="group mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)]">
            {bareDomain(account.domain)}<CopyButton value={bareDomain(account.domain)} label="website">⧉</CopyButton>
          </div>}
          {account.subindustry && <p className="mt-1 text-[10px] text-[var(--text-muted)]">{account.subindustry}</p>}
        </div>
      </div>
      {onStatus && <IntelligenceDismissButton companyId={account.companyId} name={account.name} status={account.status}
        busy={statusBusy} onStatus={(id, status) => onStatus([id], status)} />}
    </div>

    <div className="mt-3 flex flex-wrap gap-1.5">
      <span className="rounded-full border border-[var(--gold)] px-2.5 py-1 text-[10px] text-[var(--gold)]">{account.primaryPattern.label}</span>
      {account.otherPatterns.map(pattern => <span key={pattern.id} className="rounded-full border px-2.5 py-1 text-[10px] text-[var(--text-muted)]">Also: {pattern.label}</span>)}
    </div>

    {account.nonAsset3pl && <section aria-label="Prospect non-asset-based 3PL qualification" className="mt-3 rounded-md border border-[var(--gold)]/40 p-3">
      <h4 className="text-sm font-medium">Non-asset-based 3PL</h4>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Saved Jev evidence for this prospect; customer comparison below covers shared services, not assumed customer asset ownership.</p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[var(--gold)]">Saved prospect evidence</summary>
        {account.nonAsset3pl.boundary && <p className="mt-2 text-[var(--text-muted)]">Definition: {account.nonAsset3pl.boundary}</p>}
        {account.nonAsset3pl.sources.map(source => <div key={`${source.observationId}:${source.start}:${source.end}`} className="mt-3">
          <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label="Prospect source for non-asset-based 3PL qualification" className="text-[var(--gold)] hover:underline">{source.title || "Prospect source"} ↗</a>
          <blockquote className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 leading-relaxed">{source.contextPreview}{source.previewTruncated ? "…" : ""}</blockquote>
          {source.previewTruncated && <p className="mt-1 text-[10px] text-[var(--text-muted)]">Source preview. Open the page for the complete passage.</p>}
        </div>)}
        {account.nonAsset3pl.nativeResult != null && <details className="mt-3"><summary className="cursor-pointer">Raw Jev answer · prospect qualification</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(account.nonAsset3pl.nativeResult, null, 2)}</pre></details>}
      </details>
    </section>}

    <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="rounded-md bg-[var(--surface)] p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Operating fit</p>
        <p className="mt-1 text-sm font-medium">Similar to <a href={account.reference.website} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{account.reference.name} ↗</a></p>
        <p className="mt-1 text-[10px] text-[var(--gold)]">{account.reference.recent ? "Recent customer example" : "Historical customer comparison"}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{account.reference.announcementType === "renewal" ? "Renewal announcement" : account.reference.announcementType === "expansion" ? "Expansion announcement" : account.reference.announcementType === "new_customer" ? "New customer announcement" : "Customer announcement"}: {dated(account.reference.announcementDate)}</p>
        {account.reference.reading && <div className="mt-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
          <span className="inline-block rounded border px-2 py-1">{account.reference.reading.status === "complete" ? "Complete website analysis" : "Partial website analysis"} · {account.reference.reading.answered}/{account.reference.reading.total} characteristics answered</span>
          {account.reference.reading.status !== "complete" && <p className="mt-1">{account.reference.reading.status === "running" ? "Remaining characteristics are being read." : customerReferenceHoldDescription(account.reference.reading.lastError)} Every required trait below is already supported.</p>}
        </div>}
        <p className="mt-2 text-xs text-[var(--text-muted)]">{account.primaryPattern.branchLabel}</p>
        <ul className="mt-3 space-y-2 text-sm">{account.reference.sharedTraits.map(trait => {
          const customerSources = account.reference.sharedTraitSources.find(item => item.traitId === trait.id)?.urls ?? [];
          const prospectSources = [...new Set(account.topics.find(item => item.id === trait.id)?.sources.map(source => source.url) ?? [])];
          return <li key={trait.id} className="flex gap-2"><span className="text-[var(--gold)]" aria-hidden="true">✓</span><div><span>{trait.label}</span>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
              {customerSources.map((url, index) => <a key={`customer:${url}`} href={url} target="_blank" rel="noopener noreferrer" aria-label={`Customer source ${index + 1} for ${trait.label}`} className="hover:text-[var(--gold)] hover:underline">Customer source{customerSources.length > 1 ? ` ${index + 1}` : ""} ↗</a>)}
              {prospectSources.map((url, index) => <a key={`prospect:${url}`} href={url} target="_blank" rel="noopener noreferrer" aria-label={`Prospect source ${index + 1} for ${trait.label}`} className="hover:text-[var(--gold)] hover:underline">Prospect source{prospectSources.length > 1 ? ` ${index + 1}` : ""} ↗</a>)}
            </div>
          </div></li>;
        })}</ul>
      </div>
      <div className="rounded-md border p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Why now</p>
        {account.whyNow.length ? <ul className="mt-2 space-y-3">{account.whyNow.map(event => <li key={event.id}>
          <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--gold)] hover:underline">{event.label} ↗</a>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Event: {dated(event.eventDate)}</p>
        </li>)}</ul> : <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">No recent, dated buying signal in the saved evidence. This account is here for its operating fit.</p>}
      </div>
    </div>

    {(account.reference.unknownTraits.length > 0 || account.reference.differentTraits.length > 0) && <div className="mt-3 space-y-1 text-xs leading-relaxed text-[var(--text-muted)]">
      {!!account.reference.unknownTraits.length && <p><strong>Not established for this prospect:</strong> {account.reference.unknownTraits.map(trait => trait.label).join("; ")}.</p>}
      {!!account.reference.differentTraits.length && <p><strong>Known differences:</strong> {account.reference.differentTraits.map(trait => trait.label).join("; ")}.</p>}
    </div>}

    <details className="mt-4 border-t pt-3 text-sm">
      <summary className="cursor-pointer text-[var(--gold)]">See the evidence on both companies</summary>
      <div className="mt-3 rounded border p-3">
        <h4 className="font-medium">Customer reference · {account.reference.name}</h4>
        <p className="mt-1 text-xs text-[var(--text-muted)]">The shared characteristics above are supported by the customer’s website.</p>
        <div className="mt-2 space-y-2">{account.reference.sources.map((source, index) => <div key={`${source.url}:${index}`}>
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--gold)] hover:underline">{source.title || "Customer website source"} ↗</a>
          {source.text && <blockquote className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 text-xs leading-relaxed">{source.text}</blockquote>}
        </div>)}</div>
        {!!account.reference.sharedNativeAnswers?.length && <details className="mt-3 text-xs"><summary className="cursor-pointer">Raw Jev answers · customer</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(account.reference.sharedNativeAnswers, null, 2)}</pre>
        </details>}
      </div>
      <h4 className="mb-2 mt-4 font-medium">Prospect evidence · {account.name}</h4>
      <div className="space-y-2">{account.topics.map(topic => <details key={topic.id} className="rounded border p-3">
        <summary className="cursor-pointer text-sm">{topic.label}</summary>
        {topic.boundary && <p className="mt-2 text-xs text-[var(--text-muted)]">Definition: {topic.boundary}</p>}
        {topic.sources.map(source => <div key={`${source.observationId}:${source.start}:${source.end}`} className="mt-3">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--gold)] hover:underline">{source.title || "Prospect source"} ↗</a>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">{source.eventDate ? `Event: ${dated(source.eventDate)} · ` : ""}Captured: {dated(source.observedAt)}</p>
          <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 text-xs leading-relaxed">{source.contextPreview}{source.previewTruncated ? "…" : ""}</blockquote>
          {source.previewTruncated && <p className="mt-1 text-[10px] text-[var(--text-muted)]">Source preview. Open the page for the complete passage.</p>}
        </div>)}
        {topic.nativeResult != null && <details className="mt-3 text-xs"><summary className="cursor-pointer">Raw Jev answer</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(topic.nativeResult, null, 2)}</pre></details>}
      </details>)}</div>
      <details className="mt-3 text-xs text-[var(--text-muted)]"><summary className="cursor-pointer">How this match is ordered</summary>
        <p className="mt-2 leading-relaxed">{account.fit.explanation}</p>
        <p className="mt-2 leading-relaxed">{account.fit.industryBasis}</p>
        {!!account.fit.rarity.assessed && <p className="mt-2">{account.fit.rarity.matched.toLocaleString()} of {account.fit.rarity.assessed.toLocaleString()} assessed prospects in this comparison group share the required combination. This describes prospect coverage, not a win rate.</p>}
      </details>
    </details>
  </article>;
}

export default function RecentCustomerMatches({ enabled, refreshKey, onOpenAccount, showHidden = false, statusBusy = false, statusOverrides = {}, onStatus }: OperatingMatchesProps) {
  const [pattern, setPattern] = useState("all");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CustomerMatchesResult | null>(null);
  const [referenceProgress, setReferenceProgress] = useState<ReferenceReadingCounts | null>(null);
  const [summary, setSummary] = useState<Pick<CustomerMatchesResult, "patterns" | "referenceCoverage"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set<string>());
  const [resultStatusSignature, setResultStatusSignature] = useState("");
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const lastCompleted = useRef<number | null>(null);
  const lastAnswered = useRef<number | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const statusSignature = JSON.stringify(statusOverrides);
  const statusSignatureRef = useRef(statusSignature);
  const statusBusyRef = useRef(statusBusy);
  statusSignatureRef.current = statusSignature;
  statusBusyRef.current = statusBusy;

  const load = useCallback(async () => {
    if (!enabled || statusBusyRef.current) return;
    const current = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(() => request.abort(), 20_000);
    const requestedStatus = statusSignatureRef.current;
    setBusy(true); setError(null);
    const params = new URLSearchParams({ pattern, page: String(page), showHidden: String(showHidden) });
    try {
      const response = await fetch(`/api/headhunter/intelligence/customer-matches?${params}`, { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("customer_matches_unavailable");
      const next: CustomerMatchesResult = await response.json();
      if (current !== sequence.current) return;
      setResult(next);
      setSummary({ patterns: next.patterns, referenceCoverage: next.referenceCoverage });
      lastCompleted.current = Math.max(lastCompleted.current ?? 0, next.referenceCoverage.verified);
      setResultStatusSignature(statusBusyRef.current ? "pending" : requestedStatus);
    } catch {
      if (current === sequence.current) setError(resultRef.current
        ? "Could not refresh customer matches. Your loaded accounts and review decisions are still shown."
        : "Could not load customer matches. Try Refresh matches; your saved research is still retained.");
    } finally {
      clearTimeout(timeout);
      if (current === sequence.current) setBusy(false);
    }
  }, [enabled, pattern, page, showHidden]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const onReferenceProgress = useCallback((next: ReferenceProgress) => {
    const previousCompleted = lastCompleted.current ?? resultRef.current?.referenceCoverage.verified ?? 0;
    const answered = next.references.reduce((sum, reference) => sum + reference.answered, 0);
    const previousAnswered = lastAnswered.current ?? answered;
    lastCompleted.current = next.complete;
    lastAnswered.current = answered;
    setReferenceProgress({ total: next.total, complete: next.complete, pending: next.pending, running: next.running, blocked: next.blocked });
    if (customerMatchesNeedRefresh(previousCompleted, next.complete, previousAnswered, answered)) void loadRef.current();
  }, []);

  useEffect(() => {
    if (!statusBusy) void load();
  }, [load, refreshKey, statusSignature, statusBusy]);
  useEffect(() => () => { sequence.current++; controller.current?.abort(); }, []);

  const accounts = customerMatchesWithStatus(result?.accounts ?? [], statusOverrides, showHidden);
  const countsCurrent = resultStatusSignature === statusSignature && !statusBusy;
  const changeView = (nextPattern: string, nextPage = 1) => {
    if (nextPattern === pattern && nextPage === page) return;
    sequence.current++; controller.current?.abort();
    setResult(null); setError(null); setSelectedAccounts(new Set());
    setPattern(nextPattern); setPage(nextPage);
  };
  const updateStatus = async (ids: string[], status: "new" | "dismissed") => {
    if (!onStatus || statusBusy || writing.current) return false;
    const loaded = new Set(accounts.map(account => account.companyId));
    const exactIds = [...new Set(ids)].filter(id => loaded.has(id));
    if (!exactIds.length) return false;
    writing.current = true;
    try {
      const saved = await onStatus(exactIds, status);
      if (saved) setSelectedAccounts(new Set());
      else setError("Could not confirm the review decision. Refresh to check its current status before trying again.");
      return saved;
    } catch {
      setError("Could not confirm the review decision. Refresh to check its current status before trying again.");
      return false;
    } finally { writing.current = false; }
  };

  return <section className="mb-4 rounded-lg border bg-[var(--surface)] p-4 sm:p-5" aria-labelledby="recent-customer-matches-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="recent-customer-matches-heading" className="western text-2xl">Similar to recent customers</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">Find prospects that share distinctive operating characteristics with ring-ring customers. Compare the sources, then look for a reason to act now.</p>
      </div>
      <button type="button" disabled={!enabled || busy || statusBusy} onClick={() => void load()} className="rounded-md border px-3 py-2 text-xs disabled:opacity-50">{busy ? "Refreshing…" : "Refresh matches"}</button>
    </div>

    {summary && <CustomerReferenceCoverage coverage={summary.referenceCoverage} progress={referenceProgress} />}
    <CustomerReferenceProgress enabled={enabled} onComplete={onReferenceProgress} />
    {result?.customerCohort && <CustomerCohortCounts cohort={result.customerCohort} />}

    {summary && <>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Customer operating patterns">
        <button type="button" aria-pressed={pattern === "all"} disabled={statusBusy} onClick={() => changeView("all")}
          className={`rounded-md border px-3 py-2 text-left text-xs disabled:opacity-50 ${pattern === "all" ? "border-[var(--gold)] bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>All customer patterns</button>
        {summary.patterns.map(item => <button key={item.id} type="button" title={item.description} aria-pressed={pattern === item.id} disabled={statusBusy}
          onClick={() => changeView(item.id)} className={`rounded-md border px-3 py-2 text-left text-xs disabled:opacity-50 ${pattern === item.id ? "border-[var(--gold)] bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>
          {item.label} <span className="opacity-70">({item.count.toLocaleString()}{countsCurrent ? "" : "*"})</span>
        </button>)}
      </div>
      {pattern !== "all" && <p className="mt-3 text-sm text-[var(--text-muted)]">{summary.patterns.find(item => item.id === pattern)?.description}</p>}
    </>}

    {error && <p role="alert" className="mt-4 text-sm text-[var(--gold)]">{error}</p>}
    {!enabled && <p className="mt-4 text-sm text-[var(--text-muted)]">Customer matches will load when this view is active.</p>}
    {enabled && !result && !error && <p role="status" className="mt-5 rounded border border-dashed p-5 text-sm text-[var(--text-muted)]">Finding source-supported customer similarities…</p>}
    {result && <div className="mt-5 border-t pt-4" aria-busy={busy}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm" role="status">
        <strong>{countsCurrent ? `${result.total.toLocaleString()} unique matching accounts` : `${accounts.length.toLocaleString()} accounts shown`}</strong>
        <span className="text-xs text-[var(--text-muted)]">{busy ? "Refreshing in the background…" : `Page ${result.page} · ${result.pageSize} per page`}</span>
      </div>
      {!countsCurrent && <p className="mb-3 text-xs text-[var(--text-muted)]">{busy || statusBusy ? "Updating counts after your review changes…" : "* Counts are from before your latest review changes. Refresh matches to update them."}</p>}
      {onStatus && <IntelligenceSelectionBar ids={accounts.map(account => account.companyId)} selectedIds={selectedAccounts}
        onSelectionChange={setSelectedAccounts} onStatus={updateStatus} showHidden={showHidden} busy={statusBusy} label="customer matches" />}
      {!accounts.length && <div className="rounded border border-dashed p-5 text-sm text-[var(--text-muted)]">
        <p>{pattern !== "all" && !result.patterns.find(item => item.id === pattern)?.referenceCount
          ? "No website-supported customer reference matches this pattern yet."
          : "No visible, source-supported matches on this page."}</p>
        <p className="mt-1 text-xs">Try another pattern, return to the first page, or use Show hidden to restore dismissed accounts.</p>
      </div>}
      <div className="space-y-3">{accounts.map(account => <CustomerMatchCard key={account.companyId} account={account}
        selected={selectedAccounts.has(account.companyId)} statusBusy={statusBusy} onOpenAccount={onOpenAccount} onStatus={onStatus ? updateStatus : undefined}
        onSelect={onStatus ? checked => setSelectedAccounts(prior => { const next = new Set(prior); if (checked) next.add(account.companyId); else next.delete(account.companyId); return next; }) : undefined} />)}</div>
      {(result.page > 1 || result.hasMore) && <nav className="mt-4 flex flex-wrap items-center gap-3" aria-label="Customer match pages">
        <button type="button" disabled={busy || statusBusy || result.page <= 1} onClick={() => changeView(pattern, result.page - 1)} className="rounded border px-3 py-2 text-sm disabled:opacity-40">Previous 25</button>
        <span className="text-xs text-[var(--text-muted)]">Page {result.page}{countsCurrent && result.total ? ` of ${Math.ceil(result.total / result.pageSize)}` : ""}</span>
        <button type="button" disabled={busy || statusBusy || !result.hasMore} onClick={() => changeView(pattern, result.page + 1)} className="rounded border px-3 py-2 text-sm disabled:opacity-40">Next 25</button>
      </nav>}
      {result.note && <p className="mt-4 text-xs leading-relaxed text-[var(--text-muted)]">{result.note}</p>}
    </div>}
  </section>;
}
