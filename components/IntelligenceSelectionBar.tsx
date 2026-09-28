"use client";

import { useEffect, useRef } from "react";

export function selectedLoadedIds(ids: readonly string[], selectedIds: ReadonlySet<string>): string[] {
  return [...new Set(ids)].filter(id => selectedIds.has(id));
}

export default function IntelligenceSelectionBar({ ids, selectedIds, onSelectionChange, onStatus, showHidden = false, busy = false, label = "accounts" }: {
  ids: string[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onStatus: (ids: string[], status: "new" | "dismissed") => Promise<boolean>;
  showHidden?: boolean;
  busy?: boolean;
  label?: string;
}) {
  const checkbox = useRef<HTMLInputElement>(null);
  const writing = useRef(false);
  const selected = selectedLoadedIds(ids, selectedIds);
  const all = ids.length > 0 && selected.length === new Set(ids).size;
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = selected.length > 0 && !all;
  }, [selected.length, all]);
  const update = async (status: "new" | "dismissed") => {
    if (busy || writing.current || !selected.length) return;
    writing.current = true;
    try { if (await onStatus(selected, status)) onSelectionChange(new Set()); }
    finally { writing.current = false; }
  };
  if (!ids.length) return null;
  return <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm" aria-label={`Select ${label}`}>
    <label className="flex cursor-pointer items-center gap-2">
      <input ref={checkbox} type="checkbox" checked={all} disabled={busy}
        aria-label={`Select all loaded ${label}`} onChange={event => onSelectionChange(event.target.checked ? new Set(ids) : new Set())} />
      Select all loaded
    </label>
    <span role="status" className="text-xs text-[var(--text-muted)]">{selected.length.toLocaleString()} selected</span>
    <button type="button" disabled={busy || !selected.length} onClick={() => void update("dismissed")}
      className="rounded border px-2.5 py-1 text-xs text-red-400 disabled:opacity-50">Dismiss selected</button>
    {showHidden && <button type="button" disabled={busy || !selected.length} onClick={() => void update("new")}
      className="rounded border px-2.5 py-1 text-xs disabled:opacity-50">Restore selected</button>}
    {!!selected.length && <button type="button" disabled={busy} onClick={() => onSelectionChange(new Set())}
      className="text-xs underline disabled:opacity-50">Clear selected accounts</button>}
    {busy && <span className="text-xs text-[var(--text-muted)]">Saving…</span>}
  </div>;
}
