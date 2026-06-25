"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Company, CompanyStatus } from "@/lib/types";
import { buildNetsuiteSqlExport, type SqlExportConfig } from "@/lib/export/sql";
import { buildCsvExport } from "@/lib/export/csv";
import { scoreBand } from "@/lib/scoring";
import { SUBINDUSTRIES } from "@/config/territory";
import { parseCsv, rowsToImportRows } from "@/lib/csv";
import { ACTORS } from "@/config/actors";
import { ScoreBadge, TierBadge, SignalChips, strongestSignal } from "./badges";
import ChatPanel from "./ChatPanel";

type Tab = "discovered" | "imported";

interface ImportReport {
  batch_id: string;
  filename: string;
  row_count: number;
  processed: number;
  truncated: boolean;
  upserted: number;
  new_companies: number;
  added_signals: number;
  companies: Company[];
}

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function postJSON(url: string, body: unknown) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("persist failed:", url, e);
  }
}

export default function Dashboard({
  initial,
  usingSample = false,
  exportConfig,
  actorOverrides = {},
}: {
  initial: Company[];
  usingSample?: boolean;
  exportConfig?: SqlExportConfig;
  actorOverrides?: Record<string, { enabled?: boolean }>;
}) {
  const [companies, setCompanies] = useState<Company[]>(initial);
  const [tab, setTab] = useState<Tab>("discovered");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [sqlModal, setSqlModal] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState("2026-06-24 11:42");
  const [refreshing, setRefreshing] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const incRef = useRef<HTMLInputElement>(null);

  const [paidOpen, setPaidOpen] = useState(false);
  const [paidRunning, setPaidRunning] = useState<string | null>(null);
  const paidActors = Object.entries(ACTORS)
    .filter(([k, a]) => actorOverrides[k]?.enabled ?? a.enabled)
    .sort((a, b) => a[1].rank - b[1].rank);

  async function doRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      setLastRefresh(new Date().toLocaleString());
      location.reload();
    } catch {
      alert("Refresh failed.");
      setRefreshing(false);
    }
  }

  async function runPaid(actors: string[]) {
    if (paidRunning) return;
    setPaidOpen(false);
    setPaidRunning(actors.join(","));
    try {
      const res = await fetch("/api/apify-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actors }),
      });
      const r = await res.json();
      alert(`Apify run: ${r.fetched ?? 0} fetched · ${r.upserted ?? 0} added · ${r.dropped_out_of_territory ?? 0} out-of-territory.`);
      location.reload();
    } catch {
      alert("Paid run failed.");
      setPaidRunning(null);
    }
  }

  async function handleIncFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const rows = rowsToImportRows(parseCsv(await file.text()));
      if (rows.length === 0) {
        alert("No company rows found in that CSV (need a name column).");
        return;
      }
      const res = await fetch("/api/import/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows, source_id: "inc5000", list_name: "Inc. 5000", list_url: "https://www.inc.com/inc5000" }),
      });
      const r = await res.json();
      alert(`Inc. 5000: ${r.processed ?? 0} processed · ${r.upserted ?? 0} in-territory added · ${r.dropped_out_of_territory ?? 0} dropped.`);
      location.reload();
    } catch {
      alert("Inc. 5000 import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const rows = rowsToImportRows(parseCsv(await file.text()));
      if (rows.length === 0) {
        alert("No company rows found in that CSV (need a name column).");
        return;
      }
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, rows }),
      });
      setImportReport(await res.json());
    } catch (err) {
      console.error(err);
      alert("Import failed — see console.");
    } finally {
      setImporting(false);
    }
  }

  // filters
  const [search, setSearch] = useState("");
  const [subindustry, setSubindustry] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [band, setBand] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  const importedHasNew = companies.some((c) => c.source === "imported" && c.has_new_signal);

  const visible = useMemo(() => {
    return companies.filter((c) => {
      if (c.source !== (tab === "discovered" ? "discovered" : "imported")) return false;
      if (!showClosed && (c.status === "dismissed" || c.status.startsWith("exported"))) return false;
      if (subindustry && c.subindustry !== subindustry) return false;
      if (stateFilter && c.state !== stateFilter) return false;
      if (band && scoreBand(c.signal_score) !== band) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !(c.domain ?? "").includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.signal_score - a.signal_score);
  }, [companies, tab, showClosed, subindustry, stateFilter, band, search]);

  const states = useMemo(
    () => Array.from(new Set(companies.map((c) => c.state).filter(Boolean))).sort() as string[],
    [companies],
  );

  const selectedInView = visible.filter((c) => selected.has(c.id));
  const allSelected = visible.length > 0 && selectedInView.length === visible.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visible.forEach((c) => next.delete(c.id));
      else visible.forEach((c) => next.add(c.id));
      return next;
    });
  }

  function applyStatusLocal(ids: string[], status: CompanyStatus) {
    setCompanies((prev) =>
      prev.map((c) =>
        ids.includes(c.id)
          ? { ...c, status, exported_at: status.startsWith("exported") ? new Date().toISOString() : c.exported_at }
          : c,
      ),
    );
    setSelected(new Set());
  }

  function changeStatus(ids: string[], status: "new" | "reviewed" | "dismissed") {
    applyStatusLocal(ids, status);
    void postJSON("/api/companies/status", { ids, status });
  }

  function exportSql() {
    const chosen = companies.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const { text } = buildNetsuiteSqlExport(chosen.map((c) => c.website_raw ?? c.domain ?? ""), exportConfig);
    setSqlModal(text);
    applyStatusLocal(ids, "exported_sql");
    void postJSON("/api/export", { ids, type: "sql", payload: text });
  }
  function exportCsv() {
    const chosen = companies.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const csv = buildCsvExport(chosen.map((c) => ({ name: c.name, website_raw: c.website_raw })));
    download("jarvis-export.csv", csv, "text/csv");
    applyStatusLocal(ids, "exported_csv");
    void postJSON("/api/export", { ids, type: "csv", payload: csv });
  }

  function acknowledge(id: string) {
    setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, has_new_signal: false } : c)));
    void postJSON("/api/companies/acknowledge", { id });
  }

  function saveNote(id: string, notes: string) {
    setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, notes } : c)));
    void postJSON("/api/companies/note", { id, notes });
  }

  const drawer = companies.find((c) => c.id === drawerId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Jarvis · Prospecting</h1>
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
              style={{
                borderColor: usingSample ? "var(--tier-b)" : "var(--tier-a)",
                color: usingSample ? "var(--tier-b)" : "var(--tier-a)",
              }}
              title={usingSample ? "Showing seeded sample data (DB empty)" : "Live data from Supabase"}
            >
              {usingSample ? "SAMPLE DATA" : "LIVE · SUPABASE"}
            </span>
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            Signal-driven net-new discovery in your territory.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/settings" className="rounded-md border px-3 py-1.5 font-medium" style={{ borderColor: "var(--border)" }} title="Settings">
            ⚙ Settings
          </Link>
          <span className="text-[var(--text-muted)]">Last refresh {lastRefresh}</span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="rounded-md border px-3 py-1.5 font-medium"
            style={{ borderColor: "var(--border)" }}
          >
            {importing ? "Importing…" : "Upload CSV"}
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
          <button
            onClick={() => incRef.current?.click()}
            disabled={importing}
            className="rounded-md border px-3 py-1.5 font-medium"
            style={{ borderColor: "var(--border)" }}
            title="Upload an Inc. 5000 list CSV (intersected with your territory)"
          >
            Import Inc. 5000
          </button>
          <input ref={incRef} type="file" accept=".csv,text/csv" onChange={handleIncFile} className="hidden" />
          <div className="relative">
            <button
              onClick={() => setPaidOpen((o) => !o)}
              disabled={!!paidRunning}
              className="rounded-md border px-3 py-1.5 font-medium"
              style={{ borderColor: "var(--border)" }}
              title="Run the paid Apify sources (pay-per-result)"
            >
              {paidRunning ? "Running…" : "Paid sources ▾"}
            </button>
            {paidOpen && (
              <div className="absolute right-0 z-30 mt-1 w-64 rounded-md border bg-[var(--surface)] p-1 shadow-lg" style={{ borderColor: "var(--border)" }}>
                <button onClick={() => runPaid(["all"])} className="block w-full rounded px-3 py-2 text-left text-sm font-medium hover:bg-[var(--surface-2)]">
                  Run all enabled ({paidActors.length})
                </button>
                <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
                {paidActors.map(([k, a]) => (
                  <button key={k} onClick={() => runPaid([k])} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--surface-2)]">
                    <div className="text-xs font-medium capitalize">{k.replace(/_/g, " ")}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{a.price}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={doRefresh}
            disabled={refreshing}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-white"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {(["discovered", "imported"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSelected(new Set()); }}
            className="relative px-4 py-2 text-sm font-medium"
            style={{
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t === "discovered" ? "Discovered" : "Previously Imported"}
            {t === "imported" && importedHasNew && (
              <span className="absolute -right-1 top-1 h-2 w-2 rounded-full bg-[var(--tier-a)]" />
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          placeholder="Search name or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border)" }}
        />
        <Select value={subindustry} onChange={setSubindustry} placeholder="All subindustries" options={SUBINDUSTRIES} />
        <Select value={stateFilter} onChange={setStateFilter} placeholder="All states" options={states} />
        <Select value={band} onChange={setBand} placeholder="Any score" options={["Strong", "Medium", "Weak"]} />
        <label className="ml-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show dismissed / exported
        </label>
      </div>

      {/* Bulk action bar */}
      {selectedInView.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
          <span className="font-medium">{selectedInView.length} selected</span>
          <div className="flex-1" />
          <ActionButton onClick={exportSql}>Export SQL</ActionButton>
          <ActionButton onClick={exportCsv}>Export CSV</ActionButton>
          <ActionButton onClick={() => changeStatus([...selected], "reviewed")}>Mark reviewed</ActionButton>
          {showClosed && (
            <ActionButton onClick={() => changeStatus([...selected], "new")}>Restore</ActionButton>
          )}
          <ActionButton onClick={() => changeStatus([...selected], "dismissed")} danger>Dismiss</ActionButton>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--surface-2)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <Th className="w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></Th>
              <Th>Company</Th>
              <Th>What they do</Th>
              <Th>Why it's here</Th>
              <Th className="text-center">Score</Th>
              <Th className="text-center">Tier</Th>
              <Th>Signals</Th>
              <Th>State</Th>
              <Th>Size</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const top = strongestSignal(c);
              return (
                <tr
                  key={c.id}
                  className="cursor-pointer border-t hover:bg-[var(--surface-2)]/50"
                  style={{ borderColor: "var(--border)" }}
                  onClick={() => { setDrawerId(c.id); if (c.has_new_signal) acknowledge(c.id); }}
                >
                  <Td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5 font-medium">
                      {c.has_new_signal && <span className="h-2 w-2 rounded-full bg-[var(--tier-a)]" />}
                      <a href={c.website_raw ?? "#"} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </a>
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">{c.domain}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{c.subindustry}</div>
                  </Td>
                  <Td className="max-w-[220px] text-[var(--text-muted)]">{c.description}</Td>
                  <Td className="max-w-[260px]">
                    {top ? (
                      <>
                        <div>{top.signal_summary}</div>
                        <a href={top.source_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)] hover:underline" onClick={(e) => e.stopPropagation()}>
                          {top.source_name} ↗
                        </a>
                      </>
                    ) : <span className="text-[var(--text-muted)]">—</span>}
                  </Td>
                  <Td className="text-center"><ScoreBadge score={c.signal_score} /></Td>
                  <Td className="text-center"><TierBadge tier={c.score_tier} /></Td>
                  <Td><SignalChips signals={c.signals} /></Td>
                  <Td>{c.state}</Td>
                  <Td className="whitespace-nowrap text-xs text-[var(--text-muted)]">{c.employee_band}<br />{c.revenue_band}</Td>
                  <Td><StatusPill status={c.status} /></Td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><Td colSpan={10} className="py-10 text-center text-[var(--text-muted)]">No companies match these filters.</Td></tr>
            )}
          </tbody>
        </table>
      </div>

      {drawer && <DetailDrawer company={drawer} onClose={() => setDrawerId(null)} onSaveNote={saveNote} />}
      {sqlModal && <SqlModal text={sqlModal} onClose={() => setSqlModal(null)} />}
      {importReport && (
        <ImportReportModal report={importReport} onClose={() => { setImportReport(null); location.reload(); }} />
      )}
      <ChatPanel />
    </div>
  );
}

/* ── small presentational helpers ─────────────────────────────────────────── */

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}
function Td({ children, className = "", colSpan, onClick }: { children?: React.ReactNode; className?: string; colSpan?: number; onClick?: (e: React.MouseEvent) => void }) {
  return <td className={`px-3 py-2 align-top ${className}`} colSpan={colSpan} onClick={onClick}>{children}</td>;
}
function ActionButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className="rounded-md border px-3 py-1 text-xs font-medium" style={{ borderColor: danger ? "var(--tier-b)" : "var(--border)", color: danger ? "var(--tier-b)" : "var(--text)" }}>
      {children}
    </button>
  );
}
function Select({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: string[]; placeholder: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border bg-[var(--surface)] px-2 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function StatusPill({ status }: { status: CompanyStatus }) {
  const label = status.replace("_", " ");
  return <span className="rounded-full border px-2 py-0.5 text-[10px] capitalize text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{label}</span>;
}

function DetailDrawer({
  company,
  onClose,
  onSaveNote,
}: {
  company: Company;
  onClose: () => void;
  onSaveNote: (id: string, notes: string) => void;
}) {
  const [note, setNote] = useState(company.notes ?? "");
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-[460px] overflow-y-auto border-l bg-[var(--surface)] p-5" style={{ borderColor: "var(--border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{company.name}</h2>
            <a href={company.website_raw ?? "#"} target="_blank" rel="noreferrer" className="text-sm text-[var(--accent)] hover:underline">{company.domain}</a>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)]">✕</button>
        </div>
        <div className="mb-4 flex items-center gap-2">
          <ScoreBadge score={company.signal_score} />
          <TierBadge tier={company.score_tier} />
        </div>
        <p className="mb-1 text-sm text-[var(--text-muted)]">{company.description}</p>
        <p className="mb-4 text-xs text-[var(--text-muted)]">{company.subindustry} · {company.state} · {company.employee_band} · {company.revenue_band}</p>
        {company.score_reason && <p className="mb-4 rounded-md bg-[var(--surface-2)] p-3 text-xs">{company.score_reason}</p>}
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Signals ({company.signals.length})</h3>
        <div className="space-y-2">
          {[...company.signals].sort((a, b) => b.weight - a.weight).map((s) => (
            <div key={s.id} className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)" }}>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium capitalize">{s.type.replace(/_/g, " ")}</span>
                <span className="text-xs text-[var(--text-muted)]">{s.strength} · +{s.weight}{s.subindustry_relevant ? " · vertical" : ""}</span>
              </div>
              <p className="text-[var(--text-muted)]">{s.signal_summary}</p>
              {s.raw_excerpt && <p className="mt-1 border-l-2 pl-2 text-xs italic text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>"{s.raw_excerpt}"</p>}
              <a href={s.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline">{s.source_name} ↗</a>
            </div>
          ))}
        </div>
        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Notes</h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => onSaveNote(company.id, note)}
          placeholder="Add a note (saved on blur)…"
          className="h-20 w-full rounded-md border bg-[var(--surface-2)] p-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
      </div>
    </div>
  );
}

function ImportReportModal({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const withSignals = report.companies.filter((c) => c.signals.length > 0).length;
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex max-h-[80vh] w-[780px] flex-col rounded-lg border bg-[var(--surface)] p-4" style={{ borderColor: "var(--border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start justify-between">
          <div>
            <h2 className="font-semibold">Import report — {report.filename}</h2>
            <p className="text-xs text-[var(--text-muted)]">
              {report.processed} of {report.row_count} processed · {report.companies.length} on watchlist · {withSignals} with a signal now
              {report.truncated ? ` · capped at ${report.processed} this run` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)]">✕</button>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <tbody>
              {report.companies.map((c) => {
                const top = strongestSignal(c);
                return (
                  <tr key={c.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2 pr-2 align-top">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[10px] text-[var(--text-muted)]">{c.in_territory ? c.subindustry : "out of territory"}</div>
                    </td>
                    <td className="py-2 pr-2 align-top"><ScoreBadge score={c.signal_score} /></td>
                    <td className="py-2 pr-2 align-top"><TierBadge tier={c.score_tier} /></td>
                    <td className="py-2 align-top text-[var(--text-muted)]">
                      {top ? top.signal_summary : "no signal yet — monitoring on each refresh"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">Closing reloads to show these under “Previously Imported.”</p>
      </div>
    </div>
  );
}

function SqlModal({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex max-h-[80vh] w-[760px] flex-col rounded-lg border bg-[var(--surface)] p-4" style={{ borderColor: "var(--border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">NetSuite SQL export</h2>
          <div className="flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); }} className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">
              {copied ? "Copied ✓" : "Copy all"}
            </button>
            <button onClick={onClose} className="text-[var(--text-muted)]">✕</button>
          </div>
        </div>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-3 text-xs">{text}</pre>
      </div>
    </div>
  );
}
