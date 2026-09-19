"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { OPERATING_TOPICS } from "@/lib/intelligence/profiles";
type Source = { observationId: string; url: string; title: string; eventDate: string | null; excerpt: string | null };
type Match = { companyId: string; name: string; subindustry: string | null; sharedTopics: string[]; sources: Source[] };
type Result = { seedTopics: string[]; accounts: Match[]; matchingAccounts: number; hasMore: boolean; nextOffset: number | null; note: string };
function safeUrl(value: string) { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } }
export default function AccountLookalikes({ companyId, refreshKey }: { companyId: string; refreshKey?: string | null }) {
  const [data, setData] = useState<Result | null>(null), [offset, setOffset] = useState(0), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/headhunter/intelligence/lookalikes?companyId=${encodeURIComponent(companyId)}&offset=${offset}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); const next: Result = await response.json(); if (!controller.signal.aborted) { setData(next); setError(""); } })
      .catch(() => { if (!controller.signal.aborted) setError("Similar accounts are temporarily unavailable."); });
    return () => controller.abort();
  }, [companyId, refreshKey, offset]);
  const label = (topic: string) => OPERATING_TOPICS[topic as keyof typeof OPERATING_TOPICS] ?? topic.replace(/_/g, " ");
  return <section aria-label="Similar operating patterns" className="mb-6 rounded-lg border bg-[var(--surface)] p-5">
    <h2 className="western text-2xl">Similar operating patterns</h2>
    <p className="mt-2 text-sm text-[var(--text-muted)]">Find other TAM accounts with the same sourced operating traits.</p>
    {error && <p role="status" className="mt-2 text-sm">{error}</p>}
    {data && <><p className="mt-2 text-xs text-[var(--text-muted)]">{data.seedTopics.length ? `${data.matchingAccounts} accounts match this account’s operating evidence.` : "More interpreted evidence is needed to find similar accounts."}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">{data.accounts.map(account => <article key={account.companyId} className="rounded border p-3">
        <Link href={`/headhunter/intelligence?companyId=${account.companyId}`} className="font-semibold text-[var(--gold)] hover:underline">{account.name}</Link>
        {account.subindustry && <p className="text-xs text-[var(--text-muted)]">{account.subindustry}</p>}
        <p className="mt-2 text-sm">{account.sharedTopics.map(label).join(" · ")}</p>
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Supporting sources</summary>{account.sources.map(source => <p key={source.observationId} className="mt-2"><a href={safeUrl(source.url)} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}</a>{source.eventDate ? ` · ${source.eventDate.slice(0, 10)}` : ""}{source.excerpt && <span className="mt-1 block text-[var(--text-muted)]">{source.excerpt}</span>}</p>)}</details>
      </article>)}</div>
      {(offset>0 || data.hasMore) && <div className="mt-3 flex gap-3 text-sm"><button disabled={offset===0} className="rounded border px-3 py-1 disabled:opacity-50" onClick={() => setOffset(Math.max(0,offset-8))}>Previous</button><button disabled={!data.hasMore} className="rounded border px-3 py-1 disabled:opacity-50" onClick={() => setOffset(data.nextOffset ?? offset)}>Next matches</button></div>}
      <p className="mt-3 text-xs text-[var(--text-muted)]">{data.note}</p></>}
  </section>;
}
