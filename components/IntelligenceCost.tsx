"use client";

import { useState } from "react";
import type { JevCostGroup, JevCostSnapshot } from "@/lib/intelligence/costMetricsTypes";

const labels: Record<string, string> = {
  website_research: "Website research", news_research: "News research", hiring_research: "Hiring research",
  government_research: "Government research", public_research_other: "Other public research",
  public_interpretation: "Public research", research_ranking: "Choosing the next research page",
  saved_view: "Saved research questions", private_tam: "Private TAM excerpts",
  initial_coverage: "Initial coverage", monitoring: "Ongoing monitoring", manual: "Requested manually",
  unattributed: "Other / unattributed", historical_unattributed: "Unattributed history",
};
const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const count = (value: number) => value.toLocaleString("en-US");

function CostTable({ rows, label }: { rows: JevCostGroup[]; label: string }) {
  return <div className="mt-3 overflow-x-auto">
    <table aria-label={label} className="w-full min-w-[620px] text-left text-xs">
      <thead className="border-b text-[var(--text-muted)]"><tr>
        <th scope="col" className="py-2 pr-3 font-normal">{label}</th>
        <th scope="col" className="px-3 py-2 text-right font-normal">Recorded requests</th>
        <th scope="col" className="px-3 py-2 text-right font-normal">Reported input tokens</th>
        <th scope="col" className="px-3 py-2 text-right font-normal">Known usage estimate</th>
        <th scope="col" className="py-2 pl-3 text-right font-normal">Uncertain / in progress</th>
      </tr></thead>
      <tbody>{[...rows].sort((a, b) => b.estimatedUsd - a.estimatedUsd || a.key.localeCompare(b.key)).map(row => <tr key={row.key} className="border-b last:border-0">
        <th scope="row" className="py-2 pr-3 font-medium">{labels[row.key] ?? row.key.replaceAll("_", " ")}</th>
        <td className="px-3 py-2 text-right tabular-nums">{count(row.requests)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{count(row.reportedInputTokens)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{usd(row.estimatedUsd)}</td>
        <td className="py-2 pl-3 text-right tabular-nums">{usd(row.unknownUsageReserveUsd + row.inFlightReserveUsd)}</td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="py-3 text-xs text-[var(--text-muted)]">No recorded Jev requests in this period.</p>}
  </div>;
}

export default function IntelligenceCost({ cost }: { cost: JevCostSnapshot | undefined }) {
  const [period, setPeriod] = useState<"month" | "last24h">("month");
  if (!cost?.available) return <section aria-label="Jev usage and cost" className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <h2 className="western text-2xl">Jev usage and cost</h2>
    <p className="mt-2 text-sm text-[var(--text-muted)]">Cost details are temporarily unavailable. Refresh to try again; this does not mean usage is zero.</p>
  </section>;
  const selected = cost[period], totals = selected.totals;
  const hasUnattributedHistory = selected.byPurpose.some(group => group.key === "historical_unattributed");
  return <section aria-label="Jev usage and cost" className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="western text-2xl">Jev usage and cost</h2>
      <div className="flex gap-1 rounded-md border p-1 text-xs" aria-label="Cost period">
        {([['month', 'This month (UTC)'], ['last24h', 'Last 24 hours']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={period === value}
          onClick={() => setPeriod(value)} className={`rounded px-2 py-1 ${period === value ? "bg-[var(--surface-2)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{label}</button>)}
      </div>
    </div>
    <p className="mt-2 text-xs text-[var(--text-muted)]">Direct TypeSafe usage reported to Stanley. Claude and other providers are excluded.</p>
    <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Known usage estimate</p><p className="mt-1 text-xl font-semibold tabular-nums">{usd(totals.estimatedUsd)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{count(totals.knownUsageRequests)} requests with reported usage</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Reported input tokens</p><p className="mt-1 text-xl font-semibold tabular-nums">{count(totals.reportedInputTokens)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">Provider-reported token counts</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Usage not returned</p><p className="mt-1 text-xl font-semibold tabular-nums">{usd(totals.unknownUsageReserveUsd)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">Conservative allowance for {count(totals.unknownUsageRequests)} requests; actual charge unknown</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">In progress / unsettled</p><p className="mt-1 text-xl font-semibold tabular-nums">{usd(totals.inFlightReserveUsd)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{count(totals.inFlightRequests)} budget reservations; not confirmed charges</p></div>
    </div>
    <details className="mt-4 border-t pt-3" open>
      <summary className="cursor-pointer text-sm font-medium">Where Jev usage is going</summary>
      <CostTable rows={selected.byActivity} label="Research activity" />
      <CostTable rows={selected.byWorkload} label="Workload" />
      <p className="mt-2 text-xs text-[var(--text-muted)]">Initial coverage identifies baseline website research. Ongoing monitoring includes news, hiring scans and automatic deeper research. These labels are recorded when new work runs.</p>
    </details>
    <p className="mt-3 text-xs text-[var(--text-muted)]">Estimates use ${cost.usdPerMillionInputTokens.toFixed(3)} per million input tokens with per-request accounting rounding; TypeSafe billing is the invoice authority. Recorded requests include reservations awaiting a result. Reusing a saved answer makes no new provider request.</p>
    {hasUnattributedHistory && <p className="mt-2 text-xs text-[var(--text-muted)]">Older requests did not record their purpose. Their reported tokens and cost remain included under Unattributed history; they are not guessed into research or TAM.</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">{cost.attributionStartedAt ? `Detailed attribution started ${new Date(cost.attributionStartedAt).toLocaleString()}. ` : "Detailed attribution will appear with new requests. "}Updated {new Date(cost.asOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
  </section>;
}
