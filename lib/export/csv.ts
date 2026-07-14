import { normalizeDomain } from "../domain";
import { buildClaimingComments } from "./claiming";

/**
 * CSV export — exactly two columns.
 *
 * Header casing differed between the two source briefs ("Company Name" vs
 * "company name"); it's configurable here, defaulting to title case. The URL
 * column is the full website by default, with a toggle to emit the bare
 * normalized domain instead.
 */
export interface CsvCompany {
  name: string;
  website_raw?: string | null;
  domain?: string | null;
}

export interface CsvExportConfig {
  /** "website" = full URL as found (default); "domain" = bare normalized domain. */
  urlMode?: "website" | "domain";
  /** Column headers. Default ["Company Name", "Company URL"]. */
  headers?: [string, string];
}

function csvCell(value: string): string {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Full export — every column we hold on a lead (for spreadsheet analysis). */
export function buildFullCsvExport(companies: any[]): string {
  const cols: [string, (c: any) => string][] = [
    ["Company Name", (c) => c.name ?? ""],
    ["Domain", (c) => c.domain ?? normalizeDomain(c.website_raw)],
    ["Website", (c) => c.website_raw ?? ""],
    ["NetSuite Internal ID", (c) => c.netsuite_internal_id ?? ""],
    ["Claimable", (c) => (c.claimable ? "Yes" : "No")],
    ["Lists", (c) => (c.lists ?? []).join("; ")],
    ["Lead Vendor", (c) => c.lead_vendor ?? ""],
    ["Fit Weight", (c) => (c.fit_weight != null ? String(c.fit_weight) : "")],
    ["Priority", (c) => (c.priority != null ? String(c.priority) : "")],
    ["Top Trigger", (c) => (c.top_trigger ? `${c.top_trigger.type}: ${c.top_trigger.summary}` : "")],
    ["Industry", (c) => c.subindustry ?? ""],
    ["State", (c) => c.state ?? ""],
    ["City", (c) => c.city ?? ""],
    ["Employees", (c) => (c.employee_count != null ? String(c.employee_count) : c.employee_band ?? "")],
    ["Revenue", (c) => c.revenue_band ?? ""],
    ["Technologies", (c) => (c.technologies ?? []).join("; ")],
    ["ERP Ready", (c) => (c.erp_ready ? "Yes" : "No")],
    ["Status", (c) => c.status ?? ""],
    ["Rating", (c) => (c.rating != null ? String(c.rating) : "")],
    ["TAM Score", (c) => (c.tam_score != null ? String(c.tam_score) : "")],
    ["TAM Provisional", (c) => (c.tam_provisional ? "Yes" : "")],
    ["Old Gold Score", (c) => (c.oldgold_score != null ? String(c.oldgold_score) : "")],
    ["Grade Class", (c) => c.oldgold_class ?? ""],
    ["Record Digest", (c) => c.record_digest ?? ""],
    ["Dead", (c) => (c.record_dead ? "Yes" : "")],
    ["Dead Reason", (c) => c.record_dead_reason ?? ""],
    ["Last SQL Date", (c) => c.last_sql_date ?? ""],
    ["First Seen", (c) => (c.first_seen_at ?? "").slice(0, 10)],
    // LAST column by contract: the codex claiming agent pastes this cell verbatim
    // into NetSuite's claiming comments. 1-4 terse bullets, one per reason.
    ["Claiming Comments", (c) => buildClaimingComments(c)],
  ];
  const rows: string[] = [cols.map((x) => csvCell(x[0])).join(",")];
  for (const c of companies) rows.push(cols.map((x) => csvCell(x[1](c))).join(","));
  return rows.join("\r\n");
}

export function buildCsvExport(companies: CsvCompany[], cfg: CsvExportConfig = {}): string {
  const urlMode = cfg.urlMode ?? "website";
  const headers = cfg.headers ?? ["Company Name", "Company URL"];

  const rows: string[] = [csvCell(headers[0]) + "," + csvCell(headers[1])];
  for (const c of companies) {
    const url =
      urlMode === "domain"
        ? c.domain ?? normalizeDomain(c.website_raw)
        : c.website_raw ?? c.domain ?? "";
    rows.push(csvCell(c.name ?? "") + "," + csvCell(url ?? ""));
  }
  return rows.join("\r\n");
}
