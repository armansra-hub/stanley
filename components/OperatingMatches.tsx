"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { OPERATING_TOPICS } from "@/lib/intelligence/profiles";
import { OPERATING_FACETS, OPERATING_COMBINATION_RECIPES, OPERATING_INDUSTRY_GUIDES } from "@/lib/intelligence/operatingCatalog";
import { operatingRecipe } from "@/lib/intelligence/operatingSearchCatalog";
import type { SearchOperatingTopic, TopicSearchResult } from "@/lib/intelligence/topicSearch";
import IntelligenceVisibility from "./IntelligenceVisibility";
import CopyButton, { bareDomain } from "./CopyButton";
import IntelligenceDismissButton from "./IntelligenceDismissButton";
import IntelligenceSelectionBar from "./IntelligenceSelectionBar";
import { hiddenIntelligenceLead } from "./intelligenceLeadStatus";
import type { VisibilityMode } from "@/lib/intelligence/visibility";
import RecentCustomerMatches from "./RecentCustomerMatches";

function dated(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Unknown";
}

export function operatingAccountsWithStatus(accounts: TopicSearchResult["accounts"], overrides: Record<string, "new" | "dismissed">, showHidden: boolean) {
  return accounts.map(account => ({ ...account, status: (overrides[account.companyId] ?? account.status) as string }))
    .filter(account => showHidden || !hiddenIntelligenceLead(account.status));
}

export type OperatingMatchesProps = {
  enabled: boolean; refreshKey?: string | null; onOpenAccount?: (id: string, name: string) => void;
  showHidden?: boolean; statusBusy?: boolean; statusOverrides?: Record<string, "new" | "dismissed">;
  onStatus?: (ids: string[], status: "new" | "dismissed") => Promise<boolean>;
};

export default function OperatingMatches(props: OperatingMatchesProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedVisited, setAdvancedVisited] = useState(false);
  return <>
    <RecentCustomerMatches {...props} />
    <details className="mb-6 rounded-lg border bg-[var(--surface)]" open={advancedOpen} onToggle={event => {
      const open = event.currentTarget.open;
      setAdvancedOpen(open);
      if (open) setAdvancedVisited(true);
    }}>
      <summary className="cursor-pointer px-4 py-4 sm:px-5">
        <span className="font-semibold">All characteristics</span>
        <span className="ml-2 text-xs text-[var(--text-muted)]">47 categories · 22 existing traits · 10 research combinations</span>
      </summary>
      {advancedVisited && <AdvancedOperatingMatches {...props} enabled={props.enabled && advancedOpen} />}
    </details>
  </>;
}

function AdvancedOperatingMatches({ enabled, refreshKey, onOpenAccount, showHidden = false, statusBusy = false, statusOverrides = {}, onStatus }: OperatingMatchesProps) {
  const [mode, setMode] = useState<"all" | "any">("all");
  const [visibility, setVisibility] = useState<VisibilityMode>("supported");
  const [counts, setCounts] = useState<TopicSearchResult | null>(null);
  const [selected, setSelected] = useState<SearchOperatingTopic[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [traitFilter, setTraitFilter] = useState("");
  const [result, setResult] = useState<TopicSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set<string>());
  const [countsStatusSignature, setCountsStatusSignature] = useState("");
  const [resultStatusSignature, setResultStatusSignature] = useState("");
  const [countsRefreshing, setCountsRefreshing] = useState(false);
  const sequence = useRef(0);
  const requestBusy = useRef(false);
  const statusWriting = useRef(false);
  const searched = useRef(false);
  const resultRef = useRef(result);
  resultRef.current = result;
  const countsRefreshKey = JSON.stringify([enabled, refreshKey ?? null, visibility, showHidden]);
  const previousCountsRefreshKey = useRef<string | null>(null);
  const statusSignature = JSON.stringify(statusOverrides);
  const statusSignatureRef = useRef(statusSignature);
  const statusBusyRef = useRef(statusBusy);
  statusSignatureRef.current = statusSignature;
  statusBusyRef.current = statusBusy;

  const search = useCallback(async (after?: string | null, refresh = false) => {
    if (!selected.length || (requestBusy.current && !refresh) || !enabled) return;
    const current = ++sequence.current;
    const requestedStatusSignature = statusSignatureRef.current;
    const startedDuringWrite = statusBusyRef.current;
    requestBusy.current = true;
    searched.current = true;
    setBusy(true); setError(null); setRefreshNotice(null);
    const params = new URLSearchParams();
    selected.forEach(topic => params.append("topic", topic));
    if (recipeId) params.set("recipe", recipeId);
    params.set("mode", mode);
    params.set("visibility", visibility);
    if (showHidden) params.set("showHidden", "true");
    if (after) params.set("after", after);
    try {
      const response = await fetch(`/api/headhunter/intelligence/topics?${params}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("topic_search_failed");
      const next: TopicSearchResult = await response.json();
      if (current !== sequence.current) return;
      if (!startedDuringWrite && !statusBusyRef.current && requestedStatusSignature === statusSignatureRef.current) {
        setCounts(next); setCountsStatusSignature(requestedStatusSignature);
      }
      setResultStatusSignature(startedDuringWrite ? "pending" : requestedStatusSignature);
      setResult(previous => after && previous ? { ...next,
        accounts: [...previous.accounts, ...next.accounts.filter(account => !previous.accounts.some(prior => prior.companyId === account.companyId))],
      } : next);
    } catch {
      if (current === sequence.current) {
        if (resultRef.current) setRefreshNotice(after
          ? "Could not load more matches. Your previously loaded matches are still shown; try Load more again."
          : "Could not refresh operating matches. Previously loaded matches are still shown and may not include every account for the current filters. Try Find matching accounts again.");
        else setError("Could not search cached operating evidence. Try again.");
      }
    } finally { if (current === sequence.current) { setBusy(false); requestBusy.current = false; } }
  }, [selected, recipeId, enabled, mode, visibility, showHidden]);

  useEffect(() => {
    const regularRefresh = previousCountsRefreshKey.current !== countsRefreshKey;
    previousCountsRefreshKey.current = countsRefreshKey;
    if (!enabled || statusBusy) return;
    // An active search already returns all category counts on ordinary refreshes.
    // Status-only updates instead refresh counts without repeating the result search.
    if (regularRefresh && searched.current) { setCountsRefreshing(false); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); setCountsRefreshing(false); }, 15_000);
    setCountsRefreshing(true);
    void fetch(`/api/headhunter/intelligence/topics?visibility=${visibility}&showHidden=${showHidden}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); const value: TopicSearchResult = await response.json(); if (!controller.signal.aborted) { setCounts(value); setCountsStatusSignature(statusSignature); } })
      .catch(() => { /* Unavailable counts remain unknown rather than becoming zero. */ })
      .finally(() => { clearTimeout(timeout); if (!controller.signal.aborted) setCountsRefreshing(false); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [enabled, countsRefreshKey, visibility, showHidden, statusSignature, statusBusy]);

  useEffect(() => { if (searched.current) void search(undefined, true); }, [refreshKey, search]);
  useEffect(() => { setSelectedAccounts(new Set()); }, [selected, recipeId, mode, visibility, showHidden]);
  useEffect(() => () => { sequence.current++; }, []);

  const accounts = operatingAccountsWithStatus(result?.accounts ?? [], statusOverrides, showHidden);
  const updateStatus = async (ids: string[], status: "new" | "dismissed") => {
    if (!onStatus || statusBusy || statusWriting.current) return false;
    const loaded = new Set(accounts.map(account => account.companyId));
    const exactIds = [...new Set(ids)].filter(id => loaded.has(id));
    if (!exactIds.length) return false;
    statusWriting.current = true;
    setError(null);
    try {
      const saved = await onStatus(exactIds, status);
      if (saved) setSelectedAccounts(new Set());
      else setError("Could not confirm the review decision. Your selection is kept. Refresh to check its current status before trying again.");
      return saved;
    } catch {
      setError("Could not confirm the review decision. Your selection is kept. Refresh to check its current status before trying again.");
      return false;
    } finally { statusWriting.current = false; }
  };
  const clearSearch = () => {
    searched.current = false; sequence.current++; requestBusy.current = false;
    setBusy(false); setResult(null); setError(null); setRefreshNotice(null); setSelectedAccounts(new Set());
  };
  const recipe = recipeId ? operatingRecipe(recipeId) : null;
  const groups = [...new Set(OPERATING_FACETS.map(facet => facet.group))];
  const choose = (id: SearchOperatingTopic, checked: boolean) => {
    clearSearch(); setRecipeId("");
    setSelected(prior => checked ? [...prior, id] : prior.filter(topic => topic !== id));
  };
  const trait = (id: SearchOperatingTopic, label: string, definition: string, boundary?: string) =>
    <label key={id} title={[definition, boundary].filter(Boolean).join(" ")} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${selected.includes(id) ? "border-[var(--gold)] bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>
      <input className="mt-1" type="checkbox" disabled={selected.length >= 8 && !selected.includes(id)} checked={selected.includes(id)} onChange={event => choose(id, event.target.checked)} />
      <span>{label} <span className="text-xs">{counts?.topicCounts[id] === undefined ? "(count unavailable)" : `(${counts.topicCounts[id]!.toLocaleString()})`}</span>
        <span className="mt-1 block text-xs opacity-80">{definition}</span></span>
    </label>;

  return <section className="border-t p-4 sm:p-5" aria-labelledby="operating-matches-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="operating-matches-heading" className="western text-2xl">Find operating matches</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">Find TAM accounts with any or all of the traits you choose. Each trait can come from a different source about the same account.</p>
      </div>
      <span className="rounded-full border px-2.5 py-1 text-xs text-[var(--gold)]">Uses existing research</span>
    </div>
    <fieldset disabled={!enabled || busy} className="mt-4">
      <label className="mb-3 block text-sm">Legacy evidence visibility <select value={visibility} onChange={event => { clearSearch(); setVisibility(event.target.value as VisibilityMode); setCounts(null); }} className="ml-2 rounded border bg-[var(--background)] px-2 py-1"><option value="supported">Supported · 80%+</option><option value="explore">Explore native answers · 50%+</option></select></label>
      <p className="mb-3 text-xs text-[var(--text-muted)]">The 47 new categories use Jev’s native classification. This probability selector applies to the existing traits only.</p>
      <legend className="mb-2 text-xs text-[var(--text-muted)]">Choose up to 8 traits. Counts show distinct TAM accounts at the selected visibility level.</legend>
      <label className="mb-3 block text-sm">Research combinations <select value={recipeId} onChange={event => {
        const next = operatingRecipe(event.target.value); clearSearch(); setRecipeId(event.target.value);
        setSelected(next ? next.topics as SearchOperatingTopic[] : []);
      }} className="mt-1 block w-full rounded border bg-[var(--background)] px-2 py-2"><option value="">Choose traits yourself</option>{OPERATING_COMBINATION_RECIPES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {recipe && <div className="mb-3 rounded border p-3 text-xs text-[var(--text-muted)]"><p>{recipe.boundary}</p><p className="mt-1">{recipe.interpretation}</p><p className="mt-1">Requires {recipe.combinations.map(branch => branch.map(id => OPERATING_FACETS.find(f => f.id === id)?.label ?? OPERATING_TOPICS[id as keyof typeof OPERATING_TOPICS]?.[0] ?? id).join(" + ")).join(" OR ")}.</p></div>}
      <div className="mb-3 flex gap-4 text-sm">{(["any", "all"] as const).map(value => <label key={value} className="flex items-center gap-2"><input type="radio" name="operating-match-mode" value={value} checked={!recipe && mode === value} onChange={() => { clearSearch(); setRecipeId(""); setMode(value); }} />{value === "any" ? "Any selected trait" : "All selected traits"}</label>)}</div>
      <input aria-label="Filter operating categories" value={traitFilter} onChange={event => setTraitFilter(event.target.value)} placeholder="Filter categories by industry or operating model…" className="mb-3 w-full rounded border bg-[var(--background)] px-3 py-2 text-sm" />
      <div className="space-y-2">{groups.map(group => {
        const facets = OPERATING_FACETS.filter(f => f.group === group && `${f.label} ${f.definition} ${f.industries.join(" ")}`.toLowerCase().includes(traitFilter.toLowerCase()));
        return facets.length ? <details key={group} open={traitFilter ? true : undefined} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{group} <span className="text-[var(--text-muted)]">· {facets.length} categories{facets.some(f => selected.includes(f.id)) ? ` · ${facets.filter(f => selected.includes(f.id)).length} selected` : ""}</span></summary><div className="mt-3 grid gap-2 sm:grid-cols-2">{facets.map(f => trait(f.id, f.label, f.definition, f.boundary))}</div></details> : null;
      })}
      <details open={traitFilter ? true : undefined} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">Existing operating traits · 22 categories</summary><div className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(OPERATING_TOPICS).filter(([, [label, definition]]) => `${label} ${definition}`.toLowerCase().includes(traitFilter.toLowerCase())).map(([id, [label, definition]]) => trait(id as SearchOperatingTopic, label, definition))}</div></details></div>
    </fieldset>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" disabled={!enabled || busy || !selected.length} onClick={() => void search()} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Finding accounts…" : "Find matching accounts"}</button>
      <span className="text-xs text-[var(--text-muted)]">{selected.length ? `${selected.length} selected · ${recipe ? "research combination" : mode === "all" ? "all required" : "at least one required"}` : "Select one or more operating traits"}</span>
      {!!selected.length && <button type="button" disabled={busy} className="text-xs underline disabled:opacity-50" onClick={() => { clearSearch(); setSelected([]); setRecipeId(""); }}>Clear selection</button>}
    </div>
    {counts && (statusBusy || countsStatusSignature !== statusSignature) && <p role="status" className="mt-2 text-xs text-[var(--text-muted)]">{statusBusy || countsRefreshing ? "Updating category counts in the background…" : "Category counts are from before the latest status change. Refresh to update them."}</p>}
    {counts?.catalogCoverage && <div className="mt-3 rounded border p-3 text-xs text-[var(--text-muted)]"><strong>New category coverage:</strong> {counts.catalogCoverage.complete.toLocaleString()} of {counts.catalogCoverage.total.toLocaleString()} accounts evaluated for all 47 public categories · {counts.catalogCoverage.partial.toLocaleString()} partially evaluated · {counts.catalogCoverage.pending.toLocaleString()} awaiting evaluation{counts.catalogCoverage.blocked ? ` · ${counts.catalogCoverage.blocked.toLocaleString()} have a source or processing gap` : ""}. Earlier interpreted-source counts do not mean these new questions have been answered.</div>}
    <details className="mt-3 rounded border p-3 text-xs text-[var(--text-muted)]"><summary className="cursor-pointer font-medium">Industry guidance behind the categories · 35 research lenses</summary><p className="mt-2">These guides help Jev interpret the company's own operating model. They are research hypotheses, not evidence that the company has a finance problem.</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{OPERATING_INDUSTRY_GUIDES.map(guide => <div key={guide.id}><strong>{guide.label}</strong><p>{guide.guidance}</p><p className="mt-1">{guide.boundary}</p></div>)}</div></details>
    {counts?.coverage && <p className="mt-3 text-xs text-[var(--text-muted)]">{counts.coverage.accountsWithTopicEvidence.toLocaleString()} of {counts.coverage.tamAccounts.toLocaleString()} TAM accounts have traits at this visibility level{counts.coverage.accountsWithNoInterpretedEvidence !== undefined ? `; ${counts.coverage.accountsWithNoInterpretedEvidence.toLocaleString()} have no interpreted evidence yet` : ""}. Missing support means unknown, not that a company lacks the trait.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-[var(--gold)]">{error}</p>}
    {refreshNotice && <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">{refreshNotice}</p>}
    {result && <div className="mt-5 border-t pt-4">
      {!result.enabled ? <p className="text-sm text-[var(--text-muted)]">Operating search will be available when intelligence setup is complete.</p> : <>
        <div role="status" className="mb-3 text-sm">
          <strong>{accounts.length.toLocaleString()} matching accounts loaded{result.coverage && resultStatusSignature === statusSignature && !statusBusy ? ` of ${result.coverage.matchingAccounts.toLocaleString()} cached matches` : ""}</strong>
          {result.coverage && <p className="mt-1 text-xs text-[var(--text-muted)]">{result.coverage.accountsWithTopicEvidence.toLocaleString()} of {result.coverage.tamAccounts.toLocaleString()} TAM accounts have operating traits at this visibility level in the current cache. {result.coverage.interpretedObservations.toLocaleString()} of {result.coverage.currentObservations.toLocaleString()} current observations interpreted.</p>}
          <p className="mt-1 text-xs text-[var(--text-muted)]">{result.note}</p>
        </div>
        {onStatus && <IntelligenceSelectionBar ids={accounts.map(account => account.companyId)} selectedIds={selectedAccounts} onSelectionChange={setSelectedAccounts} onStatus={updateStatus} showHidden={showHidden} busy={statusBusy} label="operating matches" />}
        {!accounts.length && <p className="rounded border border-dashed p-5 text-sm text-[var(--text-muted)]">No visible matches loaded. Try Show hidden to restore dismissed accounts, load more matches, or choose different traits.</p>}
        <div className="space-y-3">{accounts.map(account => <article key={account.companyId} className={`rounded-lg border bg-[var(--background)] p-4 ${selectedAccounts.has(account.companyId) ? "border-[var(--gold)]" : ""}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-3">
              {onStatus && <input type="checkbox" className="mt-1" aria-label={`Select ${account.name}`} checked={selectedAccounts.has(account.companyId)} disabled={statusBusy} onChange={event => setSelectedAccounts(prior => {
                const next = new Set(prior); if (event.target.checked) next.add(account.companyId); else next.delete(account.companyId); return next;
              })} />}
              <div>
              <h3 className="group flex items-center gap-1.5 font-semibold">
                {onOpenAccount ? <button type="button" className="text-[var(--gold)] hover:underline" onClick={() => onOpenAccount(account.companyId, account.name)}>{account.name}</button> : <Link className="text-[var(--gold)] hover:underline" href={`/headhunter/intelligence?companyId=${encodeURIComponent(account.companyId)}`}>{account.name}</Link>}
                <CopyButton value={account.name} label="company name">⧉</CopyButton>
              </h3>
              {account.domain && <div className="group mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)]">
                {bareDomain(account.domain)}
                <CopyButton value={bareDomain(account.domain)} label="website">⧉</CopyButton>
              </div>}
              {account.subindustry && <p className="text-[10px] text-[var(--text-muted)]">{account.subindustry}</p>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--text-muted)]">{account.topics.some(topic => topic.classification === "native_choice") ? `Native classifications from ${account.coverage.citedObservations} saved sources` : `${account.coverage.interpreted} of ${account.coverage.observations} current sources interpreted`}</span>
              {onStatus && <IntelligenceDismissButton companyId={account.companyId} name={account.name} status={account.status} busy={statusBusy} onStatus={(id, status) => updateStatus([id], status)} />}
            </div>
          </div>
          <div className="mt-3 space-y-2">{account.topics.map(topic => <details key={topic.id} className="rounded border p-3">
            <summary className="cursor-pointer text-sm font-medium">{topic.label} <span className="font-normal text-[var(--text-muted)]">· {topic.state === "exploratory" ? "exploratory native answer" : "source context"}</span></summary>
            {topic.discoveryHypothesis && <p className="mt-2 text-xs text-[var(--text-muted)]">Discovery hypothesis, not a confirmed problem: {topic.discoveryHypothesis}</p>}
            {topic.boundary && <p className="mt-2 text-xs text-[var(--text-muted)]">Category boundary: {topic.boundary}</p>}
            {topic.sources.map(source => <div key={`${source.observationId}:${source.start}:${source.end}`} className="mt-3 text-sm">
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{source.title || "Open supporting source"} ↗</a>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{topic.classification === "native_choice" ? "Jev native decision: supported" : "Native topic probability"}{typeof source.probability === "number" ? ` ${Math.round(source.probability * 100)}%` : ""}{topic.classification !== "native_choice" ? ` · company relevance ${typeof source.companyRelevance === "number" ? `${Math.round(source.companyRelevance * 100)}%` : "unknown"}` : " · supplied source context"}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Event: {dated(source.eventDate)} · Captured: {dated(source.observedAt)}{source.eventDate && Date.now() - Date.parse(source.eventDate) > 90 * 86400000 ? " · Historical" : ""}</p>
              <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 leading-relaxed">{source.contextPreview}{source.previewTruncated ? "…" : ""}</blockquote>
              {source.previewTruncated && <p className="mt-1 text-xs text-[var(--text-muted)]">A verbatim preview of the cited source context. Open the page for the complete passage.</p>}
            </div>)}
            {topic.nativeResult != null && <details className="mt-3 text-xs"><summary className="cursor-pointer">Raw Jev answer</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(topic.nativeResult, null, 2)}</pre></details>}
          </details>)}</div>
        </article>)}</div>
        {result.hasMore && result.nextCursor && <button type="button" disabled={busy} onClick={() => void search(result.nextCursor)} className="mt-4 rounded-md border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Loading…" : "Load more matching accounts"}</button>}
      </>}
    </div>}
    <IntelligenceVisibility />
  </section>;
}
