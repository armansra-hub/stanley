"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Company, CompanyStatus } from "@/lib/types";
import type { PoolLead } from "@/lib/db/leadPool";
import type { ExportRecord } from "@/lib/db/companies";
import { formatNow } from "@/lib/time";
import { buildNetsuiteSqlExport, type SqlExportConfig } from "@/lib/export/sql";
import { buildCsvExport } from "@/lib/export/csv";
import { scoreBand } from "@/lib/scoring";
import { SUBINDUSTRIES } from "@/config/territory";
import { parseCsv, rowsToImportRows } from "@/lib/csv";
import { ACTORS } from "@/config/actors";
import { ScoreBadge, TierBadge, SignalChips, SourceBadge, sourceLabel, strongestSignal } from "./badges";
import ChatPanel from "./ChatPanel";

type Tab = "discovered" | "imported" | "starred" | "net_new" | "history" | "actors";

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

/** Newest signal timestamp on a company (prefers the real event date, falls back
 * to ingest time) — the recency tiebreaker so freshest intent sorts first. */
function latestSignalMs(c: Company): number {
  let max = 0;
  for (const s of c.signals) {
    const t = Date.parse(s.signal_date ?? s.detected_at ?? "");
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
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
  poolLeads = [],
  exportHistory = [],
}: {
  initial: Company[];
  usingSample?: boolean;
  exportConfig?: SqlExportConfig;
  actorOverrides?: Record<string, { enabled?: boolean }>;
  poolLeads?: PoolLead[];
  exportHistory?: ExportRecord[];
}) {
  const [companies, setCompanies] = useState<Company[]>(initial);
  const [tab, setTab] = useState<Tab>("discovered");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [sqlModal, setSqlModal] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState("2026-06-24 11:42");
  const [refreshing, setRefreshing] = useState(false);

  // Live clock — the app always knows the current date/time (foundation for the
  // Missions calendar). Updates every second.
  const [clock, setClock] = useState<string>(() => formatNow());
  useEffect(() => {
    const t = setInterval(() => setClock(formatNow()), 1000);
    return () => clearInterval(t);
  }, []);
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
      const filtered =
        (r.dropped_out_of_territory ?? 0) + (r.dropped_too_large ?? 0) + (r.dropped_too_small ?? 0) +
        (r.dropped_no_finance_team ?? 0) + (r.dropped_junior_role ?? 0) + (r.dropped_3pl ?? 0) +
        (r.dropped_unidentified ?? 0) + (r.dropped_stale ?? 0) + (r.dropped_non_us_canada ?? 0);
      alert(`Apify run: ${r.fetched ?? 0} fetched · ${r.upserted ?? 0} added to Signals · ${r.pooled ?? 0} to Net-New · ${filtered} filtered out (off-territory / too big / under-20 / no finance / junior-role / 3PL / unnamed / stale).`);
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
      if (tab === "starred") {
        if (!c.starred) return false; // Starred shows everything starred, even exported
      } else {
        if (c.source !== (tab === "discovered" ? "discovered" : "imported")) return false;
        if (!showClosed && (c.status === "dismissed" || c.status.startsWith("exported"))) return false;
      }
      if (subindustry && c.subindustry !== subindustry) return false;
      if (stateFilter && c.state !== stateFilter) return false;
      if (band && scoreBand(c.signal_score) !== band) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !(c.domain ?? "").includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.signal_score - a.signal_score || latestSignalMs(b) - latestSignalMs(a));
  }, [companies, tab, showClosed, subindustry, stateFilter, band, search]);

  const states = useMemo(
    () => Array.from(new Set(companies.map((c) => c.state).filter(Boolean))).sort() as string[],
    [companies],
  );

  const isNetNew = tab === "net_new";
  const isHistory = tab === "history";
  const isActors = tab === "actors";

  // Net-new = raw Maps pool leads that aren't yet a signal company. Exclude
  // promoted ones (they're in Discovered), exported ones (moved to Export
  // History), and any domain already in companies. Local state so an export
  // removes them from the tab immediately.
  const [pool, setPool] = useState<PoolLead[]>(poolLeads);
  const companyDomains = useMemo(
    () => new Set(companies.map((c) => c.domain).filter(Boolean) as string[]),
    [companies],
  );
  const availablePool = useMemo(
    () => pool.filter((p) => !p.promoted_at && !p.exported_at && !(p.domain && companyDomains.has(p.domain))),
    [pool, companyDomains],
  );
  const netNewVisible = useMemo(() => {
    return availablePool.filter((p) => {
      if (stateFilter && p.state !== stateFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !(p.domain ?? "").includes(q)) return false;
      }
      return true;
    });
  }, [availablePool, stateFilter, search]);

  const idsInView = isNetNew ? netNewVisible.map((p) => p.key) : visible.map((c) => c.id);
  const selectedInViewCount = idsInView.filter((id) => selected.has(id)).length;
  const allSelected = idsInView.length > 0 && selectedInViewCount === idsInView.length;

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
      if (allSelected) idsInView.forEach((id) => next.delete(id));
      else idsInView.forEach((id) => next.add(id));
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

  function toggleStar(id: string, value: boolean) {
    setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, starred: value } : c)));
    void postJSON("/api/companies/star", { ids: [id], value });
  }
  function bulkStar(value: boolean) {
    const ids = [...selected];
    setCompanies((prev) => prev.map((c) => (ids.includes(c.id) ? { ...c, starred: value } : c)));
    setSelected(new Set());
    void postJSON("/api/companies/star", { ids, value });
  }

  const starredCount = companies.filter((c) => c.starred).length;

  // Mark exported Net-New leads locally so they leave the tab and move to history.
  function markNetNewExportedLocal(keys: string[]) {
    const now = new Date().toISOString();
    setPool((prev) => prev.map((p) => (keys.includes(p.key) ? { ...p, exported_at: now } : p)));
    setSelected(new Set());
  }

  function exportSql() {
    if (isNetNew) {
      const chosen = netNewVisible.filter((p) => selected.has(p.key));
      const keys = chosen.map((p) => p.key);
      const { text } = buildNetsuiteSqlExport(chosen.map((p) => ({ name: p.name, website: p.domain })), exportConfig);
      setSqlModal(text);
      markNetNewExportedLocal(keys);
      void postJSON("/api/export", { ids: keys, type: "sql", payload: text, origin: "net_new" });
      return;
    }
    const chosen = companies.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const { text } = buildNetsuiteSqlExport(
      chosen.map((c) => ({ name: c.name, website: c.website_raw ?? c.domain })),
      exportConfig,
    );
    setSqlModal(text);
    applyStatusLocal(ids, "exported_sql");
    void postJSON("/api/export", { ids, type: "sql", payload: text, origin: "discovered" });
  }
  function exportCsv() {
    if (isNetNew) {
      const chosen = netNewVisible.filter((p) => selected.has(p.key));
      const keys = chosen.map((p) => p.key);
      const csv = buildCsvExport(chosen.map((p) => ({ name: p.name, website_raw: p.domain })));
      download("stanley-netnew.csv", csv, "text/csv");
      markNetNewExportedLocal(keys);
      void postJSON("/api/export", { ids: keys, type: "csv", payload: csv, origin: "net_new" });
      return;
    }
    const chosen = companies.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const csv = buildCsvExport(chosen.map((c) => ({ name: c.name, website_raw: c.website_raw })));
    download("stanley-export.csv", csv, "text/csv");
    applyStatusLocal(ids, "exported_csv");
    void postJSON("/api/export", { ids, type: "csv", payload: csv, origin: "discovered" });
  }

  function acknowledge(id: string) {
    setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, has_new_signal: false } : c)));
    void postJSON("/api/companies/acknowledge", { id });
  }

  function saveNote(id: string, notes: string) {
    setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, notes } : c)));
    void postJSON("/api/companies/note", { id, notes });
  }
  function rateCompany(id: string, rating: number | null, comment: string | null) {
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? { ...c, rating, rating_comment: comment } : c)),
    );
    void postJSON("/api/companies/rate", { id, rating, comment });
  }

  const drawer = companies.find((c) => c.id === drawerId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <Link href="/" className="mb-1 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">‹ Main Menu</Link>
          <div className="flex items-center gap-2">
            <h1 className="western text-2xl" style={{ color: "var(--gold)" }}>Stanley · Headhunter</h1>
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
          <span className="tabular-nums text-[var(--gold)]" title="Current date & time">🕑 {clock}</span>
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
        {(["discovered", "imported", "starred", "net_new", "history", "actors"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSelected(new Set()); }}
            className="western relative px-4 py-2 text-base"
            style={{
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t === "discovered"
              ? "Discovered"
              : t === "imported"
                ? "Previously Imported"
                : t === "starred"
                  ? `★ Starred${starredCount ? ` (${starredCount})` : ""}`
                  : t === "net_new"
                    ? `Net-New Leads${availablePool.length ? ` (${availablePool.length})` : ""}`
                    : t === "history"
                      ? `Export History${exportHistory.length ? ` (${exportHistory.length})` : ""}`
                      : "Actor Scoreboard"}
            {t === "imported" && importedHasNew && (
              <span className="absolute -right-1 top-1 h-2 w-2 rounded-full bg-[var(--tier-a)]" />
            )}
          </button>
        ))}
      </div>

      {/* Filters + bulk bar (hidden on history/actors tabs) */}
      {!isHistory && !isActors && (
        <>
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

          {selectedInViewCount > 0 && (
            <div className="mb-3 flex items-center gap-2 rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
              <span className="font-medium">{selectedInViewCount} selected</span>
              <div className="flex-1" />
              <ActionButton onClick={exportSql}>Export SQL</ActionButton>
              <ActionButton onClick={exportCsv}>Export CSV</ActionButton>
              {!isNetNew && (
                <>
                  <ActionButton onClick={() => bulkStar(true)}>★ Star</ActionButton>
                  <ActionButton onClick={() => bulkStar(false)}>☆ Unstar</ActionButton>
                  <ActionButton onClick={() => changeStatus([...selected], "reviewed")}>Mark reviewed</ActionButton>
                  {showClosed && (
                    <ActionButton onClick={() => changeStatus([...selected], "new")}>Restore</ActionButton>
                  )}
                  <ActionButton onClick={() => changeStatus([...selected], "dismissed")} danger>Dismiss</ActionButton>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Table / History / Actors */}
      {isActors ? (
        <ActorScoreboard companies={companies} />
      ) : isHistory ? (
        <ExportHistoryPanel records={exportHistory} onReopen={(text) => setSqlModal(text)} exportConfig={exportConfig} />
      ) : isNetNew ? (
        <NetNewTable rows={netNewVisible} selected={selected} allSelected={allSelected} onToggle={toggle} onToggleAll={toggleAll} />
      ) : (
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
              <Th>Source</Th>
              <Th>State</Th>
              <Th>Size</Th>
              <Th>Rating</Th>
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
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleStar(c.id, !c.starred); }}
                        title={c.starred ? "Unstar" : "Star"}
                        className="text-sm leading-none"
                        style={{ color: c.starred ? "var(--tier-b)" : "var(--text-muted)" }}
                      >
                        {c.starred ? "★" : "☆"}
                      </button>
                      {c.has_new_signal && <span className="h-2 w-2 rounded-full bg-[var(--tier-a)]" />}
                      <a href={c.website_raw ?? "#"} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </a>
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">{c.domain}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{c.subindustry}</div>
                    {c.already_on_netsuite && (
                      <div className="text-[10px] font-medium text-[var(--tier-b)]">⚠ already on NetSuite</div>
                    )}
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
                  <Td><SourceBadge sources={c.sources} /></Td>
                  <Td>{c.state}</Td>
                  <Td className="whitespace-nowrap text-xs text-[var(--text-muted)]">{c.employee_band}<br />{c.revenue_band}</Td>
                  <Td className="whitespace-nowrap">
                    {c.rating != null ? (
                      <span className="text-xs" style={{ color: "var(--gold)" }} title={c.rating_comment ?? `${c.rating}/5`}>{"★".repeat(c.rating)}<span style={{ color: "var(--border)" }}>{"★".repeat(5 - c.rating)}</span></span>
                    ) : (
                      <span className="text-[10px] text-[var(--text-muted)]">—</span>
                    )}
                  </Td>
                  <Td><StatusPill status={c.status} /></Td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><Td colSpan={12} className="py-10 text-center text-[var(--text-muted)]">No companies match these filters.</Td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {drawer && <DetailDrawer company={drawer} onClose={() => setDrawerId(null)} onSaveNote={saveNote} onRate={rateCompany} />}
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

function NetNewTable({
  rows, selected, allSelected, onToggle, onToggleAll,
}: {
  rows: PoolLead[];
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <p className="border-b px-3 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
        Net-new in-territory companies from the Google Maps sweep — no signal yet. Select to export by name + website; any that start hiring for finance/ERP get auto-promoted into Discovered.
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-[var(--surface-2)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <Th className="w-8"><input type="checkbox" checked={allSelected} onChange={onToggleAll} /></Th>
            <Th>Company</Th>
            <Th>Website</Th>
            <Th>State</Th>
            <Th>City</Th>
            <Th>Found</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key} className="border-t hover:bg-[var(--surface-2)]/50" style={{ borderColor: "var(--border)" }}>
              <Td><input type="checkbox" checked={selected.has(p.key)} onChange={() => onToggle(p.key)} /></Td>
              <Td className="font-medium">{p.name}</Td>
              <Td>{p.domain ? <a href={`https://${p.domain}`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">{p.domain}</a> : <span className="text-[var(--text-muted)]">—</span>}</Td>
              <Td>{p.state ?? "—"}</Td>
              <Td className="text-[var(--text-muted)]">{p.city ?? "—"}</Td>
              <Td className="whitespace-nowrap text-xs text-[var(--text-muted)]">{p.first_seen_at?.slice(0, 10)}</Td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><Td colSpan={6} className="py-10 text-center text-[var(--text-muted)]">No net-new leads yet — the Google Maps sweep fills this daily.</Td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ActorScoreboard({ companies }: { companies: Company[] }) {
  // Tally per source actor: how many leads it found, how many are Strong (score
  // ≥60), how many starred, how many exported. A lead found by N actors counts
  // toward each (credit shared). Drives "which actors perform best".
  const rows = useMemo(() => {
    const m = new Map<string, { leads: number; strong: number; starred: number; exported: number; scoreSum: number; ratingSum: number; ratingN: number }>();
    for (const c of companies) {
      const srcs = c.sources && c.sources.length ? c.sources : ["(unknown)"];
      for (const s of srcs) {
        const r = m.get(s) ?? { leads: 0, strong: 0, starred: 0, exported: 0, scoreSum: 0, ratingSum: 0, ratingN: 0 };
        r.leads += 1;
        if (c.signal_score >= 60) r.strong += 1;
        if (c.starred) r.starred += 1;
        if (c.status.startsWith("exported")) r.exported += 1;
        r.scoreSum += c.signal_score;
        if (c.rating != null) { r.ratingSum += c.rating; r.ratingN += 1; }
        m.set(s, r);
      }
    }
    return [...m.entries()]
      .map(([id, r]) => ({ id, ...r, avg: r.leads ? Math.round(r.scoreSum / r.leads) : 0, avgRating: r.ratingN ? r.ratingSum / r.ratingN : null }))
      .sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.strong - a.strong || b.leads - a.leads);
  }, [companies]);

  if (companies.length === 0) {
    return <div className="py-16 text-center text-sm text-[var(--text-muted)]">No leads yet — the scoreboard fills as actors find companies.</div>;
  }

  const max = Math.max(...rows.map((r) => r.leads), 1);
  return (
    <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <p className="border-b px-3 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
        Which actors are finding your leads — and which find the <em>good</em> ones. Strong = score ≥ 60. (A lead found by multiple actors credits each.)
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-[var(--surface-2)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <Th>Actor</Th>
            <Th>Leads found</Th>
            <Th className="text-center">Strong (≥60)</Th>
            <Th className="text-center">Avg score</Th>
            <Th className="text-center">★ Your rating</Th>
            <Th className="text-center">★ Starred</Th>
            <Th className="text-center">Exported</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t" style={{ borderColor: "var(--border)" }}>
              <Td className="font-medium">{sourceLabel(r.id)}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 rounded" style={{ width: `${Math.max(6, (r.leads / max) * 120)}px`, background: "var(--gold)" }} />
                  <span>{r.leads}</span>
                </div>
              </Td>
              <Td className="text-center"><span style={{ color: r.strong ? "var(--tier-a)" : "var(--text-muted)" }}>{r.strong}</span></Td>
              <Td className="text-center text-[var(--text-muted)]">{r.avg}</Td>
              <Td className="text-center">{r.avgRating != null ? <span style={{ color: "var(--gold)" }}>{r.avgRating.toFixed(1)}★ <span className="text-[10px] text-[var(--text-muted)]">({r.ratingN})</span></span> : <span className="text-[var(--text-muted)]">—</span>}</Td>
              <Td className="text-center">{r.starred || "—"}</Td>
              <Td className="text-center">{r.exported || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportHistoryPanel({
  records,
  onReopen,
  exportConfig,
}: {
  records: ExportRecord[];
  onReopen: (text: string) => void;
  exportConfig?: SqlExportConfig;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Regenerate EITHER format from the export's saved lead list (name + website),
  // so any past export can be downloaded as SQL or CSV regardless of the format
  // originally chosen. Falls back to the stored payload if the list is empty.
  function viewSql(record: ExportRecord) {
    if (record.export_companies.length === 0) {
      onReopen(record.payload);
      return;
    }
    const { text } = buildNetsuiteSqlExport(
      record.export_companies.map((c) => ({ name: c.name, website: c.website })),
      exportConfig,
    );
    onReopen(text);
  }
  function downloadCsv(record: ExportRecord) {
    const filename = `stanley-export-${record.created_at.slice(0, 10)}.csv`;
    const csv =
      record.export_companies.length === 0
        ? record.payload
        : buildCsvExport(record.export_companies.map((c) => ({ name: c.name, website_raw: c.website })));
    download(filename, csv, "text/csv");
  }

  if (records.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-[var(--text-muted)]">
        No exports yet — run an SQL or CSV export from Discovered or Net-New to see them here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {records.map((r) => {
        const isOpen = expanded.has(r.id);
        const date = new Date(r.created_at);
        const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        return (
          <div key={r.id} className="rounded-lg border bg-[var(--surface)]" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-3 px-4 py-3">
              <span
                className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                style={{
                  background: r.export_type === "sql" ? "rgba(181,83,42,0.2)" : "rgba(90,154,62,0.2)",
                  color: r.export_type === "sql" ? "var(--accent)" : "var(--tier-a)",
                  border: `1px solid ${r.export_type === "sql" ? "var(--accent)" : "var(--tier-a)"}`,
                }}
              >
                {r.export_type.toUpperCase()}
              </span>
              <span
                className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                style={{
                  background: r.origin === "net_new" ? "rgba(201,162,74,0.18)" : "rgba(122,122,122,0.15)",
                  color: r.origin === "net_new" ? "var(--gold)" : "var(--text-muted)",
                  border: `1px solid ${r.origin === "net_new" ? "var(--gold)" : "var(--border)"}`,
                }}
                title={r.origin === "net_new" ? "Exported from Net-New Leads" : "Exported from Discovered"}
              >
                {r.origin === "net_new" ? "Net-New" : "Discovered"}
              </span>
              <span className="text-sm font-medium">{r.company_ids.length} {r.company_ids.length === 1 ? "company" : "companies"}</span>
              <span className="text-xs text-[var(--text-muted)]">{dateStr} · {timeStr}</span>
              <div className="flex-1" />
              <button
                onClick={() => toggle(r.id)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {isOpen ? "▲ Hide" : "▼ Companies"}
              </button>
              <button
                onClick={() => viewSql(r)}
                className="rounded-md border px-3 py-1 text-xs font-medium"
                style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
              >
                View SQL
              </button>
              <button
                onClick={() => downloadCsv(r)}
                className="rounded-md border px-3 py-1 text-xs font-medium"
                style={{ borderColor: "var(--tier-a)", color: "var(--tier-a)" }}
              >
                Download CSV
              </button>
            </div>
            {isOpen && (
              <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2">
                  {r.company_names.map((name, i) => (
                    <span
                      key={i}
                      className="rounded-full border px-2 py-0.5 text-xs"
                      style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DetailDrawer({
  company,
  onClose,
  onSaveNote,
  onRate,
}: {
  company: Company;
  onClose: () => void;
  onSaveNote: (id: string, notes: string) => void;
  onRate: (id: string, rating: number | null, comment: string | null) => void;
}) {
  const [note, setNote] = useState(company.notes ?? "");
  const [ratingComment, setRatingComment] = useState(company.rating_comment ?? "");
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

        {/* Lead quality rating — feeds the learning loop. */}
        <div className="mb-4 rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Rate lead quality</span>
            {company.rating != null && (
              <button onClick={() => onRate(company.id, null, ratingComment || null)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">clear</button>
            )}
          </div>
          <div className="flex items-center gap-1 text-2xl leading-none">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => onRate(company.id, n, ratingComment || null)}
                className="transition-transform hover:scale-110"
                style={{ color: company.rating != null && n <= company.rating ? "var(--gold)" : "var(--border)" }}
                title={`${n} star${n > 1 ? "s" : ""}`}
              >
                ★
              </button>
            ))}
          </div>
          <textarea
            value={ratingComment}
            onChange={(e) => setRatingComment(e.target.value)}
            onBlur={() => { if (company.rating != null) onRate(company.id, company.rating, ratingComment || null); }}
            placeholder="Why? (optional — helps the bot learn what's working)"
            className="mt-2 h-14 w-full rounded-md border bg-[var(--surface)] p-2 text-xs outline-none"
            style={{ borderColor: "var(--border)" }}
          />
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
              {s.signal_date && (
                <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {new Date(s.signal_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </p>
              )}
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
