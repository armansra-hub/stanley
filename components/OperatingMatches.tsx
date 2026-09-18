"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { OPERATING_TOPICS, type OperatingTopic } from "@/lib/intelligence/profiles";
import type { TopicSearchResult } from "@/lib/intelligence/topicSearch";

function dated(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Unknown";
}

export default function OperatingMatches({ enabled }: { enabled: boolean }) {
  const [selected, setSelected] = useState<OperatingTopic[]>([]);
  const [result, setResult] = useState<TopicSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  async function search(after?: string | null) {
    if (!selected.length || busy || !enabled) return;
    const current = ++sequence.current;
    setBusy(true); setError(null);
    const params = new URLSearchParams();
    selected.forEach(topic => params.append("topic", topic));
    if (after) params.set("after", after);
    try {
      const response = await fetch(`/api/headhunter/intelligence/topics?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("topic_search_failed");
      const next: TopicSearchResult = await response.json();
      if (current !== sequence.current) return;
      setResult(previous => after && previous ? { ...next,
        accounts: [...previous.accounts, ...next.accounts.filter(account => !previous.accounts.some(prior => prior.companyId === account.companyId))],
      } : next);
    } catch {
      if (current === sequence.current) setError("Could not search cached operating evidence. Try again.");
    } finally { if (current === sequence.current) setBusy(false); }
  }

  return <section className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5" aria-labelledby="operating-matches-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="operating-matches-heading" className="western text-2xl">Find operating matches</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">Find TAM accounts with all the traits you choose. Each trait can come from a different source about the same account.</p>
      </div>
      <span className="rounded-full border px-2.5 py-1 text-xs text-[var(--gold)]">Uses existing research</span>
    </div>
    <fieldset disabled={!enabled || busy} className="mt-4">
      <legend className="mb-2 text-xs text-[var(--text-muted)]">Match every selected trait</legend>
      <div className="flex flex-wrap gap-2">{(Object.entries(OPERATING_TOPICS) as [OperatingTopic, readonly [string, string]][]).map(([id, [label]]) =>
        <label key={id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selected.includes(id) ? "border-[var(--gold)] bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>
          <input type="checkbox" checked={selected.includes(id)} onChange={event => {
            setSelected(prior => event.target.checked ? [...prior, id] : prior.filter(topic => topic !== id));
            setResult(null); setError(null);
          }} />{label}
        </label>
      )}</div>
    </fieldset>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" disabled={!enabled || busy || !selected.length} onClick={() => void search()} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Finding accounts…" : "Find matching accounts"}</button>
      <span className="text-xs text-[var(--text-muted)]">{selected.length ? `${selected.length} ${selected.length === 1 ? "trait" : "traits"} required` : "Select one or more operating traits"}</span>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-[var(--gold)]">{error}</p>}
    {result && <div className="mt-5 border-t pt-4">
      {!result.enabled ? <p className="text-sm text-[var(--text-muted)]">Operating search will be available when intelligence setup is complete.</p> : <>
        <div role="status" className="mb-3 text-sm">
          <strong>{result.accounts.length.toLocaleString()} matching accounts loaded</strong>
          {result.coverage && <p className="mt-1 text-xs text-[var(--text-muted)]">{result.coverage.accountsWithTopicEvidence.toLocaleString()} of {result.coverage.tamAccounts.toLocaleString()} TAM accounts have supported operating traits in the current cache. {result.coverage.interpretedObservations.toLocaleString()} of {result.coverage.currentObservations.toLocaleString()} current observations interpreted.</p>}
          <p className="mt-1 text-xs text-[var(--text-muted)]">{result.note}</p>
        </div>
        {!result.accounts.length && <p className="rounded border border-dashed p-5 text-sm text-[var(--text-muted)]">No supported matches in the current evidence. Try fewer traits, or revisit after more research is collected.</p>}
        <div className="space-y-3">{result.accounts.map(account => <article key={account.companyId} className="rounded-lg border bg-[var(--background)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold"><Link className="text-[var(--gold)] hover:underline" href={`/headhunter/intelligence?companyId=${encodeURIComponent(account.companyId)}`}>{account.name}</Link></h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{[account.subindustry, account.domain].filter(Boolean).join(" · ")}</p>
            </div>
            <span className="text-xs text-[var(--text-muted)]">{account.coverage.interpreted} of {account.coverage.observations} current sources interpreted</span>
          </div>
          <div className="mt-3 space-y-2">{account.topics.map(topic => <details key={topic.id} className="rounded border p-3">
            <summary className="cursor-pointer text-sm font-medium">{topic.label} <span className="font-normal text-[var(--text-muted)]">· source context</span></summary>
            {topic.sources.map(source => <div key={source.observationId} className="mt-3 text-sm">
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{source.title || "Open supporting source"} ↗</a>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Event: {dated(source.eventDate)} · Captured: {dated(source.observedAt)}{source.eventDate && Date.now() - Date.parse(source.eventDate) > 90 * 86400000 ? " · Historical" : ""}</p>
              <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-3 leading-relaxed">{source.contextPreview}{source.previewTruncated ? "…" : ""}</blockquote>
              {source.previewTruncated && <p className="mt-1 text-xs text-[var(--text-muted)]">A verbatim preview of the cited source context. Open the page for the complete passage.</p>}
            </div>)}
          </details>)}</div>
        </article>)}</div>
        {result.hasMore && result.nextCursor && <button type="button" disabled={busy} onClick={() => void search(result.nextCursor)} className="mt-4 rounded-md border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Loading…" : "Load more matching accounts"}</button>}
      </>}
    </div>}
  </section>;
}
