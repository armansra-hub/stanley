"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { OPERATING_TOPICS, type OperatingTopic } from "@/lib/intelligence/profiles";
import type { TopicSearchResult } from "@/lib/intelligence/topicSearch";
import IntelligenceVisibility from "./IntelligenceVisibility";
import CopyButton, { bareDomain } from "./CopyButton";
import type { VisibilityMode } from "@/lib/intelligence/visibility";

function dated(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Unknown";
}

export default function OperatingMatches({ enabled, refreshKey, onOpenAccount }: { enabled: boolean; refreshKey?: string | null; onOpenAccount?: (id: string, name: string) => void }) {
  const [mode, setMode] = useState<"all" | "any">("all");
  const [visibility, setVisibility] = useState<VisibilityMode>("supported");
  const [counts, setCounts] = useState<TopicSearchResult | null>(null);
  const [selected, setSelected] = useState<OperatingTopic[]>([]);
  const [result, setResult] = useState<TopicSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const requestBusy = useRef(false);
  const searched = useRef(false);

  const search = useCallback(async (after?: string | null, refresh = false) => {
    if (!selected.length || (requestBusy.current && !refresh) || !enabled) return;
    const current = ++sequence.current;
    requestBusy.current = true;
    searched.current = true;
    setBusy(true); setError(null);
    const params = new URLSearchParams();
    selected.forEach(topic => params.append("topic", topic));
    params.set("mode", mode);
    params.set("visibility", visibility);
    if (after) params.set("after", after);
    try {
      const response = await fetch(`/api/headhunter/intelligence/topics?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("topic_search_failed");
      const next: TopicSearchResult = await response.json();
      if (current !== sequence.current) return;
      setCounts(next);
      setResult(previous => after && previous ? { ...next,
        accounts: [...previous.accounts, ...next.accounts.filter(account => !previous.accounts.some(prior => prior.companyId === account.companyId))],
      } : next);
    } catch {
      if (current === sequence.current) setError("Could not search cached operating evidence. Try again.");
    } finally { if (current === sequence.current) { setBusy(false); requestBusy.current = false; } }
  }, [selected, enabled, mode, visibility]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(`/api/headhunter/intelligence/topics?visibility=${visibility}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); const value: TopicSearchResult = await response.json(); if (!controller.signal.aborted) setCounts(value); })
      .catch(() => { /* Unavailable counts remain unknown rather than becoming zero. */ });
    return () => controller.abort();
  }, [enabled, refreshKey, visibility]);

  useEffect(() => { if (searched.current) void search(undefined, true); }, [refreshKey, search]);
  useEffect(() => () => { sequence.current++; }, []);

  return <section className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5" aria-labelledby="operating-matches-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="operating-matches-heading" className="western text-2xl">Find operating matches</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">Find TAM accounts with any or all of the traits you choose. Each trait can come from a different source about the same account.</p>
      </div>
      <span className="rounded-full border px-2.5 py-1 text-xs text-[var(--gold)]">Uses existing research</span>
    </div>
    <fieldset disabled={!enabled || busy} className="mt-4">
      <label className="mb-3 block text-sm">Evidence visibility <select value={visibility} onChange={event => { searched.current = false; setVisibility(event.target.value as VisibilityMode); setResult(null); setCounts(null); setError(null); }} className="ml-2 rounded border bg-[var(--background)] px-2 py-1"><option value="supported">Supported · 80%+</option><option value="explore">Explore native answers · 50%+</option></select></label>
      <legend className="mb-2 text-xs text-[var(--text-muted)]">Choose up to 8 traits. Counts show distinct TAM accounts at the selected visibility level.</legend>
      <div className="mb-3 flex gap-4 text-sm">{(["any", "all"] as const).map(value => <label key={value} className="flex items-center gap-2"><input type="radio" name="operating-match-mode" value={value} checked={mode === value} onChange={() => { searched.current = false; setMode(value); setResult(null); setError(null); }} />{value === "any" ? "Any selected trait" : "All selected traits"}</label>)}</div>
      <div className="flex flex-wrap gap-2">{(Object.entries(OPERATING_TOPICS) as [OperatingTopic, readonly [string, string]][]).map(([id, [label]]) =>
        <label key={id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selected.includes(id) ? "border-[var(--gold)] bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>
          <input type="checkbox" disabled={selected.length >= 8 && !selected.includes(id)} checked={selected.includes(id)} onChange={event => {
            searched.current = false;
            setSelected(prior => event.target.checked ? [...prior, id] : prior.filter(topic => topic !== id));
            setResult(null); setError(null);
          }} />{label} <span className="text-xs">{counts?.topicCounts[id] === undefined ? "(count unavailable)" : `(${counts.topicCounts[id]!.toLocaleString()})`}</span>
        </label>
      )}</div>
    </fieldset>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" disabled={!enabled || busy || !selected.length} onClick={() => void search()} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Finding accounts…" : "Find matching accounts"}</button>
      <span className="text-xs text-[var(--text-muted)]">{selected.length ? `${selected.length} selected · ${mode === "all" ? "all required" : "at least one required"}` : "Select one or more operating traits"}</span>
    </div>
    {counts?.coverage && <p className="mt-3 text-xs text-[var(--text-muted)]">{counts.coverage.accountsWithTopicEvidence.toLocaleString()} of {counts.coverage.tamAccounts.toLocaleString()} TAM accounts have traits at this visibility level{counts.coverage.accountsWithNoInterpretedEvidence !== undefined ? `; ${counts.coverage.accountsWithNoInterpretedEvidence.toLocaleString()} have no interpreted evidence yet` : ""}. Missing support means unknown, not that a company lacks the trait.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-[var(--gold)]">{error}</p>}
    {result && <div className="mt-5 border-t pt-4">
      {!result.enabled ? <p className="text-sm text-[var(--text-muted)]">Operating search will be available when intelligence setup is complete.</p> : <>
        <div role="status" className="mb-3 text-sm">
          <strong>{result.accounts.length.toLocaleString()} matching accounts loaded{result.coverage ? ` of ${result.coverage.matchingAccounts.toLocaleString()} cached matches` : ""}</strong>
          {result.coverage && <p className="mt-1 text-xs text-[var(--text-muted)]">{result.coverage.accountsWithTopicEvidence.toLocaleString()} of {result.coverage.tamAccounts.toLocaleString()} TAM accounts have operating traits at this visibility level in the current cache. {result.coverage.interpretedObservations.toLocaleString()} of {result.coverage.currentObservations.toLocaleString()} current observations interpreted.</p>}
          <p className="mt-1 text-xs text-[var(--text-muted)]">{result.note}</p>
        </div>
        {!result.accounts.length && <p className="rounded border border-dashed p-5 text-sm text-[var(--text-muted)]">No matches at this visibility level in the current evidence. Try Any selected trait or fewer traits, or revisit after more research is collected.</p>}
        <div className="space-y-3">{result.accounts.map(account => <article key={account.companyId} className="rounded-lg border bg-[var(--background)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
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
            <span className="text-xs text-[var(--text-muted)]">{account.coverage.interpreted} of {account.coverage.observations} current sources interpreted</span>
          </div>
          <div className="mt-3 space-y-2">{account.topics.map(topic => <details key={topic.id} className="rounded border p-3">
            <summary className="cursor-pointer text-sm font-medium">{topic.label} <span className="font-normal text-[var(--text-muted)]">· {topic.state === "exploratory" ? "exploratory native answer" : "source context"}</span></summary>
            {topic.sources.map(source => <div key={source.observationId} className="mt-3 text-sm">
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{source.title || "Open supporting source"} ↗</a>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Native topic probability {Math.round(source.probability * 100)}% · company relevance {typeof source.companyRelevance === "number" ? `${Math.round(source.companyRelevance * 100)}%` : "unknown"}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Event: {dated(source.eventDate)} · Captured: {dated(source.observedAt)}{source.eventDate && Date.now() - Date.parse(source.eventDate) > 90 * 86400000 ? " · Historical" : ""}</p>
              <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 leading-relaxed">{source.contextPreview}{source.previewTruncated ? "…" : ""}</blockquote>
              {source.previewTruncated && <p className="mt-1 text-xs text-[var(--text-muted)]">A verbatim preview of the cited source context. Open the page for the complete passage.</p>}
            </div>)}
          </details>)}</div>
        </article>)}</div>
        {result.hasMore && result.nextCursor && <button type="button" disabled={busy} onClick={() => void search(result.nextCursor)} className="mt-4 rounded-md border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Loading…" : "Load more matching accounts"}</button>}
      </>}
    </div>}
    <IntelligenceVisibility />
  </section>;
}
