"use client";
import { useEffect, useState } from "react";
import type { JevBudgetSnapshot } from "@/lib/intelligence/budget";

const usd = (amount: number) => amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const date = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" });

export default function IntelligenceBudget({ refreshKey }: { refreshKey?: string | null }) {
  const [budget, setBudget] = useState<JevBudgetSnapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/headhunter/intelligence/budget-status", { cache: "no-store", signal: controller.signal })
      .then(async response => { const value: JevBudgetSnapshot = response.ok ? await response.json() : { available: false }; if (!controller.signal.aborted) setBudget(value); })
      .catch(() => { if (!controller.signal.aborted) setBudget({ available: false }); });
    return () => controller.abort();
  }, [refreshKey]);
  return <section aria-label="Jev spending limits" className="mb-5 rounded-lg border bg-[var(--surface)] p-4 text-sm">
    <h2 className="font-semibold">Jev spending limits</h2>
    {!budget ? <p className="mt-1 text-xs text-[var(--text-muted)]">Reading the saved budget policy…</p> : !budget.available ? <p className="mt-1 text-xs text-[var(--text-muted)]">Budget policy status is unavailable. This is not a report of zero usage.</p> : <>
      <p className="mt-2">{budget.enabled ? "Paid processing is permitted within the remaining limits." : "Paid processing is stopped."} {budget.phase === "initial" ? `Initial catch-up limit: ${usd(budget.initialMaxUsd)}.` : `Ongoing limit: ${usd(budget.dailyCapUsd)} per Pacific calendar day, within ${usd(budget.maintenanceLimitUsd)} total.`}</p>
      {!budget.fundingConfirmed && <p className="mt-2 text-xs text-[var(--text-muted)]">Awaiting confirmation of the top-up. Remaining amounts below refer to confirmed funds for this new policy, not the historical account balance.</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><p><strong>{usd(budget.todayUsedUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Accounted today</span></p><p><strong>{usd(budget.phase === "initial" ? budget.initialRemainingUsd : budget.dailyRemainingUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Remaining in this window</span></p><p><strong>{usd(budget.maintenanceRemainingUsd)}</strong><br /><span className="text-xs text-[var(--text-muted)]">Remaining in the two-month reserve</span></p></div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">{usd(budget.inFlightReserveUsd)} reserved for requests in flight · {usd(budget.unknownReserveUsd)} held for requests without confirmed usage. These holds are not confirmed charges. Exact request reuse is free.</p>
      {budget.blockedReason && <p className="mt-2 text-xs text-[var(--gold)]">Waiting: {budget.blockedReason.replaceAll("_", " ")}.</p>}
      <p className="mt-2 text-xs text-[var(--text-muted)]">Unpaid work waits when the limit is reached. {budget.nextResetAt ? `Next window: ${date(budget.nextResetAt)}.` : "There is no automatic additional allowance."} Initial allowance expires {date(budget.initialExpiresAt)}; the reserve ends {date(budget.maintenanceExpiresAt)}. Jev does not grade TAM accounts.</p>
    </>}
  </section>;
}
