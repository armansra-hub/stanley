"use client";
import React, { useEffect, useState } from "react";
import type { JevBudgetSnapshot } from "@/lib/intelligence/budgetStatus";

const usd = (amount: number) => amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const date = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" });
const waiting = (reason: string) => reason === "provider_insufficient_credit"
  ? "TypeSafe reported insufficient credit. Add funds in TypeSafe to resume."
  : reason === "provider_billing_unavailable" ? "TypeSafe rejected billing for a request. Check the balance and billing status in TypeSafe."
  : `Waiting: ${reason.replaceAll("_", " ")}.`;

/** Pure display shared by the live panel and contract tests. No activation writes. */
export function IntelligenceBudgetDetails({ budget }: { budget: Exclude<JevBudgetSnapshot, { available: false }> }) {
  if (budget.enforcement === "provider_balance") return <>
    <p className="mt-2">{budget.enabled ? "Jev processing is available." : "Jev processing is paused."} TypeSafe credit controls spending. Stanley applies no daily allowance, initial catch-up cap, or two-month spending stop.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <p><strong>{usd(budget.todayUsedUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Accounted today</span></p>
      <p><strong>{budget.providerBalanceUsd === null ? "Not available in Stanley" : usd(budget.providerBalanceUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Remaining TypeSafe credit{budget.providerBalanceAsOf ? ` · observed ${date(budget.providerBalanceAsOf)}` : " · check TypeSafe for the actual balance"}</span></p>
      <p><strong>No Stanley spending cap</strong><br /><span className="text-xs text-[var(--text-muted)]">Efficient workflows and saved-answer reuse remain active</span></p>
    </div>
    <p className="mt-3 text-xs text-[var(--text-muted)]">{usd(budget.inFlightReserveUsd)} recorded for requests in flight · {usd(budget.unknownReserveUsd)} estimated for requests without confirmed usage. These are accounting estimates, not confirmed charges or spending pauses.</p>
    {budget.blockedReason && <p role="status" className="mt-2 text-xs text-[var(--gold)]">{waiting(budget.blockedReason)}</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">Stanley does not purchase credits automatically. Exact request reuse avoids duplicate provider calls. Jev does not grade TAM accounts.</p>
  </>;
  return <>
    <p className="mt-2">{budget.enabled ? "Paid processing is permitted within the remaining limits." : "Paid processing is stopped."} {budget.phase === "initial" ? `Initial catch-up limit: ${usd(budget.initialMaxUsd)}.` : `Ongoing limit: ${usd(budget.dailyCapUsd)} per Pacific calendar day, within ${usd(budget.maintenanceLimitUsd)} total.`}</p>
    {!budget.fundingConfirmed && <p className="mt-2 text-xs text-[var(--text-muted)]">Awaiting confirmation of the top-up. Remaining amounts below refer to confirmed funds for this policy, not the historical account balance.</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-3"><p><strong>{usd(budget.todayUsedUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Accounted today</span></p><p><strong>{usd(budget.phase === "initial" ? budget.initialRemainingUsd : budget.dailyRemainingUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Remaining in this window</span></p><p><strong>{usd(budget.maintenanceRemainingUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Remaining in the two-month reserve</span></p></div>
    <p className="mt-3 text-xs text-[var(--text-muted)]">{usd(budget.inFlightReserveUsd)} reserved for requests in flight · {usd(budget.unknownReserveUsd)} held for requests without confirmed usage. These holds are not confirmed charges. Exact request reuse is free.</p>
    {budget.blockedReason && <p role="status" className="mt-2 text-xs text-[var(--gold)]">{waiting(budget.blockedReason)}</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">Unpaid work waits when the limit is reached. {budget.nextResetAt ? `Next window: ${date(budget.nextResetAt)}.` : "There is no automatic additional allowance."} Initial allowance expires {date(budget.initialExpiresAt)}; the reserve ends {date(budget.maintenanceExpiresAt)}. Jev does not grade TAM accounts.</p>
  </>;
}

export default function IntelligenceBudget({ refreshKey }: { refreshKey?: string | null }) {
  const [budget, setBudget] = useState<JevBudgetSnapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/headhunter/intelligence/budget-status", { cache: "no-store", signal: controller.signal })
      .then(async response => { const value: JevBudgetSnapshot = response.ok ? await response.json() : { available: false }; if (!controller.signal.aborted) setBudget(value); })
      .catch(() => { if (!controller.signal.aborted) setBudget({ available: false }); });
    return () => controller.abort();
  }, [refreshKey]);
  return <section aria-label="Jev processing and spend" className="mb-5 rounded-lg border bg-[var(--surface)] p-4 text-sm">
    <h2 className="font-semibold">Jev processing and spend</h2>
    {!budget ? <p className="mt-1 text-xs text-[var(--text-muted)]">Reading the processing policy…</p>
      : !budget.available ? <p className="mt-1 text-xs text-[var(--text-muted)]">Processing policy status is unavailable. This is not a report of zero usage.</p>
      : <IntelligenceBudgetDetails budget={budget} />}
  </section>;
}
