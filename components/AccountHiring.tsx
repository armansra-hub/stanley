"use client";
import type { readAtsHiringContext } from "@/lib/intelligence/atsLifecycle";

type HiringContext = Awaited<ReturnType<typeof readAtsHiringContext>>;
const date = (value: string | null) => value ? new Date(value).toLocaleDateString() : "No completed scan yet";

export default function AccountHiring({ hiring, coverage }: { hiring: HiringContext | null | undefined; coverage?: "available" | "unavailable" }) {
  if (!hiring?.boards.length) return <section aria-label="Hiring coverage" className="mt-4 rounded border p-3"><h3 className="text-sm font-semibold">Hiring coverage</h3><p className="mt-2 text-xs text-[var(--text-muted)]">{coverage === "unavailable" || hiring === null ? "Hiring data could not be loaded. Hiring activity is unknown." : "No job-board baseline is stored for this account yet. This does not establish that the company is not hiring."}</p></section>;
  return <details className="mt-4 rounded border p-3">
    <summary className="cursor-pointer font-medium">Hiring changes · {hiring.boards.length} tracked {hiring.boards.length === 1 ? "board" : "boards"}</summary>
    <p className="mt-2 text-xs text-[var(--text-muted)]">{hiring.basis}</p>
    {hiring.boards.map(board => {
      const scan = hiring.scans.find(item => item.source_key === board.source_key);
      const summary = scan?.summary;
      return <div key={board.source_key} className="mt-3 border-t pt-3 text-sm">
        <div className="font-medium">{board.source_key}</div>
        <p className="text-xs text-[var(--text-muted)]">Last complete scan: {date(board.last_complete_at)}{board.active_scan_id ? " · Scan in progress" : ""}{board.last_error ? " · Latest attempt unavailable; prior results retained" : ""}</p>
        {summary && <>
          <p className="mt-1">{summary.openJobs} open listings{summary.baseline ? " · Initial baseline" : ` · ${summary.newJobs} new · ${summary.changedJobs} changed · ${summary.reopenedJobs} reappeared · ${summary.expiredJobs} no longer listed`}.</p>
          {!summary.baseline && summary.intervalDays != null && <p className="text-xs text-[var(--text-muted)]">Compared with {date(summary.previousCompleteAt)} ({summary.intervalDays.toFixed(1)} days). {summary.newListingsPerDay != null ? `${summary.newListingsPerDay.toFixed(1)} new listings per day.` : ""}</p>}
          {!!Object.keys(summary.roleCounts).length && <p className="mt-1 text-xs">Open role categories: {Object.entries(summary.roleCounts).filter(([, count]) => !!count).map(([role, count]) => `${role.replaceAll("_", " ")}: ${count}`).join(" · ")}. A listing can match several categories.</p>}
          {!!summary.changes.length && <ul className="mt-2 space-y-1">{summary.changes.slice(0, 12).map(change => <li key={`${change.jobKey}:${change.kind}`} className="text-xs"><span className="text-[var(--text-muted)]">{change.kind === "expired" ? "No longer listed" : change.kind} · </span><a href={change.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{change.title}</a>{change.clientPlacement ? " · Client placement" : ""}</li>)}</ul>}
          {(summary.changesTruncated || summary.changes.length > 12) && <p className="mt-1 text-xs text-[var(--text-muted)]">Showing a selection of listing changes.</p>}
        </>}
      </div>;
    })}
  </details>;
}
