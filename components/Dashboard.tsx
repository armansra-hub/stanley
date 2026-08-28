"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Company, CompanyStatus } from "@/lib/types";
import type { ExportRecord } from "@/lib/db/companies";
import { formatNow } from "@/lib/time";
import { buildNetsuiteSqlExport, type SqlExportConfig } from "@/lib/export/sql";
import { buildCsvExport, buildFullCsvExport } from "@/lib/export/csv";
import { scoreBand } from "@/lib/scoring";
import { SUBINDUSTRIES } from "@/config/territory";
import { parseCsv, rowsToBaseRows, rowsToTalRows } from "@/lib/csv";
import { ACTORS } from "@/config/actors";
import { ScoreBadge, TierBadge, SignalChips, SourceBadge, sourceLabel, strongestSignal } from "./badges";
import ChatPanel from "./ChatPanel";

type Tab = "triggered" | "oldgold" | "tal" | "imported" | "starred" | "history";
type TriggerPreview = { type: string; summary: string; source_name: string | null; source_url: string | null; signal_date: string | null; detected_at: string };
type InsightBadge = { kind: string; label: string; detail: string | null; evidence: string; evidence_url: string | null; confidence: string };

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
  exportHistory = [],
  lastRefreshAt = null,
}: {
  initial: Company[];
  usingSample?: boolean;
  exportConfig?: SqlExportConfig;
  actorOverrides?: Record<string, { enabled?: boolean }>;
  exportHistory?: ExportRecord[];
  lastRefreshAt?: string | null;
}) {
  const [companies, setCompanies] = useState<Company[]>(initial);
  const [tab, setTab] = useState<Tab>("triggered");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  // In-app TAL alerts (claimed accounts with a new signal) — the only notification.
  const [talAlerts, setTalAlerts] = useState<(Company & { top_trigger?: { type: string; summary: string } | null })[]>([]);
  const [talAlertsOpen, setTalAlertsOpen] = useState(false);
  useEffect(() => { fetch("/api/headhunter/tal-alerts").then((r) => (r.ok ? r.json() : null)).then((d) => d?.companies && setTalAlerts(d.companies)).catch(() => {}); }, []);
  function clearTalAlerts(ids?: string[]) {
    setTalAlerts((prev) => (ids ? prev.filter((c) => !ids.includes(c.id)) : []));
    void fetch("/api/headhunter/tal-alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ids ? { ids } : {}) });
  }
  const [sqlModal, setSqlModal] = useState<string | null>(null);
  // Real last-refresh = the most recent suite activity (cron / import / trigger sweep)
  // from the app_events log; falls back to the newest company update. "Refresh now"
  // overrides it for the session.
  const dataLastRefresh = useMemo(() => {
    const fromEvents = lastRefreshAt ? new Date(lastRefreshAt).getTime() : 0;
    const fromRows = initial.reduce((m, c) => Math.max(m, new Date(c.last_updated_at ?? 0).getTime() || 0), 0);
    const latest = Math.max(fromEvents, fromRows);
    return latest ? new Date(latest).toLocaleString() : "—";
  }, [initial, lastRefreshAt]);
  const [lastRefresh, setLastRefresh] = useState(dataLastRefresh);
  const [refreshing, setRefreshing] = useState(false);

  // Live clock — the app always knows the current date/time (foundation for the
  // Missions calendar). Updates every second.
  const [clock, setClock] = useState<string>(() => formatNow());
  useEffect(() => {
    const t = setInterval(() => setClock(formatNow()), 1000);
    return () => clearInterval(t);
  }, []);
  // Next scheduled batch: the daily discovery cron fires 12:30 UTC; show the next one.
  const nextUpdate = useMemo(() => {
    const n = new Date();
    const next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 12, 30, 0));
    if (next.getTime() <= n.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const mins = Math.round((next.getTime() - n.getTime()) / 60000);
    const rel = mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.round(mins / 60)} h` : "tomorrow";
    return { when: next.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }), rel };
  }, [clock]);
  const [importing, setImporting] = useState(false);
  const baseRef = useRef<HTMLInputElement>(null);
  const [baseVendor, setBaseVendor] = useState<"zoominfo" | "linkedin" | "netsuite">("zoominfo");
  const [baseList, setBaseList] = useState(""); // silo/list name; blank → "<vendor>_tam"
  const talRef = useRef<HTMLInputElement>(null);
  const [talImporting, setTalImporting] = useState(false);

  // Parse a .csv OR .xlsx file → array-of-arrays (xlsx via SheetJS, lazy-loaded).
  async function fileToGrid(file: File): Promise<string[][]> {
    if (/\.xlsx?$/i.test(file.name)) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, raw: false, defval: "" });
    }
    return parseCsv(await file.text());
  }

  // TAM Base bulk import: parse the vendor CSV/XLSX client-side, chunk it, and load
  // it fast (dedupe + hard-blocks + ERP-readiness happen server-side; no enrichment).
  async function handleBaseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const rows = rowsToBaseRows(await fileToGrid(file));
      if (rows.length === 0) { alert("No company rows found (need a name column)."); return; }
      const CHUNK = 3000;
      let batchId: string | null = null;
      const tot = { total: 0, imported: 0, updated: 0, blocked: 0, no_domain: 0 };
      for (let i = 0; i < rows.length; i += CHUNK) {
        const res: Response = await fetch("/api/import/base", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ vendor: baseVendor, list: baseList, filename: file.name, rows: rows.slice(i, i + CHUNK), batchId }),
        });
        const r: Record<string, number> & { error?: string; batchId?: string | null } = await res.json();
        if (!res.ok) { alert(`Import failed: ${r.error ?? res.status}`); return; }
        batchId = r.batchId ?? batchId;
        for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += (r[k] as number) ?? 0;
      }
      alert(`${baseVendor.toUpperCase()} base import:\n${tot.imported} new · ${tot.updated} merged · ${tot.blocked} blocked (off-ICP) · ${tot.no_domain} without a domain.`);
      location.reload();
    } catch {
      alert("Base import failed.");
    } finally {
      setImporting(false);
    }
  }

  // ARS Target Account List: exact NetSuite Internal IDs are the sole identity.
  // The server validates the complete file before changing any membership flag.
  async function handleTalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setTalImporting(true);
    try {
      const rows = rowsToTalRows(await fileToGrid(file));
      if (rows.length === 0) { alert("No company rows found in the TAL (need company name and Internal ID columns)."); return; }
      const res = await fetch("/api/headhunter/tal/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
      const r: { matched?: number; tal_count?: number; newly_dq?: number; verified_claimed?: number; membership_sha256?: string; error?: string } = await res.json();
      if (!res.ok) { alert(`TAL sync failed: ${r.error ?? res.status}`); return; }
      alert(`TAL exact-ID sync verified: ${r.verified_claimed ?? r.matched ?? 0} claimed rows${r.newly_dq ? `, ${r.newly_dq} newly marked PREVIOUSLY DQ'd` : ""} (from ${r.tal_count ?? rows.length} unique NetSuite IDs).`);
      location.reload();
    } catch (error) {
      alert(`TAL sync failed: ${error instanceof Error ? error.message : "unexpected error"}`);
    } finally {
      setTalImporting(false);
    }
  }

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


  // filters
  const [search, setSearch] = useState("");
  const [subindustry, setSubindustry] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [band, setBand] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  // Sortable table columns (click a header to toggle asc/desc).
  type SortKey = "company" | "score" | "tier" | "source" | "state" | "size" | "rating" | "status";
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "score", dir: "desc" });
  const [userSorted, setUserSorted] = useState(false); // until a header is clicked, keep the server's ranking
  const onSort = (key: SortKey) => { setUserSorted(true); setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "company" || key === "source" || key === "state" ? "asc" : "desc" })); };
  const TIER_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  const sortValue = (c: Company, key: SortKey): string | number => {
    switch (key) {
      case "company": return c.name.toLowerCase();
      case "score": return (isBase || isTal) ? (c.tam_score ?? -1) : isOldGold ? (c.oldgold_score ?? -1) : c.signal_score; // header shows TAM / Old Gold / Score per tab
      case "tier": return TIER_RANK[c.score_tier ?? ""] ?? 9;
      case "source": return sourceLabel(c.sources?.[0] ?? "").toLowerCase();
      case "state": return (c.state ?? "").toLowerCase();
      case "size": return (c.employee_band ?? "").toLowerCase();
      case "rating": return c.rating ?? -1;
      case "status": return c.status;
    }
  };

  const importedHasNew = companies.some((c) => c.source === "imported" && c.has_new_signal);


  const states = useMemo(
    () => Array.from(new Set(companies.map((c) => c.state).filter(Boolean))).sort() as string[],
    [companies],
  );

  const isHistory = tab === "history";
  const isBase = tab === "imported"; // TAM Base — server-paged (14k+), not loaded into the browser
  const isStarred = tab === "starred";

  // ── Starred: server-backed so leads starred from ANY tab (TAM Base, Triggered) show
  // up — not just ones in the in-browser `companies` set. ──
  const [starredRows, setStarredRows] = useState<Company[]>([]);
  async function fetchStarred() {
    const res = await fetch("/api/headhunter/starred");
    if (!res.ok) return;
    const r: { companies?: Company[] } = await res.json();
    setStarredRows(r.companies ?? []);
  }
  useEffect(() => { fetchStarred(); }, []); // on mount → badge count + instant tab

  // ── TAM Base: server-backed, filtered, paginated (so 14k+ rows never hit the DOM) ──
  const [baseRows, setBaseRows] = useState<Company[]>([]);
  const [baseTotal, setBaseTotal] = useState(0);
  const [baseOffset, setBaseOffset] = useState(0);
  const [baseLoading, setBaseLoading] = useState(false);
  const [baseTags, setBaseTags] = useState<{ tag: string; count: number }[]>([]);
  // The subindustry labels the claimable TAM ACTUALLY uses (coarse buckets), so the
  // filter dropdown matches the data instead of the granular config list.
  const [baseSubs, setBaseSubs] = useState<string[]>([]);
  const [oldGoldClasses, setOldGoldClasses] = useState<string[]>([]);
  const [whyClass, setWhyClass] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagMatchAll, setTagMatchAll] = useState(false);
  const [claimableOnly, setClaimableOnly] = useState(true);
  const [erpOnly, setErpOnly] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const BASE_PAGE = 250;

  /** The current TAM Base filter as the server expects it. */
  // Score-range filter (TAM Base filters tam_score; Old Gold filters oldgold_score).
  // null = unbounded. Server-side, so paging/totals/exports all respect it.
  const [scoreMin, setScoreMin] = useState<number | null>(null);
  const [scoreMax, setScoreMax] = useState<number | null>(null);
  const baseFilterBody = (extra: Record<string, unknown>) => ({
    tags: [...selectedTags], matchAll: tagMatchAll, claimable: claimableOnly, erp: erpOnly,
    state: stateFilter, q: search, includeHidden: showClosed, currentTam: true,
    whyClass: whyClass || undefined,
    scoreMin: scoreMin ?? undefined, scoreMax: scoreMax ?? undefined, ...extra,
  });

  async function fetchBase(offset = 0) {
    setBaseLoading(true);
    const res = await fetch("/api/headhunter/base", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(baseFilterBody({ limit: BASE_PAGE, offset })) });
    const r: { companies?: Company[]; total?: number } | null = res.ok ? await res.json() : null;
    setBaseLoading(false);
    if (!r) return;
    setBaseTotal(r.total ?? 0);
    setBaseOffset(offset);
    setBaseRows(offset === 0 ? (r.companies ?? []) : (prev) => [...prev, ...(r.companies ?? [])]);
  }
  /** Pull EVERY row matching the current filter (paged server-side), for bulk export. */
  async function fetchAllBase(): Promise<Company[]> {
    const all: Company[] = [];
    const LIM = 1000;
    for (let off = 0; off < 50000; off += LIM) {
      const res = await fetch("/api/headhunter/base", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(baseFilterBody({ limit: LIM, offset: off })) });
      if (!res.ok) break;
      const r: { companies?: Company[]; total?: number } = await res.json();
      const batch = r.companies ?? [];
      all.push(...batch);
      if (batch.length < LIM || all.length >= (r.total ?? 0)) break;
    }
    return all;
  }
  // Load the tag list once the TAM Base tab is first opened.
  useEffect(() => {
    if ((isBase || tab === "triggered" || tab === "oldgold") && baseTags.length === 0) fetch("/api/headhunter/base").then((x) => (x.ok ? x.json() : null)).then((d) => { if (d?.tags) setBaseTags(d.tags); if (d?.subindustries) setBaseSubs(d.subindustries); if (d?.oldgoldClasses) setOldGoldClasses(d.oldgoldClasses); });
  }, [isBase, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // Refetch page 0 whenever a base filter changes (debounced for typing).
  useEffect(() => {
    if (!isBase) return;
    const t = setTimeout(() => fetchBase(0), 250);
    return () => clearTimeout(t);
  }, [isBase, selectedTags, tagMatchAll, claimableOnly, erpOnly, stateFilter, search, showClosed, scoreMin, scoreMax, whyClass]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleTag = (t: string) => setSelectedTags((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });

  // ── Old Gold: qual-note leads ranked by revival score (dead at the bottom) ──
  const isOldGold = tab === "oldgold";
  const [oldGoldRows, setOldGoldRows] = useState<Company[]>([]);
  const [oldGoldTotal, setOldGoldTotal] = useState(0);
  const [oldGoldOffset, setOldGoldOffset] = useState(0);
  const [oldGoldLoading, setOldGoldLoading] = useState(false);
  const whyClassOptions = useMemo(
    () => [...new Set([...Object.keys(OLDGOLD_CLASS), ...oldGoldClasses])],
    [oldGoldClasses],
  );
  async function fetchOldGold(offset = 0) {
    setOldGoldLoading(true);
    const res = await fetch("/api/headhunter/oldgold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 250, offset, q: search, state: stateFilter, subindustry, scoreMin: scoreMin ?? undefined, scoreMax: scoreMax ?? undefined, whyClass: whyClass || undefined, includeHidden: showClosed }) });
    const r: { companies?: Company[]; total?: number } | null = res.ok ? await res.json() : null;
    setOldGoldLoading(false);
    if (!r) return;
    setOldGoldTotal(r.total ?? 0);
    setOldGoldOffset(offset);
    setOldGoldRows(offset === 0 ? (r.companies ?? []) : (prev) => [...prev, ...(r.companies ?? [])]);
  }
  useEffect(() => {
    if (!isOldGold) return;
    const t = setTimeout(() => fetchOldGold(0), 250);
    return () => clearTimeout(t);
  }, [isOldGold, search, stateFilter, subindustry, scoreMin, scoreMax, whyClass, showClosed]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── Target Account List: the AE's claimed accounts. STAGNANT by design — exports
  // never remove a row; membership changes only via a fresh TAL CSV upload. ──
  const isTal = tab === "tal";
  const [talRows, setTalRows] = useState<TriggeredRow[]>([]);
  const [talTotal, setTalTotal] = useState(0);
  const [talLoading, setTalLoading] = useState(false);
  async function fetchTal() {
    setTalLoading(true);
    const res = await fetch("/api/headhunter/tal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: search, state: stateFilter, subindustry }) });
    const r: { companies?: TriggeredRow[]; total?: number } | null = res.ok ? await res.json() : null;
    setTalLoading(false);
    if (!r) return;
    setTalTotal(r.total ?? 0);
    setTalRows(r.companies ?? []);
  }
  useEffect(() => {
    const t = setTimeout(() => fetchTal(), 250); // always loaded: tab count + alert dot live even off-tab
    return () => clearTimeout(t);
  }, [isTal, search, stateFilter, subindustry]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── Triggered worklist: base companies with an active (decaying) trigger, ranked ──
  type TriggeredRow = Company & { top_trigger?: TriggerPreview | null; all_triggers?: TriggerPreview[]; trigger_count?: number; trigger_types?: string[]; insights?: InsightBadge[] };
  const isTriggered = tab === "triggered";
  const [triggeredRows, setTriggeredRows] = useState<TriggeredRow[]>([]);
  const [triggeredTotal, setTriggeredTotal] = useState(0);
  const [triggeredOffset, setTriggeredOffset] = useState(0);
  const [triggeredLoading, setTriggeredLoading] = useState(false);
  const TRIGGER_PAGE = 250;
  // Signal-type multi-select (mirrors the Tags dropdown): empty = all signals.
  const [selectedSignals, setSelectedSignals] = useState<Set<string>>(new Set());
  const [signalMatchAll, setSignalMatchAll] = useState(false);
  const [signalDateFrom, setSignalDateFrom] = useState("");
  const [signalDateTo, setSignalDateTo] = useState("");
  const [minimumEmployees, setMinimumEmployees] = useState("");
  const [minimumParticipants, setMinimumParticipants] = useState("");
  const [signalsOpen, setSignalsOpen] = useState(false);
  const toggleSignal = (t: string) => setSelectedSignals((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  /** The current Triggered filter as the server expects it (mirrors Discovered/TAM Base). */
  const triggeredFilterBody = (extra: Record<string, unknown>) => ({
    includeHidden: showClosed, q: search, state: stateFilter, subindustry, band,
    claimable: claimableOnly, erp: erpOnly, tags: [...selectedTags], matchAll: tagMatchAll,
    types: [...selectedSignals], signalMatchAll,
    signalDateFrom: signalDateFrom || undefined, signalDateTo: signalDateTo || undefined,
    minimumEmployees: minimumEmployees === "" ? undefined : Number(minimumEmployees),
    minimumParticipants: minimumParticipants === "" ? undefined : Number(minimumParticipants),
    ...extra,
  });
  async function fetchTriggered(offset = 0) {
    setTriggeredLoading(true);
    const res = await fetch("/api/headhunter/triggered", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(triggeredFilterBody({ limit: TRIGGER_PAGE, offset })) });
    const r: { companies?: TriggeredRow[]; total?: number } | null = res.ok ? await res.json() : null;
    setTriggeredLoading(false);
    if (!r) return;
    setTriggeredTotal(r.total ?? 0);
    setTriggeredOffset(offset);
    setTriggeredRows(offset === 0 ? (r.companies ?? []) : (prev) => [...prev, ...(r.companies ?? [])]);
  }
  async function fetchAllTriggered(): Promise<TriggeredRow[]> {
    const all: TriggeredRow[] = [];
    const LIM = 1000;
    for (let off = 0; off < 50000; off += LIM) {
      const res = await fetch("/api/headhunter/triggered", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(triggeredFilterBody({ limit: LIM, offset: off })) });
      if (!res.ok) break;
      const r: { companies?: TriggeredRow[]; total?: number } = await res.json();
      const batch = r.companies ?? [];
      all.push(...batch);
      if (batch.length < LIM || all.length >= (r.total ?? 0)) break;
    }
    return all;
  }
  // Refetch page 0 whenever a Triggered filter changes (debounced for typing).
  useEffect(() => {
    if (!isTriggered) return;
    const t = setTimeout(() => fetchTriggered(0), 250);
    return () => clearTimeout(t);
  }, [isTriggered, showClosed, search, stateFilter, subindustry, band, claimableOnly, erpOnly, selectedTags, tagMatchAll, selectedSignals, signalMatchAll, signalDateFrom, signalDateTo, minimumEmployees, minimumParticipants]); // eslint-disable-line react-hooks/exhaustive-deps
  const TRIGGER_LABELS: Record<string, string> = {
    "2026_inc_5000": "🏅 2026 Inc. 5000",
    erp_tech: "⚡ ERP-ready", funding: "💰 Funding", ma: "🤝 M&A (acquirer)", finance_hire: "🧮 Finance hire",
    new_entity: "🏛 New entity", gov_contract: "📜 Gov contract", fleet_expansion: "🚚 Fleet growth",
    hiring_velocity: "🚛 Driver surge", headcount_50: "🏥 Crossed 50 emp (ACA)", ucc_financing: "🏦 Growth loan (UCC-1)",
    sba_loan: "💵 SBA growth loan", press: "📈 Expansion", news: "📰 News",
    employee_milestone: "👥 Employee threshold", employee_growth: "📈 Employee growth", employee_absolute_growth: "➕ Employee addition", employee_consecutive_growth: "🚀 Consecutive employee growth", employee_decline: "📉 Employee decline",
    revenue_milestone: "💰 Revenue threshold", sba_other_than_small: "🏢 Other than small", sba_size_changed: "📏 SBA size changed",
    federal_award: "📜 Federal award", federal_new_award: "🆕 New federal award", federal_first_activity: "🏛 First federal activity",
    federal_obligation_growth: "📈 Federal obligations growth", federal_incumbent_funding: "💵 Incumbent funding increase",
    federal_active_ceiling: "📋 Active contract ceiling", federal_subaward: "🔗 Federal subcontract", federal_prime_subaward_activity: "🧩 Prime subcontract activity",
    sam_award_notice: "🏆 SAM award notice", sam_incumbent_recompete: "🔄 Possible incumbent recompete",
  };
  // Options for the Signals ▾ filter — every trigger type plus the synthetic
  // DOL-5500 headcount signal (those leads surface without a trigger row).
  const SIGNAL_OPTIONS: [string, string][] = [
    ...Object.entries(TRIGGER_LABELS),
    ["headcount_growth", "📈 Headcount ≥25% (DOL 5500)"],
  ];
  const sinceLabel = (iso: string | null | undefined) => { if (!iso) return ""; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d <= 0 ? "today" : d === 1 ? "1d ago" : d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`; };

  // Starred (server-backed) with the same client filters as Discovered; shows every
  // starred lead even exported, so no hidden-status filter here.
  const starredVisible = useMemo(() => {
    return starredRows.filter((c) => {
      if (!c.starred) return false;
      if (subindustry && c.subindustry !== subindustry) return false;
      if (stateFilter && c.state !== stateFilter) return false;
      if (band && scoreBand(c.signal_score) !== band) return false;
      if (search) { const q = search.toLowerCase(); if (!c.name.toLowerCase().includes(q) && !(c.domain ?? "").includes(q)) return false; }
      return true;
    }).sort((a, b) => Number(a.record_dead ?? false) - Number(b.record_dead ?? false) // dead sinks, like every other tab
      || (b.tam_score ?? -1) - (a.tam_score ?? -1)
      || b.signal_score - a.signal_score);
  }, [starredRows, subindustry, stateFilter, band, search]);

  const selectionSource = isTal ? talRows : isOldGold ? oldGoldRows : isStarred ? starredRows : isTriggered ? triggeredRows : isBase ? baseRows : companies; // rows the current tab's checkboxes act on
  // "Mark reviewed" hides a lead (reviewed/dismissed/exported) until "Show hidden" is on.
  const isHiddenStatus = (s: string) => s === "reviewed" || s === "dismissed" || s === "removed_from_tam" || s.startsWith("exported");
  const serverOrderedRows = isTal ? talRows // stagnant claimed list — alerts first, NEVER hidden by status
    : isOldGold ? oldGoldRows.filter((c) => !c.tal_claimed && (showClosed || !isHiddenStatus(c.status)))
    : isStarred ? starredVisible
    : isTriggered ? triggeredRows.filter((c) => showClosed || !isHiddenStatus(c.status))
    : isBase ? baseRows.filter((c) => !c.tal_claimed && (showClosed || !isHiddenStatus(c.status))) : [];
  // Header clicks re-rank client-side (dead always sinks); otherwise the server's ranking stands.
  const tableRows = userSorted
    ? [...serverOrderedRows].sort((a, b) => {
        const dead = Number(a.record_dead ?? false) - Number(b.record_dead ?? false);
        if (dead) return dead;
        const av = sortValue(a, sort.key), bv = sortValue(b, sort.key);
        const cmp = typeof av === "string" ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
        return sort.dir === "asc" ? cmp : -cmp;
      })
    : serverOrderedRows;
  const idsInView = serverOrderedRows.map((c) => c.id);
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

  // Patch matching rows in WHICHEVER list they live in (Discovered, TAM Base, or
  // Triggered) so checkbox actions reflect on every tab, not just Discovered.
  const idSet = (ids: string[]) => new Set(ids);
  function patchRows(ids: string[], patch: Partial<Company>) {
    const s = idSet(ids);
    const upd = <T extends { id: string }>(arr: T[]) => arr.map((c) => (s.has(c.id) ? { ...c, ...patch } : c));
    setCompanies(upd);
    setBaseRows(upd);
    setTriggeredRows(upd);
    setStarredRows(upd);
    setOldGoldRows(upd);
    setTalRows(upd);
  }

  function applyStatusLocal(ids: string[], status: CompanyStatus) {
    patchRows(ids, { status, ...(status.startsWith("exported") ? { exported_at: new Date().toISOString() } : {}) });
    setSelected(new Set());
  }

  async function changeStatus(ids: string[], status: "new" | "reviewed" | "dismissed"): Promise<boolean> {
    try {
      const response = await fetch("/api/companies/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, status }),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      // One company.status drives TAM Base and Old Gold. Patch every loaded list
      // only after the production write succeeds so the two tabs cannot diverge.
      applyStatusLocal(ids, status);
      return true;
    } catch (error) {
      console.error("status update failed", error);
      alert("Stanley could not save that review decision. Nothing was changed.");
      return false;
    }
  }

  function toggleStar(id: string, value: boolean) {
    patchRows([id], { starred: value });
    // resync the starred list so a newly-starred lead (not already in starredRows) is added
    void postJSON("/api/companies/star", { ids: [id], value }).then(fetchStarred);
  }
  function toggleThumbsDown(id: string, value: boolean) {
    patchRows([id], { thumbs_down: value });
    void postJSON("/api/companies/thumbsdown", { ids: [id], value });
  }
  function bulkStar(value: boolean) {
    const ids = [...selected];
    patchRows(ids, { starred: value });
    setSelected(new Set());
    void postJSON("/api/companies/star", { ids, value }).then(fetchStarred);
  }

  const starredCount = starredRows.filter((c) => c.starred).length;

  // Persist the export (which marks the leads exported server-side) THEN refetch the
  // active server-backed tab so the exported batch drops out and the next leads load.
  async function recordExportAndRefresh(ids: string[], type: "csv" | "sql", payload: string) {
    await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, type, payload, origin: "discovered" }) });
    if (isBase) await fetchBase(0);
    else if (isTriggered) await fetchTriggered(0);
  }

  function exportSql() {
    const chosen = selectionSource.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const { text } = buildNetsuiteSqlExport(
      chosen.map((c) => ({ name: c.name, website: c.website_raw ?? c.domain })),
      exportConfig,
    );
    setSqlModal(text);
    applyStatusLocal(ids.filter((id) => !chosen.find((c) => c.id === id)?.tal_claimed), "exported_sql");
    void recordExportAndRefresh(ids, "sql", text);
  }
  function exportCsv() {
    const chosen = selectionSource.filter((c) => selected.has(c.id));
    const ids = chosen.map((c) => c.id);
    const csv = buildFullCsvExport(chosen); // every column we hold
    download("stanley-export.csv", csv, "text/csv");
    // TAL rows are stagnant: exporting must never hide them (server skips their
    // status flip too) — only non-claimed rows get marked exported.
    applyStatusLocal(ids.filter((id) => !chosen.find((c) => c.id === id)?.tal_claimed), "exported_csv");
    void recordExportAndRefresh(ids, "csv", csv);
  }

  /** Export EVERY lead matching the current filter (all server pages), not just the
   * loaded ones — then mark them exported and refresh so the next batch surfaces. */
  async function exportAllFiltered(kind: "csv" | "sql") {
    if (exportingAll) return;
    setExportingAll(true);
    try {
      const rows = isTriggered ? await fetchAllTriggered() : await fetchAllBase();
      if (rows.length === 0) { alert("Nothing matches the current filter."); return; }
      if (rows.length > 500 && !confirm(`Export ${rows.length.toLocaleString()} leads and mark them all exported (they'll move to hidden)? Narrow the filter first if you only want a subset.`)) return;
      const ids = rows.map((c) => c.id);
      let payload: string;
      if (kind === "csv") {
        payload = buildFullCsvExport(rows);
        download("stanley-tam-export.csv", payload, "text/csv");
      } else {
        payload = buildNetsuiteSqlExport(rows.map((c) => ({ name: c.name, website: c.website_raw ?? c.domain })), exportConfig).text;
        setSqlModal(payload);
      }
      setSelected(new Set());
      await recordExportAndRefresh(ids, kind, payload);
    } finally {
      setExportingAll(false);
    }
  }

  function acknowledge(id: string) {
    patchRows([id], { has_new_signal: false });
    void postJSON("/api/companies/acknowledge", { id });
  }

  function saveNote(id: string, notes: string) {
    patchRows([id], { notes });
    void postJSON("/api/companies/note", { id, notes });
  }
  function rateCompany(id: string, rating: number | null, comment: string | null) {
    patchRows([id], { rating, rating_comment: comment });
    void postJSON("/api/companies/rate", { id, rating, comment });
  }

  const drawer = [...companies, ...baseRows, ...triggeredRows, ...oldGoldRows, ...starredRows, ...talRows, ...talAlerts].find((c) => c.id === drawerId) ?? null;

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
          <div className="relative">
            <button onClick={() => setTalAlertsOpen((o) => !o)} className="rounded-md border px-3 py-1.5 font-medium" style={{ borderColor: talAlerts.length ? "rgba(220,38,38,0.55)" : "var(--border)", color: talAlerts.length ? "#ef4444" : "var(--text-muted)" }} title="New signals on your claimed (TAL) accounts">
              🔔{talAlerts.length > 0 ? ` ${talAlerts.length}` : ""}
            </button>
            {talAlertsOpen && (
              <div className="absolute right-0 z-30 mt-1 w-80 rounded-md border p-2 shadow-xl" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold">Claimed-account alerts</span>
                  {talAlerts.length > 0 && <button onClick={() => clearTalAlerts()} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">Clear all</button>}
                </div>
                {talAlerts.length === 0 ? (
                  <div className="px-1 py-2 text-xs text-[var(--text-muted)]">No new signals on claimed accounts.</div>
                ) : talAlerts.map((c) => (
                  <button key={c.id} onClick={() => { setTalAlertsOpen(false); setDrawerId(c.id); clearTalAlerts([c.id]); }} className="block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--surface-2)]">
                    <div className="text-sm font-medium" style={{ color: "#ef4444" }}>{c.name}</div>
                    {c.top_trigger && <div className="truncate text-[11px] text-[var(--text-muted)]">{c.top_trigger.summary}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link href="/settings" className="rounded-md border px-3 py-1.5 font-medium" style={{ borderColor: "var(--border)" }} title="Settings">
            ⚙ Settings
          </Link>
          <span className="tabular-nums text-[var(--gold)]" title="Current date & time">🕑 {clock}</span>
          <span className="text-[var(--text-muted)]">Last refresh {lastRefresh}</span>
          <span className="text-[var(--text-muted)]" title={`Next scheduled lead batch — daily discovery cron at 12:30 UTC. Next: ${nextUpdate.when}`}>· Next update <span className="text-[var(--gold)]">{nextUpdate.rel}</span></span>
          {/* TAM Base bulk import: pick the vendor, drop the CSV. The vendor dropdown
              scopes ONLY to this group — the TAL button below is a separate flow. */}
          <span className="inline-flex items-center overflow-hidden rounded-md border" style={{ borderColor: "var(--border)" }}>
            <span className="border-r px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }} title="This dropdown + list name apply ONLY to a TAM Base import (which vendor exported the CSV).">TAM Base ▸</span>
            <select value={baseVendor} onChange={(e) => setBaseVendor(e.target.value as any)} className="bg-transparent px-2 py-1.5 text-xs outline-none" style={{ color: "var(--text)" }} title="Which vendor exported this CSV (sets the fit weight)">
              <option value="zoominfo" style={{ background: "var(--surface)" }}>ZoomInfo</option>
              <option value="linkedin" style={{ background: "var(--surface)" }}>LinkedIn</option>
              <option value="netsuite" style={{ background: "var(--surface)" }}>NetSuite (truth)</option>
            </select>
            <input value={baseList} onChange={(e) => setBaseList(e.target.value)} placeholder={`${baseVendor}_tam`} title="List/silo name — each named CSV is its own list, updated independently (e.g. netsuite_tam, zoominfo_growth)" className="w-32 border-l bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-[var(--text-muted)]" style={{ borderColor: "var(--border)", color: "var(--text)" }} />
            <button onClick={() => baseRef.current?.click()} disabled={importing} className="border-l px-3 py-1.5 text-xs font-medium" style={{ borderColor: "var(--border)", color: "var(--gold)" }} title="Bulk-load a vendor ICP list into the TAM Base">
              {importing ? "Importing…" : "+ Base CSV"}
            </button>
          </span>
          <input ref={baseRef} type="file" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleBaseFile} className="hidden" />
          {/* ARS Target Account List sync — flags matching leads red */}
          <button onClick={() => talRef.current?.click()} disabled={talImporting} className="rounded-md border px-3 py-1.5 text-xs font-medium" style={{ borderColor: "rgba(220,38,38,0.55)", color: "#ef4444" }} title="Upload the full Target Account List CSV with NetSuite Internal IDs. The exact-ID set is validated and read back before membership changes are accepted.">
            {talImporting ? "Syncing…" : "+ TAL CSV"}
          </button>
          <input ref={talRef} type="file" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleTalFile} className="hidden" />
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
        {(["triggered", "oldgold", "tal", "imported", "starred", "history"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSelected(new Set()); }}
            className="western relative px-4 py-2 text-base"
            style={{
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t === "triggered"
              ? `🔥 Triggered${triggeredTotal ? ` (${triggeredTotal.toLocaleString()})` : ""}`
              : t === "oldgold"
                ? `🪙 Old Gold${oldGoldTotal ? ` (${oldGoldTotal.toLocaleString()})` : ""}`
                : t === "tal"
                  ? `🎯 Target Accounts${talTotal ? ` (${talTotal.toLocaleString()})` : ""}`
                  : t === "imported"
                    ? "TAM Base"
                    : t === "starred"
                      ? `★ Starred${starredCount ? ` (${starredCount})` : ""}`
                      : `Export History${exportHistory.length ? ` (${exportHistory.length})` : ""}`}
            {t === "imported" && importedHasNew && (
              <span className="absolute -right-1 top-1 h-2 w-2 rounded-full bg-[var(--tier-a)]" />
            )}
            {t === "tal" && talRows.some((c) => c.tal_alert) && (
              <span className="absolute -right-1 top-1 h-2 w-2 rounded-full bg-[#ef4444]" title="Unseen signals on claimed accounts" />
            )}
          </button>
        ))}
      </div>

      {/* Filters + bulk bar (hidden on the history tab) */}
      {!isHistory && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              placeholder="Search name or domain…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm"
              style={{ borderColor: "var(--border)" }}
            />
            {!isBase && <Select value={subindustry} onChange={setSubindustry} placeholder="All subindustries" options={(isStarred || isTriggered || isOldGold || isTal) && baseSubs.length ? baseSubs : SUBINDUSTRIES} />}
            <Select value={stateFilter} onChange={setStateFilter} placeholder="All states" options={states} />
            {(isTriggered || isStarred) && <Select value={band} onChange={setBand} placeholder="Any score" options={["Strong", "Medium", "Weak"]} />}
            {(isBase || isOldGold) && (
              <ScoreRange
                label={isBase ? "TAM score" : "Old Gold score"}
                min={scoreMin} max={scoreMax}
                onChange={(lo, hi) => { setScoreMin(lo); setScoreMax(hi); }}
              />
            )}
            {(isBase || isOldGold) && (
              <WhyClassSelect value={whyClass} onChange={setWhyClass} options={whyClassOptions} />
            )}
            {(isBase || isTriggered) ? (
              <div className="relative">
                <button onClick={() => setTagsOpen((o) => !o)} className="rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm" style={{ borderColor: selectedTags.size || claimableOnly || erpOnly ? "var(--gold)" : "var(--border)" }}>
                  Tags{selectedTags.size ? ` (${selectedTags.size})` : ""} ▾
                </button>
                {tagsOpen && (
                  <div className="absolute z-30 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border bg-[var(--surface)] p-2 text-sm shadow-lg" style={{ borderColor: "var(--border)" }}>
                    <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]"><input type="checkbox" checked={claimableOnly} onChange={(e) => setClaimableOnly(e.target.checked)} /><span style={{ color: "var(--tier-a)" }}>Claimable only</span></label>
                    <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]"><input type="checkbox" checked={erpOnly} onChange={(e) => setErpOnly(e.target.checked)} /><span>⚡ ERP-ready only</span></label>
                    <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
                    <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Lists</div>
                    {baseTags.map((t) => (
                      <label key={t.tag} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]">
                        <input type="checkbox" checked={selectedTags.has(t.tag)} onChange={() => toggleTag(t.tag)} />
                        <span className="flex-1">{t.tag}</span>
                        <span className="text-[10px] text-[var(--text-muted)]">{t.count.toLocaleString()}</span>
                      </label>
                    ))}
                    {selectedTags.size > 1 && (
                      <label className="mt-1 flex items-center gap-2 border-t px-2 pt-1.5 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
                        <input type="checkbox" checked={tagMatchAll} onChange={(e) => setTagMatchAll(e.target.checked)} />
                        Match ALL (in every checked list)
                      </label>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            {isTriggered && (
              <div className="relative">
                <button onClick={() => setSignalsOpen((o) => !o)} className="rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm" style={{ borderColor: selectedSignals.size ? "var(--gold)" : "var(--border)" }}>
                  Signals{selectedSignals.size ? ` (${selectedSignals.size})` : ""} ▾
                </button>
                {signalsOpen && (
                  <div className="absolute z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border bg-[var(--surface)] p-2 text-sm shadow-lg" style={{ borderColor: "var(--border)" }}>
                    <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Show only these signal types</div>
                    {SIGNAL_OPTIONS.map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--surface-2)]">
                        <input type="checkbox" checked={selectedSignals.has(key)} onChange={() => toggleSignal(key)} />
                        <span className="flex-1">{label}</span>
                      </label>
                    ))}
                    {selectedSignals.size > 0 && (
                      <button onClick={() => setSelectedSignals(new Set())} className="mt-1 w-full rounded border px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" style={{ borderColor: "var(--border)" }}>
                        Clear — show all signals
                      </button>
                    )}
                    {selectedSignals.size > 1 && (
                      <label className="mt-2 flex items-center gap-2 border-t px-2 pt-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
                        <input type="checkbox" checked={signalMatchAll} onChange={(e) => setSignalMatchAll(e.target.checked)} />
                        Only show combined signals (match every selection)
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
            {isTriggered && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  Signal date
                  <input aria-label="Signal date from" type="date" value={signalDateFrom} onChange={(e) => setSignalDateFrom(e.target.value)} className="rounded border bg-[var(--surface)] px-2 py-1" style={{ borderColor: "var(--border)" }} />
                  <span>to</span>
                  <input aria-label="Signal date to" type="date" value={signalDateTo} onChange={(e) => setSignalDateTo(e.target.value)} className="rounded border bg-[var(--surface)] px-2 py-1" style={{ borderColor: "var(--border)" }} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  Employees at least
                  <input aria-label="Minimum employees" type="number" min="0" inputMode="numeric" value={minimumEmployees} onChange={(e) => setMinimumEmployees(e.target.value)} className="w-20 rounded border bg-[var(--surface)] px-2 py-1" style={{ borderColor: "var(--border)" }} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]" title="DOL Form 5500 end-of-year active participant count; a public proxy for current headcount.">
                  Benefit participants at least
                  <input aria-label="Minimum active benefit participants" type="number" min="0" inputMode="numeric" value={minimumParticipants} onChange={(e) => setMinimumParticipants(e.target.value)} className="w-20 rounded border bg-[var(--surface)] px-2 py-1" style={{ borderColor: "var(--border)" }} />
                </label>
              </>
            )}
            <label className="ml-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              Show hidden (reviewed / dismissed)
            </label>
          </div>

          {(isBase || isTriggered) && (baseTotal > 0 || triggeredTotal > 0) && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
              <span className="font-medium">{(isTriggered ? triggeredTotal : baseTotal).toLocaleString()} match this filter</span>
              <span className="text-xs text-[var(--text-muted)]">— export the whole set, not just the loaded page</span>
              <div className="flex-1" />
              <ActionButton onClick={() => exportAllFiltered("csv")}>{exportingAll ? "Exporting…" : `⬇ Export all ${(isTriggered ? triggeredTotal : baseTotal).toLocaleString()} (CSV)`}</ActionButton>
              <ActionButton onClick={() => exportAllFiltered("sql")}>{exportingAll ? "…" : "Export all (SQL)"}</ActionButton>
            </div>
          )}

          {selectedInViewCount > 0 && (
            <div className="mb-3 flex items-center gap-2 rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
              <span className="font-medium">{selectedInViewCount} selected</span>
              <div className="flex-1" />
              <ActionButton onClick={exportSql}>Export SQL</ActionButton>
              <ActionButton onClick={exportCsv}>Export CSV</ActionButton>
              <ActionButton onClick={() => bulkStar(true)}>★ Star</ActionButton>
              <ActionButton onClick={() => bulkStar(false)}>☆ Unstar</ActionButton>
              <ActionButton onClick={() => changeStatus([...selected], "reviewed")}>Mark reviewed</ActionButton>
              {showClosed && (
                <ActionButton onClick={() => changeStatus([...selected], "new")}>Restore</ActionButton>
              )}
              <ActionButton onClick={() => changeStatus([...selected], "dismissed")} danger>Dismiss</ActionButton>
            </div>
          )}
        </>
      )}

      {/* Table / History */}
      {isHistory ? (
        <ExportHistoryPanel records={exportHistory} onReopen={(text) => setSqlModal(text)} exportConfig={exportConfig} />
      ) : (
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--surface-2)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <Th className="w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></Th>
              <Th sortKey="company" sort={sort} onSort={onSort}>Company</Th>
              <Th>What they do</Th>
              <Th>Why it's here</Th>
              <Th className="text-center" sortKey="score" sort={sort} onSort={onSort}>{(isBase || isTal) ? "TAM" : isOldGold ? "Old Gold" : "Score"}</Th>
              <Th className="text-center" sortKey="tier" sort={sort} onSort={onSort}>Tier</Th>
              <Th>Signals</Th>
              <Th sortKey="source" sort={sort} onSort={onSort}>Actor / Source</Th>
              <Th sortKey="state" sort={sort} onSort={onSort}>State</Th>
              <Th sortKey="size" sort={sort} onSort={onSort}>Size</Th>
              <Th sortKey="rating" sort={sort} onSort={onSort}>Rating</Th>
              <Th sortKey="status" sort={sort} onSort={onSort}>Status</Th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((c) => {
              const top = strongestSignal(c);
              const rawTopTrigger = (c as TriggeredRow).top_trigger;
              const allRowTriggers = (c as TriggeredRow).all_triggers ?? (rawTopTrigger ? [rawTopTrigger] : []);
              const federalRowTriggers = allRowTriggers.filter((trigger) => /^(federal_|sam_award|sam_incumbent|gov_contract)/.test(trigger.type));
              const nonAwardRowTriggers = allRowTriggers
                .filter((trigger) => !/^(federal_|sam_award|sam_incumbent|gov_contract)/.test(trigger.type))
                .sort((a, b) => new Date(b.signal_date ?? b.detected_at ?? 0).getTime() - new Date(a.signal_date ?? a.detected_at ?? 0).getTime());
              const rowTriggers = nonAwardRowTriggers.slice(0, 3);
              const rowTopTrigger = rowTriggers[0];
              const trig = rowTopTrigger;
              const hiddenRowTriggerCount = Math.max(0, nonAwardRowTriggers.length - rowTriggers.length);
              return (
                <tr
                  key={c.id}
                  className="cursor-pointer border-t hover:bg-[var(--surface-2)]/50"
                  style={{ borderColor: "var(--border)" }}
                  onClick={() => { setDrawerId(c.id); if (c.has_new_signal) acknowledge(c.id); if (isTal && c.tal_alert) { patchRows([c.id], { tal_alert: false }); clearTalAlerts([c.id]); } }}
                >
                  <Td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  </Td>
                  <Td>
                    <div className="group flex items-center gap-1.5 font-medium">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleStar(c.id, !c.starred); }}
                        title={c.starred ? "Unstar" : "Star"}
                        className="text-sm leading-none"
                        style={{ color: c.starred ? "var(--tier-b)" : "var(--text-muted)" }}
                      >
                        {c.starred ? "★" : "☆"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleThumbsDown(c.id, !c.thumbs_down); }}
                        title={c.thumbs_down ? "Remove thumbs-down" : "Thumbs down"}
                        className="text-xs leading-none transition-opacity"
                        style={{ color: c.thumbs_down ? "#ef4444" : "var(--text-muted)", opacity: c.thumbs_down ? 1 : 0.45 }}
                      >
                        👎
                      </button>
                      {c.has_new_signal && <span className="h-2 w-2 rounded-full bg-[var(--tier-a)]" />}
                      <a href={c.website_raw ?? "#"} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </a>
                      <CopyButton value={c.name} label="company name">⧉</CopyButton>
                      {c.netsuite_internal_id && <CopyButton value={c.netsuite_internal_id} label="NetSuite internal ID">#</CopyButton>}
                      {c.tal_claimed && <span className="rounded px-1.5 text-[9px] font-bold uppercase tracking-wide" style={{ background: "rgba(220,38,38,0.18)", color: "#ef4444", border: "1px solid rgba(220,38,38,0.55)" }} title="On your ARS Target Account List">ARS TAL Claimed</span>}
                      {!c.tal_claimed && c.tal_dq && <span className="rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide" style={{ background: "rgba(148,163,184,0.16)", color: "#94a3b8", border: "1px solid rgba(148,163,184,0.45)" }} title="Was on a previous TAL, dropped from the latest — you already passed on it">Previously DQ&apos;d</span>}
                      {(c as TriggeredRow).trigger_types?.includes("finance_hire") && <span className="rounded px-1.5 text-[9px] font-semibold" style={{ background: "rgba(74,128,201,0.18)", color: "#6ea8e6", border: "1px solid rgba(74,128,201,0.5)" }} title="Hiring for a finance role (own careers page or announced) — scaling finance in-house">🧮 hiring for finance</span>}
                      {c.has_parent && <span className="rounded px-1.5 text-[9px] font-semibold" style={{ background: "rgba(180,140,40,0.16)", color: "#b48c28", border: "1px solid rgba(180,140,40,0.45)" }} title={`Detected as a subsidiary${c.parent_name ? ` of ${c.parent_name}` : ""} (${c.parent_confidence ?? "?"} confidence) — the parent usually owns the ERP decision`}>🏢 {c.parent_confidence === "high" ? "subsidiary" : "likely sub"}{c.parent_name ? ` of ${c.parent_name}` : ""}</span>}
                      {c.record_dead && <span className="rounded px-1.5 text-[9px] font-bold uppercase tracking-wide" style={{ background: "rgba(220,38,38,0.14)", color: "#ef4444", border: "1px solid rgba(220,38,38,0.5)" }} title={c.record_dead_reason ?? "NetSuite record marks this lead dead"}>⛔ dead — {c.record_dead_reason?.slice(0, 60) ?? "per record"}</span>}
                      {!c.record_dead && c.oldgold_score != null && c.oldgold_score >= 40 && <span className="rounded px-1.5 text-[9px] font-semibold" style={{ background: "rgba(201,162,74,0.16)", color: "var(--gold)", border: "1px solid rgba(201,162,74,0.5)" }} title={`Old Gold revival score${c.oldgold_class ? ` — ${OLDGOLD_CLASS[c.oldgold_class]?.label ?? c.oldgold_class}` : ""}`}>🪙 {Math.round(c.oldgold_score)}</span>}
                      {!c.record_dead && (c.oldgold_score ?? 0) >= 60 && ((c as TriggeredRow).trigger_count ?? 0) > 0 && <span className="rounded px-1.5 text-[9px] font-bold" style={{ background: "rgba(239,68,68,0.14)", color: "var(--tier-a)", border: "1px solid rgba(90,154,62,0.55)" }} title="REHEATED: told us their pain/timeline before AND has a live trigger now — hottest combo in the tool">♨️ reheated</span>}
                    </div>
                    <div className="group flex items-center gap-1 text-xs text-[var(--text-muted)]">
                      {c.domain}
                      {(c.domain || c.website_raw) && <CopyButton value={bareDomain(c.domain || c.website_raw || "")} label="website">⧉</CopyButton>}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)]">{c.subindustry}</div>
                    {c.netsuite_internal_id && <div className="text-[10px] text-[var(--text-muted)]" title="NetSuite internal ID">NS&nbsp;#{c.netsuite_internal_id}</div>}
                    {(c.lists?.length ?? 0) > 0 && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {c.claimable
                          ? <span className="rounded px-1 text-[9px] font-semibold" style={{ background: "rgba(90,154,62,0.18)", color: "var(--tier-a)" }} title="In the NetSuite TAM — available to claim">CLAIMABLE</span>
                          : <span className="rounded px-1 text-[9px]" style={{ color: "var(--text-muted)" }} title="Not in the NetSuite TAM — monitor only (someone owns it)">monitor</span>}
                        {(c.lists ?? []).map((l) => <span key={l} className="rounded px-1 text-[9px]" style={{ background: "rgba(201,162,74,0.12)", color: "var(--gold)" }}>{l}</span>)}
                        {(c.lists?.length ?? 0) > 1 && <span className="text-[9px] text-[var(--text-muted)]" title="Validated across multiple lists">×{c.lists!.length}</span>}
                      </div>
                    )}
                    {c.erp_ready && (
                      <div className="text-[10px] font-medium" style={{ color: "var(--tier-a)" }} title={`Runs a QuickBooks-tier stack, no ERP yet${c.technologies?.length ? ` — ${c.technologies.slice(0, 4).join(", ")}` : ""}`}>⚡ ERP-ready</div>
                    )}
                    {c.already_on_netsuite && (
                      <div className="text-[10px] font-medium text-[var(--tier-b)]">⚠ already on NetSuite</div>
                    )}
                  </Td>
                  <Td className="max-w-[220px] text-[var(--text-muted)]">{c.description}</Td>
                  <Td className="max-w-[260px]">
                    {isTal && c.tal_alert ? <div className="mb-0.5 text-[11px] font-bold" style={{ color: "#ef4444" }}>🔔 NEW SIGNAL</div> : null}
                    {(((isOldGold || isBase) && c.oldgold_class) || (isOldGold && c.qual_note)) ? (
                      <>
                        {c.oldgold_class && <div className="text-xs font-semibold" style={{ color: OLDGOLD_CLASS[c.oldgold_class]?.color ?? "var(--gold)" }}>{OLDGOLD_CLASS[c.oldgold_class]?.label ?? c.oldgold_class}{c.last_sql_date ? ` · last SQL ${c.last_sql_date}` : ""}</div>}
                        {isOldGold && (c.oldgold_reasons ?? []).slice(0, 2).map((r, i) => <div key={i} className="text-xs text-[var(--text-muted)]">• {r}</div>)}
                        {isOldGold && !c.oldgold_class && <div className="truncate text-xs italic text-[var(--text-muted)]" title={c.qual_note ?? ""}>Note pending analysis: &quot;{(c.qual_note ?? "").slice(0, 90)}…&quot;</div>}
                        {c.revisit_on && <div className="text-[10px]" style={{ color: "var(--tier-a)" }}>⏰ revisit {c.revisit_on}</div>}
                        {/* Live events matter on Old Gold too — a stalled lead that just
                            raised money or hired finance is the one to call back first. */}
                        {rowTopTrigger && (
                          <div className="mt-0.5 text-xs font-semibold" style={{ color: "var(--gold)" }}>
                            ⚡ {TRIGGER_LABELS[trig.type] ?? trig.type} · {sinceLabel(trig.signal_date ?? trig.detected_at)}
                            {hiddenRowTriggerCount > 0 ? ` +${hiddenRowTriggerCount} more` : ""}
                          </div>
                        )}
                      </>
                    ) : nonAwardRowTriggers.length > 0 ? (
                      <>
                        <QuickViewTriggerList triggers={nonAwardRowTriggers} labels={TRIGGER_LABELS} sinceLabel={sinceLabel} />
                        {federalRowTriggers.length > 0 && <div className="mt-1 text-[11px] font-medium" style={{ color: "var(--gold)" }}>Federal contract activity — open lead record for annual totals</div>}
                      </>
                    ) : federalRowTriggers.length > 0 ? (
                      <div className="text-xs font-medium" style={{ color: "var(--gold)" }}>Federal contract activity — open lead record for annual totals</div>
                    ) : top ? (
                      <>
                        <div>{top.signal_summary}</div>
                        <a href={top.source_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)] hover:underline" onClick={(e) => e.stopPropagation()}>
                          {top.source_name} ↗
                        </a>
                      </>
                    ) : (c.headcount_growth_pct ?? 0) >= 25 ? (
                      <>
                        <div className="text-xs font-semibold" style={{ color: "var(--tier-a)" }}>📈 Headcount growth · +{Math.round(c.headcount_growth_pct as number)}%</div>
                        <div className="text-xs text-[var(--text-muted)]">DOL Form 5500 — within-year active-participant growth</div>
                      </>
                    ) : (c as TriggeredRow).trigger_types?.includes("finance_hire") ? (
                      <div className="text-xs text-[var(--text-muted)]">🧮 Hiring for a finance role (scaling finance in-house)</div>
                    ) : c.score_reason ? (
                      <div className="truncate text-xs text-[var(--text-muted)]" title={c.score_reason}>{c.score_reason}</div>
                    ) : (
                      <div className="text-xs text-[var(--text-muted)]">{isTal ? "🎯 On your Target Account List" : "In your claimable NetSuite TAM"}</div>
                    )}
                    {/* LinkedIn/website reading findings — Arman 2026-07-30: "a little
                        pop up that says LinkedIn and then whatever it is... a tag on
                        the triggered." Tag-only: never affects ranking, renders on
                        every tab a lead appears on (the join is on every list query).
                        Arman 2026-07-31: label must be self-explanatory on its own
                        ("LinkedIn NetSuite fit — what/why"), and always link back to
                        the source post/page, not just a hover tooltip. */}
                    {((c as TriggeredRow).insights ?? []).slice(0, 3).map((ins, ii) => (
                      <div key={ii} className="mt-0.5 text-[11px]" style={{ color: "var(--accent)" }}>
                        <div className="truncate" title={ins.detail ?? ins.evidence}>
                          🔗 LinkedIn {ins.kind === "netsuite_fit" ? "NetSuite fit" : "ops profile"} — {ins.label}
                          {ins.confidence === "low" ? " (low confidence)" : ""}
                        </div>
                        {ins.evidence_url ? (
                          <a href={ins.evidence_url} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                            View source ↗
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </Td>
                  <Td className="text-center">{isOldGold ? (
                    c.oldgold_score != null
                      ? <span className="text-sm font-bold" style={{ color: c.record_dead ? "#ef4444" : "var(--gold)" }}>{Math.round(c.oldgold_score)}</span>
                      : <span className="text-[10px] text-[var(--text-muted)]">—</span>
                  ) : (isBase || isTal) ? (
                    // TAM Base ranks on the holistic record grade (tam_score); provisional
                    // formula floors render muted (±) until the deep read lands.
                    c.tam_score != null
                      ? <span className="text-sm font-bold" style={{ color: c.record_dead ? "#ef4444" : c.tam_provisional ? "var(--text-muted)" : "var(--gold)" }} title={c.tam_provisional ? "Provisional formula score — deep read pending" : "TAM grade — full lead-record deep read"}>{Math.round(c.tam_score)}{c.tam_provisional ? "±" : ""}</span>
                      : <span className="text-[10px] text-[var(--text-muted)]">—</span>
                  ) : <ScoreBadge score={c.signal_score} />}</Td>
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
            {tableRows.length === 0 && (
              <tr><Td colSpan={12} className="py-10 text-center text-[var(--text-muted)]">{(isBase && baseLoading) || (isTriggered && triggeredLoading) || (isOldGold && oldGoldLoading) ? "Loading…" : isOldGold ? "No qual-note leads yet — upload the TAM CSV with qualification notes, then run the analysis." : isTriggered ? "Nothing has triggered yet — the engine sweeps the base for news/funding/hiring on the daily cron." : "No companies match these filters."}</Td></tr>
            )}
          </tbody>
        </table>
        {isBase && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
            <span>Showing {baseRows.length.toLocaleString()} of {baseTotal.toLocaleString()} in the TAM base</span>
            {baseRows.length < baseTotal && (
              <button onClick={() => fetchBase(baseOffset + BASE_PAGE)} disabled={baseLoading} className="rounded-md border px-3 py-1 font-medium" style={{ borderColor: "var(--border)", color: "var(--gold)" }}>
                {baseLoading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
        {isTriggered && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
            <span>Showing {triggeredRows.length.toLocaleString()} of {triggeredTotal.toLocaleString()} triggered, ranked by priority</span>
            {triggeredRows.length < triggeredTotal && (
              <button onClick={() => fetchTriggered(triggeredOffset + 100)} disabled={triggeredLoading} className="rounded-md border px-3 py-1 font-medium" style={{ borderColor: "var(--border)", color: "var(--gold)" }}>
                {triggeredLoading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
        {isTal && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
            <span>{talTotal ? `Your Target Account List — ${talTotal.toLocaleString()} claimed accounts (alerts first, then TAM score; never removed by exports)` : "No TAL uploaded yet — use the red “+ TAL CSV” button (NetSuite Internal ID required)."}</span>
            {talRows.some((c) => c.tal_alert) && (
              <button onClick={() => { patchRows(talRows.filter((c) => c.tal_alert).map((c) => c.id), { tal_alert: false }); clearTalAlerts(); }} className="rounded-md border px-3 py-1 font-medium" style={{ borderColor: "var(--border)", color: "var(--gold)" }}>
                Mark all alerts seen
              </button>
            )}
          </div>
        )}
        {isOldGold && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>
            <span>Showing {oldGoldRows.length.toLocaleString()} of {oldGoldTotal.toLocaleString()} qual-note leads, ranked by revival score (dead last)</span>
            {oldGoldRows.length < oldGoldTotal && (
              <button onClick={() => fetchOldGold(oldGoldOffset + 250)} disabled={oldGoldLoading} className="rounded-md border px-3 py-1 font-medium" style={{ borderColor: "var(--border)", color: "var(--gold)" }}>
                {oldGoldLoading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {drawer && <DetailDrawer company={drawer} onClose={() => setDrawerId(null)} onSaveNote={saveNote} onRate={rateCompany}
        onStar={(id, v) => toggleStar(id, v)}
        onStatus={(id, status) => { void changeStatus([id], status).then((saved) => { if (saved) setDrawerId(null); }); }} />}
      {sqlModal && <SqlModal text={sqlModal} onClose={() => setSqlModal(null)} />}
      <ChatPanel />
    </div>
  );
}

/* ── small presentational helpers ─────────────────────────────────────────── */

function Th({ children, className = "", sortKey, sort, onSort }: { children?: React.ReactNode; className?: string; sortKey?: string; sort?: { key: string; dir: "asc" | "desc" }; onSort?: (k: any) => void }) {
  const active = sortKey && sort?.key === sortKey;
  const clickable = sortKey && onSort;
  return (
    <th
      className={`px-3 py-2 font-medium ${clickable ? "cursor-pointer select-none hover:text-[var(--text)]" : ""} ${className}`}
      onClick={clickable ? () => onSort!(sortKey) : undefined}
    >
      {children}
      {active && <span className="ml-1" style={{ color: "var(--accent)" }}>{sort!.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}
function Td({ children, className = "", colSpan, onClick }: { children?: React.ReactNode; className?: string; colSpan?: number; onClick?: (e: React.MouseEvent) => void }) {
  return <td className={`px-3 py-2 align-top ${className}`} colSpan={colSpan} onClick={onClick}>{children}</td>;
}
/** Reduce any website/URL to its bare registrable domain: strip protocol, "www.",
 * any path/query/hash, and trailing slash (e.g. "https://www.website.com/about" → "website.com"). */
function bareDomain(value: string): string {
  return value.trim()
    .replace(/^[a-z]+:\/\//i, "")  // protocol
    .replace(/^www\./i, "")          // leading www.
    .replace(/[/?#].*$/, "")         // path / query / hash
    .replace(/\.+$/, "")              // trailing dots
    .toLowerCase();
}

/** Copy-to-clipboard chip that appears on row hover (e.g. company name, internal ID). */
function legacyCopy(value: string) {
  try {
    const ta = document.createElement("textarea");
    ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
  } catch { /* clipboard unavailable */ }
}
function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      // writeText returns a promise that REJECTS when blocked (e.g. document not
      // focused) — catch it so it never bubbles as an unhandled rejection, and fall
      // back to the legacy path.
      navigator.clipboard.writeText(value).catch(() => legacyCopy(value));
      return;
    }
  } catch { /* fall through to legacy path */ }
  legacyCopy(value);
}
function CopyButton({ value, label, children }: { value: string; label: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); copyText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      title={`Copy ${label}`}
      className="rounded px-1 text-[10px] leading-none text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100"
      style={copied ? { color: "var(--tier-a)", opacity: 1 } : undefined}
    >
      {copied ? "✓" : children}
    </button>
  );
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

function WhyClassSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select aria-label="Why it's here" value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border bg-[var(--surface)] px-2 py-1.5 text-sm" style={{ borderColor: value ? "var(--gold)" : "var(--border)" }}>
      <option value="">Why it&apos;s here: all</option>
      {options.map((key) => (
        <option key={key} value={key}>{OLDGOLD_CLASS[key]?.label ?? key.replaceAll("_", " ")}</option>
      ))}
    </select>
  );
}
/** Min/max score-range filter (0-100) for the TAM Base and Old Gold tabs.
 * Dual sliders + numeric inputs + one-click presets; every change flows into the
 * tab's debounced server refetch, so the list refreshes to ONLY matching leads. */
function ScoreRange({ label, min, max, onChange }: { label: string; min: number | null; max: number | null; onChange: (lo: number | null, hi: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const lo = min ?? 0, hi = max ?? 100;
  const active = min != null || max != null;
  // 0 / 100 are "unbounded" (identical filter result), so they normalize back to null.
  const setLo = (v: number) => onChange(v <= 0 ? null : Math.min(v, hi), max);
  const setHi = (v: number) => onChange(min, v >= 100 ? null : Math.max(v, lo));
  const summary = active ? `${lo}–${hi}` : "any";
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded-md border bg-[var(--surface)] px-3 py-1.5 text-sm" style={{ borderColor: active ? "var(--gold)" : "var(--border)" }}>
        {label}: {summary} ▾
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-md border bg-[var(--surface)] p-3 text-sm shadow-lg" style={{ borderColor: "var(--border)" }}>
          <div className="mb-1 flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Min</span>
            <input type="number" min={0} max={100} value={lo} onChange={(e) => setLo(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-16 rounded border bg-transparent px-1 py-0.5 text-right" style={{ borderColor: "var(--border)" }} />
          </div>
          <input type="range" min={0} max={100} step={1} value={lo} onChange={(e) => setLo(Number(e.target.value))} className="w-full accent-[var(--gold)]" />
          <div className="mb-1 mt-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Max</span>
            <input type="number" min={0} max={100} value={hi} onChange={(e) => setHi(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-16 rounded border bg-transparent px-1 py-0.5 text-right" style={{ borderColor: "var(--border)" }} />
          </div>
          <input type="range" min={0} max={100} step={1} value={hi} onChange={(e) => setHi(Number(e.target.value))} className="w-full accent-[var(--gold)]" />
          <div className="mt-2 flex flex-wrap gap-1">
            {[40, 20, 10, 5].map((p) => (
              <button key={p} onClick={() => onChange(p, null)} className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: min === p && max == null ? "var(--gold)" : "var(--border)", color: "var(--gold)" }}>{p}+</button>
            ))}
            <button onClick={() => { onChange(null, null); setOpen(false); }} className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>Any</button>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-[var(--text-muted)]">Only leads with a score in this range are shown (ungraded leads drop out while a range is set).</p>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: CompanyStatus }) {
  const label = status.replaceAll("_", " ");
  return <span className="rounded-full border px-2 py-0.5 text-[10px] capitalize text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{label}</span>;
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

function QuickViewTriggerList({
  triggers,
  labels,
  sinceLabel,
}: {
  triggers: Array<{ type: string; summary: string; source_name?: string | null; source_url: string | null; signal_date: string | null; detected_at: string }>;
  labels: Record<string, string>;
  sinceLabel: (iso: string | null | undefined) => string;
}) {
  const groups = Array.from(triggers.reduce((map, trigger) => {
    const group = map.get(trigger.type) ?? [];
    group.push(trigger);
    map.set(trigger.type, group);
    return map;
  }, new Map<string, typeof triggers>()).entries()).map(([type, group]) => [type, [...group].sort((a, b) => new Date(b.signal_date ?? b.detected_at).getTime() - new Date(a.signal_date ?? a.detected_at).getTime())] as const)
    .sort((a, b) => new Date(b[1][0].signal_date ?? b[1][0].detected_at).getTime() - new Date(a[1][0].signal_date ?? a[1][0].detected_at).getTime());
  return (
    <div className="space-y-1">
      {groups.map(([type, group]) => (
        <div key={type} className="space-y-1">
          {group.slice(0, 3).map((trigger, index) => (
            <div key={`${trigger.type}-${trigger.source_url ?? index}-${trigger.signal_date ?? trigger.detected_at}`}>
              <div className="text-xs font-semibold" style={{ color: "var(--gold)" }}>{trigger.source_name === "LinkedIn" ? "🔗 LinkedIn trigger event" : labels[trigger.type] ?? trigger.type.replace(/_/g, " ")} · {sinceLabel(trigger.signal_date ?? trigger.detected_at)}</div>
              <div className="text-xs text-[var(--text-muted)]">{trigger.summary}</div>
              {trigger.source_url ? <a href={trigger.source_url} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--accent)] hover:underline" onClick={(e) => e.stopPropagation()}>View source ↗</a> : null}
            </div>
          ))}
          {group.length > 3 && <div className="text-[11px] font-medium text-[var(--accent)]">+{group.length - 3} more {labels[type] ?? type.replace(/_/g, " ")} signal{group.length - 3 === 1 ? "" : "s"} in expanded lead</div>}
        </div>
      ))}
    </div>
  );
}

/** Old Gold revival classes — shared by the table rows and the drawer. */
const OLDGOLD_CLASS: Record<string, { label: string; color: string }> = {
  timing_arrived: { label: "🔥 Timing arrived", color: "var(--tier-a)" },
  contract_clock: { label: "⏳ Contract clock", color: "var(--gold)" },
  stalled_warm: { label: "💤 Stalled warm", color: "#6ea8e6" },
  lost_to_competitor: { label: "🧊 Lost to competitor", color: "#94a3b8" },
  dead: { label: "⛔ Dead", color: "#ef4444" },
  insufficient: { label: "❔ Thin note", color: "var(--text-muted)" },
};

/** A trigger event as the detail API returns it (decayed `live` score precomputed). */
type DrawerTrigger = {
  id: string; type: string; strength: number; half_life_days: number; summary: string;
  source_name: string | null; source_url: string | null; signal_date: string | null; detected_at: string; live: number;
};

type PublicGrowthDetail = {
  entities: Array<Record<string, unknown>>;
  contractMetrics: Record<string, unknown> | null;
  contractRevenueByYear: Array<{ year: number; obligated: number; deobligated: number; transactions: number }>;
  awards: Array<Record<string, unknown>>;
  naicsSize: Array<Record<string, unknown>>;
  headcount: Array<Record<string, unknown>>;
  revenue: Array<Record<string, unknown>>;
  opportunities: Array<Record<string, unknown>>;
};

/** Small labeled chip used in the drawer for flags, tags, and sources. */
function Pill({ children, title, color }: { children: React.ReactNode; title?: string; color?: string }) {
  return (
    <span
      title={title}
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: "var(--surface-2)", color: color ?? "var(--text)", border: "1px solid var(--border)" }}
    >
      {children}
    </span>
  );
}

function CappedList<T>({ items, renderItem }: { items: T[]; renderItem: (item: T, index: number) => React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 3);
  return (
    <>
      {visible.map(renderItem)}
      {items.length > 3 && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-xs font-medium text-[var(--accent)] hover:underline">
          {expanded ? "Show less" : `See more (${items.length - 3})`}
        </button>
      )}
    </>
  );
}

const SIGNAL_CATEGORY_ORDER = ["Federal contracts", "Employee growth", "Revenue & company size", "Financing", "Hiring", "Expansion", "Technology", "News & press", "Other"];

function signalCategory(type: string): string {
  if (type === "2026_inc_5000") return "Revenue & company size";
  if (/^(federal_|sam_award|sam_incumbent|gov_contract)/.test(type)) return "Federal contracts";
  if (/^(employee_|headcount_|hiring_velocity)/.test(type)) return "Employee growth";
  if (/^(revenue_|sba_other_than_small|sba_size_changed)/.test(type)) return "Revenue & company size";
  if (/^(funding|sba_loan|ucc_financing)/.test(type)) return "Financing";
  if (type === "finance_hire") return "Hiring";
  if (/^(ma|new_entity|press|fleet_expansion)/.test(type)) return "Expansion";
  if (type === "erp_tech") return "Technology";
  if (type === "news") return "News & press";
  return "Other";
}

function DetailDrawer({
  company,
  onClose,
  onSaveNote,
  onRate,
  onStar,
  onStatus,
}: {
  company: Company;
  onClose: () => void;
  onSaveNote: (id: string, notes: string) => void;
  onRate: (id: string, rating: number | null, comment: string | null) => void;
  onStar: (id: string, value: boolean) => void;
  onStatus: (id: string, status: "new" | "reviewed" | "dismissed") => void;
}) {
  const [note, setNote] = useState(company.notes ?? "");
  const [ratingComment, setRatingComment] = useState(company.rating_comment ?? "");
  // Pull the FULL record (every signal + every trigger across the DB) on open — the row
  // object from Triggered/TAM-Base tabs is a light projection with no signals/triggers.
  const [detail, setDetail] = useState<{ company: Company; triggers: DrawerTrigger[]; insights?: InsightBadge[]; publicGrowth?: PublicGrowthDetail } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true); setDetail(null);
    fetch("/api/headhunter/lead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: company.id }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.company) { setDetail(d); setNote(d.company.notes ?? ""); setRatingComment(d.company.rating_comment ?? ""); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [company.id]);

  const c = detail?.company ?? company; // merged: full record once loaded, row projection meanwhile
  const triggers = detail?.triggers ?? [];
  const insights = detail?.insights ?? [];
  const publicGrowth = detail?.publicGrowth;
  const fmt = (iso: string | null | undefined) => (iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
  const dollars = (value: unknown) => Number(value ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const obligatedDollars = (value: unknown) => dollars(Math.max(0, Number(value ?? 0)));
  const dateValue = (value: unknown) => value ? new Date(String(value)).getTime() || 0 : 0;
  const rankedAwards = [...(publicGrowth?.awards ?? [])].sort((a, b) => Math.max(Number(b.award_ceiling ?? 0), Number(b.total_obligations ?? 0), Number(b.current_award_amount ?? 0)) - Math.max(Number(a.award_ceiling ?? 0), Number(a.total_obligations ?? 0), Number(a.current_award_amount ?? 0)) || dateValue(b.start_date) - dateValue(a.start_date));
  const recentNaics = [...(publicGrowth?.naicsSize ?? [])].sort((a, b) => dateValue(b.observed_on) - dateValue(a.observed_on));
  const recentHeadcount = [...(publicGrowth?.headcount ?? [])].sort((a, b) => dateValue(b.plan_year_end ?? `${b.form_year}-12-31`) - dateValue(a.plan_year_end ?? `${a.form_year}-12-31`));
  const recentRevenue = [...(publicGrowth?.revenue ?? [])].sort((a, b) => dateValue(b.observed_on) - dateValue(a.observed_on));
  const recentOpportunities = [...(publicGrowth?.opportunities ?? [])].sort((a, b) => dateValue((b.sam_opportunities as Record<string, unknown> | undefined)?.posted_date) - dateValue((a.sam_opportunities as Record<string, unknown> | undefined)?.posted_date));
  // Federal awards are listed in their own panel below (hundreds of rows on an
  // award-heavy contractor would bury every other signal here). They are still
  // COUNTED and pointed at, so "triggers (2)" can't imply a lead is quiet when it
  // actually has 300 federal awards on file.
  const visibleTriggers = triggers.filter((trigger) => trigger.type !== "federal_award");
  const federalAwardCount = triggers.length - visibleTriggers.length;
  const triggerGroups = Object.entries([...visibleTriggers]
    .sort((a, b) => dateValue(b.signal_date ?? b.detected_at) - dateValue(a.signal_date ?? a.detected_at))
    .reduce<Record<string, DrawerTrigger[]>>((groups, trigger) => { (groups[signalCategory(trigger.type)] ??= []).push(trigger); return groups; }, {}))
    .sort((a, b) => SIGNAL_CATEGORY_ORDER.indexOf(a[0]) - SIGNAL_CATEGORY_ORDER.indexOf(b[0]));
  const signalGroups = Object.entries([...c.signals]
    .sort((a, b) => dateValue(b.signal_date) - dateValue(a.signal_date))
    .reduce<Record<string, typeof c.signals>>((groups, signal) => { (groups[signalCategory(signal.type)] ??= []).push(signal); return groups; }, {}))
    .sort((a, b) => SIGNAL_CATEGORY_ORDER.indexOf(a[0]) - SIGNAL_CATEGORY_ORDER.indexOf(b[0]));

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-[460px] overflow-y-auto border-l bg-[var(--surface)] p-5" style={{ borderColor: "var(--border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{c.name}</h2>
              {c.tal_claimed && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide" style={{ background: "rgba(220,38,38,0.18)", color: "#ef4444", border: "1px solid rgba(220,38,38,0.55)" }} title="On your ARS Target Account List">ARS TAL Claimed</span>}
              {!c.tal_claimed && c.tal_dq && <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide" style={{ background: "rgba(148,163,184,0.16)", color: "#94a3b8", border: "1px solid rgba(148,163,184,0.45)" }} title="Was on a previous TAL, dropped from the latest — previously disqualified">Previously DQ&apos;d</span>}
            </div>
            {(c.domain || c.website_raw) && <a href={c.website_raw ?? `https://${c.domain}`} target="_blank" rel="noreferrer" className="text-sm text-[var(--accent)] hover:underline">{bareDomain(c.domain || c.website_raw || "")}</a>}
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)]">✕</button>
        </div>

        {publicGrowth && (publicGrowth.entities.length > 0 || publicGrowth.awards.length > 0 || publicGrowth.naicsSize.length > 0 || publicGrowth.headcount.length > 0 || publicGrowth.revenue.length > 0 || publicGrowth.opportunities.length > 0) && (
          <div className="mb-4 rounded-md border p-3 text-sm" style={{ borderColor: "rgba(110,168,230,0.45)", background: "rgba(110,168,230,0.05)" }}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "#6ea8e6" }}>Public growth intelligence</h3>
            <CappedList items={publicGrowth.entities} renderItem={(entity, i) => (
              <div key={`entity-${i}`} className="mb-2 text-xs">
                <span className="font-semibold">{String(entity.legal_name ?? c.name)}</span>
                {entity.uei ? <span className="text-[var(--text-muted)]"> · UEI {String(entity.uei)}</span> : null}
                {entity.cage_code ? <span className="text-[var(--text-muted)]"> · CAGE {String(entity.cage_code)}</span> : null}
                {entity.registration_status ? <span className="text-[var(--text-muted)]"> · SAM {String(entity.registration_status)}</span> : null}
                {entity.expiration_date ? <span className="text-[var(--text-muted)]"> through {fmt(String(entity.expiration_date))}</span> : null}
              </div>
            )} />
            {publicGrowth.contractMetrics && (
              <div className="mb-3 grid grid-cols-2 gap-2 rounded border p-2 text-xs" style={{ borderColor: "var(--border)" }}>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">30d obligated</div><strong>{obligatedDollars(publicGrowth.contractMetrics.obligations_30d)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">90d obligated</div><strong>{obligatedDollars(publicGrowth.contractMetrics.obligations_90d)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">12m obligated</div><strong>{obligatedDollars(publicGrowth.contractMetrics.obligations_365d)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">Prior 12m</div><strong>{obligatedDollars(publicGrowth.contractMetrics.prior_obligations_365d)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">Active ceiling</div><strong>{obligatedDollars(publicGrowth.contractMetrics.active_award_ceiling)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">Active obligated</div><strong>{obligatedDollars(publicGrowth.contractMetrics.active_award_obligations)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">Subawards received · 12m</div><strong>{dollars(publicGrowth.contractMetrics.received_subaward_dollars_365d)}</strong></div>
                <div><div className="text-[10px] uppercase text-[var(--text-muted)]">Subawards issued · 12m</div><strong>{dollars(publicGrowth.contractMetrics.prime_subaward_dollars_365d)}</strong></div>
              </div>
            )}
            {publicGrowth.naicsSize.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--text-muted)]">SBA size by NAICS</div>
                <CappedList items={recentNaics} renderItem={(n, i) => (
                  <div key={`naics-${i}`} className="flex justify-between gap-2 border-t py-1 text-xs" style={{ borderColor: "var(--border)" }}>
                    <span>{String(n.naics_code)}{n.naics_name ? ` · ${String(n.naics_name)}` : ""}{n.is_primary ? " · primary" : ""}</span>
                    <strong>{n.status === "other_than_small" ? "Other than small" : n.status === "small" ? "Small" : "Unknown"}{n.observed_on ? ` · ${String(n.observed_on)}` : ""}</strong>
                  </div>
                )} />
              </div>
            )}
            {publicGrowth.awards.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--text-muted)]">Federal contract revenue by year</div>
                <CappedList items={publicGrowth.contractRevenueByYear ?? []} renderItem={(year) => (
                  <div key={`contract-year-${year.year}`} className="flex items-center justify-between border-t py-1 text-xs" style={{ borderColor: "var(--border)" }}>
                    <span>{year.year}</span><strong>{obligatedDollars(year.obligated)} obligated revenue</strong>
                  </div>
                )} />
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] font-semibold uppercase text-[var(--text-muted)]">Award details ({publicGrowth.awards.length})</summary>
                  <div className="mt-1 space-y-2">
                  <CappedList items={rankedAwards} renderItem={(a, i) => (
                    <div key={`award-${i}`} className="rounded border p-2 text-xs" style={{ borderColor: "var(--border)" }}>
                      <div className="font-semibold">{obligatedDollars(a.award_ceiling)} ceiling · {obligatedDollars(a.total_obligations)} obligated</div>
                      <div className="text-[var(--text-muted)]">{String(a.awarding_agency ?? "Federal award")}{a.award_id ? ` · ${String(a.award_id)}` : ""}{a.start_date ? ` · ${fmt(String(a.start_date))}` : ""}</div>
                      {a.description ? <p className="mt-1 text-[var(--text-muted)]">{String(a.description)}</p> : null}
                      {a.source_url ? <a href={String(a.source_url)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[var(--accent)] hover:underline">USAspending ↗</a> : null}
                    </div>
                  )} />
                  </div>
                </details>
              </div>
            )}
            {publicGrowth.headcount.length > 0 && (
              <details className="mb-2" open>
                <summary className="cursor-pointer text-[10px] font-semibold uppercase text-[var(--text-muted)]">Form 5500 history ({publicGrowth.headcount.length})</summary>
                <CappedList items={recentHeadcount} renderItem={(h, i) => <div key={`hc-${i}`} className="border-t py-1 text-xs" style={{ borderColor: "var(--border)" }}>{String(h.plan_year_begin ?? h.form_year)} → {String(h.plan_year_end ?? h.form_year)} · {Number(h.active_participants_boy ?? 0).toLocaleString()} → {Number(h.active_participants_eoy ?? 0).toLocaleString()} active participants · {String(h.plan_name ?? h.form_type)}</div>} />
              </details>
            )}
            {publicGrowth.revenue.length > 0 && (
              <details className="mt-2" open>
                <summary className="cursor-pointer text-[10px] font-semibold uppercase text-[var(--text-muted)]">Revenue observations ({publicGrowth.revenue.length})</summary>
                <CappedList items={recentRevenue} renderItem={(r, i) => <div key={`rev-${i}`} className="border-t py-1 text-xs" style={{ borderColor: "var(--border)" }}>{String(r.observed_on)} · {dollars(r.estimated_revenue)} estimated · {String(r.revenue_band ?? r.source)}</div>} />
              </details>
            )}
            {publicGrowth.opportunities.length > 0 && (
              <details open>
                <summary className="cursor-pointer text-[10px] font-semibold uppercase text-[var(--text-muted)]">SAM opportunities ({publicGrowth.opportunities.length})</summary>
                <CappedList items={recentOpportunities} renderItem={(m, i) => {
                  const opportunity = (m.sam_opportunities ?? {}) as Record<string, unknown>;
                  return <div key={`opp-${i}`} className="border-t py-1 text-xs" style={{ borderColor: "var(--border)" }}><strong>{String(m.relationship)}</strong> · {String(opportunity.title ?? "SAM opportunity")}{opportunity.posted_date ? ` · posted ${String(opportunity.posted_date)}` : ""}{opportunity.response_deadline ? ` · due ${String(opportunity.response_deadline).slice(0, 10)}` : ""}{opportunity.source_url ? <a href={String(opportunity.source_url)} target="_blank" rel="noreferrer" className="ml-1 text-[var(--accent)] hover:underline">SAM ↗</a> : null}</div>;
                }} />
              </details>
            )}
          </div>
        )}
        {/* Quick actions — act on the lead without closing the drawer + hunting the row. */}
        <div className="mb-3 flex items-center gap-2">
          <button onClick={() => onStar(c.id, !c.starred)} className="rounded-md border px-2.5 py-1 text-xs" style={{ borderColor: "var(--border)", color: c.starred ? "var(--tier-b)" : "var(--text-muted)" }}>
            {c.starred ? "★ Starred" : "☆ Star"}
          </button>
          <button onClick={() => onStatus(c.id, "reviewed")} className="rounded-md border px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" style={{ borderColor: "var(--border)" }} title="Hide from the worklist (bring back with Show hidden)">
            ✓ Mark reviewed
          </button>
          <button onClick={() => onStatus(c.id, "dismissed")} className="rounded-md border px-2.5 py-1 text-xs" style={{ borderColor: "rgba(220,38,38,0.45)", color: "#ef4444" }} title="Dismiss — not a fit; hides it everywhere">
            ✕ Dismiss
          </button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <ScoreBadge score={c.signal_score} />
          <TierBadge tier={c.score_tier} />
          {c.claimable && <Pill title="Claimable in NetSuite (in your TAM)" color="var(--tier-a)">Claimable</Pill>}
          {c.erp_ready && <Pill title="ERP-readiness signal present">⚡ ERP-ready</Pill>}
          {c.erp_incumbent && <Pill title="Detected accounting/ERP incumbent">{c.erp_incumbent === "quickbooks" ? "QuickBooks" : c.erp_incumbent === "erp" ? "On an ERP" : c.erp_incumbent}</Pill>}
          {c.pe_owned && <Pill title="Private-equity owned">PE-owned</Pill>}
          {(c.headcount_growth_pct ?? 0) >= 25 && <Pill title="DOL Form 5500 within-year participant (headcount) growth" color="var(--tier-a)">📈 +{Math.round(c.headcount_growth_pct as number)}% headcount</Pill>}
          {triggers.some((t) => t.type === "finance_hire") && <Pill title="Hiring for a finance role (own careers page or announced) — scaling finance in-house" color="#6ea8e6">🧮 hiring for finance</Pill>}
          {c.has_parent && <Pill title={`Detected subsidiary${c.parent_name ? ` of ${c.parent_name}` : ""} (${c.parent_confidence ?? "?"} confidence)`} color="#b48c28">🏢 {c.parent_confidence === "high" ? "subsidiary" : "likely sub"}{c.parent_name ? ` of ${c.parent_name}` : ""}</Pill>}
          {c.netsuite_internal_id && <Pill title="NetSuite internal ID">NS #{c.netsuite_internal_id}</Pill>}
          {c.record_dead && <Pill title={c.record_dead_reason ?? "NetSuite record marks this lead dead"} color="#ef4444">⛔ DEAD{c.record_dead_reason ? ` — ${c.record_dead_reason.slice(0, 50)}` : ""}</Pill>}
          {!c.record_dead && c.tam_score != null && <Pill title={c.tam_provisional ? "Provisional TAM grade (formula floor — deep read pending)" : "TAM grade — holistic 0-100 from the full lead record (activities + notes + qual note)"} color={c.tam_provisional ? "var(--text-muted)" : "#6ea8e6"}>📊 TAM {Math.round(c.tam_score)}{c.tam_provisional ? "±" : ""}</Pill>}
          {!c.record_dead && c.oldgold_score != null && <Pill title="Old Gold revival score — this lead has a qual note + SQL date (a past sales-qualified moment worth reviving)" color="var(--gold)">🪙 Old Gold {Math.round(c.oldgold_score)}</Pill>}
        </div>

        {/* OLD GOLD / RECORD HISTORY — ubiquitous: the qual-note + NetSuite-record
            intelligence shows on every lead, whatever tab opened it. */}
        {(c.qual_note || c.oldgold_class || c.record_digest || c.last_sql_date) && (
          <div className="mb-4 rounded-md border p-3 text-sm" style={{ borderColor: "rgba(201,162,74,0.45)", background: "rgba(201,162,74,0.06)" }}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--gold)" }}>🪙 Old Gold — NetSuite history</span>
              {c.last_sql_date && <span className="text-[10px] text-[var(--text-muted)]" title="Last time their team met with NetSuite (BDR SQL date)">last SQL: {c.last_sql_date}</span>}
            </div>
            {c.oldgold_class && (
              <div className="mb-1 text-xs font-semibold" style={{ color: OLDGOLD_CLASS[c.oldgold_class]?.color ?? "var(--gold)" }}>
                {OLDGOLD_CLASS[c.oldgold_class]?.label ?? c.oldgold_class}{c.oldgold_score != null ? ` · ${Math.round(c.oldgold_score)}/100` : ""}
              </div>
            )}
            {(c.oldgold_reasons ?? []).map((r, i) => (
              <div key={i} className="text-xs text-[var(--text-muted)]">• {r}{r.startsWith("⚠") ? "" : ""}</div>
            ))}
            {c.revisit_on && <div className="mt-1 text-xs font-medium" style={{ color: "var(--tier-a)" }}>⏰ Their stated timing arrives: {c.revisit_on}</div>}
            {c.record_digest && (
              <p className="mt-2 border-t pt-2 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{c.record_digest}</p>
            )}
            {c.qual_note && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Raw qualification note</summary>
                <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--text-muted)]">{c.qual_note}</p>
              </details>
            )}
            {(c.oldgold_reasons ?? []).some((r) => r.startsWith("⚠")) && (
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">⚠ = evidence without a verifiable timestamp — treat the timing as unconfirmed.</p>
            )}
          </div>
        )}

        {/* Lead quality rating — feeds the learning loop. */}
        <div className="mb-4 rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Rate lead quality</span>
            {c.rating != null && (
              <button onClick={() => onRate(c.id, null, ratingComment || null)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">clear</button>
            )}
          </div>
          <div className="flex items-center gap-1 text-2xl leading-none">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => onRate(c.id, n, ratingComment || null)}
                className="transition-transform hover:scale-110"
                style={{ color: c.rating != null && n <= c.rating ? "var(--gold)" : "var(--border)" }}
                title={`${n} star${n > 1 ? "s" : ""}`}
              >
                ★
              </button>
            ))}
          </div>
          <textarea
            value={ratingComment}
            onChange={(e) => setRatingComment(e.target.value)}
            onBlur={() => { if (c.rating != null) onRate(c.id, c.rating, ratingComment || null); }}
            placeholder="Why? (optional — helps the bot learn what's working)"
            className="mt-2 h-14 w-full rounded-md border bg-[var(--surface)] p-2 text-xs outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </div>
        {c.description && <p className="mb-1 text-sm text-[var(--text-muted)]">{c.description}</p>}
        <p className="mb-4 text-xs text-[var(--text-muted)]">{[c.subindustry, [c.city, c.state].filter(Boolean).join(", "), c.employee_band || (c.employee_count ? `${c.employee_count} emp` : null), c.revenue_band].filter(Boolean).join(" · ")}</p>
        {c.score_reason && <p className="mb-4 rounded-md bg-[var(--surface-2)] p-3 text-xs">{c.score_reason}</p>}

        {/* WHY IT'S HERE — grouped by signal type, newest first, three visible per type. */}
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Why it&apos;s here — triggers ({visibleTriggers.length})</h3>
        {triggers.length === 0 && <p className="mb-3 text-xs text-[var(--text-muted)]">{loading ? "Loading…" : "No trigger events recorded for this lead."}</p>}
        <div className="space-y-3">
          {triggerGroups.map(([category, rows]) => (
            <div key={category}>
              <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--text-muted)]">{category} ({rows.length})</div>
              <div className="space-y-2">
                <CappedList items={rows} renderItem={(t) => (
                  <div key={t.id} className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-medium capitalize">{t.source_name === "LinkedIn" ? "🔗 LinkedIn trigger event" : t.type.replace(/_/g, " ")}</span>
                      <span className="whitespace-nowrap text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{fmt(t.signal_date || t.detected_at)}{t.live < t.strength * 0.5 ? " · fading" : ""}</span>
                    </div>
                    <p className="text-[var(--text-muted)]">{t.summary}</p>
                    {t.source_url && <a href={t.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline">{t.source_name || "source"} ↗</a>}
                  </div>
                )} />
              </div>
            </div>
          ))}
          {federalAwardCount > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              + {federalAwardCount} federal award signal{federalAwardCount === 1 ? "" : "s"} — itemised with sources under <strong>Federal activity</strong> below.
            </p>
          )}
        </div>

        {/* LinkedIn NetSuite-fit / ops-profile findings — tag-only, but must still say
            WHY they're here and link back to source (Arman 2026-07-31: the lead-record
            popup was showing generic company description with no "why" framing). */}
        {insights.length > 0 && (
          <>
            <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">LinkedIn findings ({insights.length})</h3>
            <div className="space-y-2">
              {insights.map((ins, i) => (
                <div key={i} className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="mb-1 font-medium" style={{ color: "var(--accent)" }}>
                    🔗 LinkedIn {ins.kind === "netsuite_fit" ? "NetSuite fit" : "ops profile"} — {ins.label}
                    {ins.confidence === "low" ? " (low confidence)" : ""}
                  </div>
                  {ins.detail && <p className="text-[var(--text-muted)]">{ins.detail}</p>}
                  <p className="mt-1 border-l-2 pl-2 text-xs italic text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>&quot;{ins.evidence}&quot;</p>
                  {ins.evidence_url && <a href={ins.evidence_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline">View source ↗</a>}
                </div>
              ))}
            </div>
          </>
        )}

        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Signals ({c.signals.length})</h3>
        {c.signals.length === 0 && <p className="mb-3 text-xs text-[var(--text-muted)]">{loading ? "Loading…" : "No discovery signals on this lead."}</p>}
        <div className="space-y-3">
          {signalGroups.map(([category, rows]) => (
            <div key={category}>
              <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--text-muted)]">{category} ({rows.length})</div>
              <div className="space-y-2">
                <CappedList items={rows} renderItem={(s) => (
                  <div key={s.id} className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                    <div className="mb-1 flex items-center justify-between"><span className="font-medium capitalize">{s.type.replace(/_/g, " ")}</span><span className="text-xs text-[var(--text-muted)]">{s.strength} · +{s.weight}{s.subindustry_relevant ? " · vertical" : ""}</span></div>
                    {s.signal_date && <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{fmt(s.signal_date)}</p>}
                    {s.signal_summary && <p className="text-[var(--text-muted)]">{s.signal_summary}</p>}
                    {s.raw_excerpt && <p className="mt-1 border-l-2 pl-2 text-xs italic text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>&quot;{s.raw_excerpt}&quot;</p>}
                    {s.source_url && <a href={s.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline">{s.source_name || "source"} ↗</a>}
                  </div>
                )} />
              </div>
            </div>
          ))}
        </div>

        {/* Tags / lists this lead belongs to + the actors/sources that found it. */}
        {((c.lists?.length ?? 0) > 0 || (c.technologies?.length ?? 0) > 0 || (c.sources?.length ?? 0) > 0) && (
          <>
            <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags &amp; lists</h3>
            <div className="flex flex-wrap gap-1.5">
              {(c.lists ?? []).map((t) => <Pill key={`l-${t}`} title="TAM list / silo membership" color="var(--tier-a)">{t}</Pill>)}
              {(c.technologies ?? []).map((t) => <Pill key={`t-${t}`} title="Detected technology">{t}</Pill>)}
              {(c.sources ?? []).map((t) => <Pill key={`s-${t}`} title="Source / actor that surfaced this lead" color="var(--text-muted)">{t}</Pill>)}
            </div>
          </>
        )}

        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Notes</h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => onSaveNote(c.id, note)}
          placeholder="Add a note (saved on blur)…"
          className="h-20 w-full rounded-md border bg-[var(--surface-2)] p-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
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
