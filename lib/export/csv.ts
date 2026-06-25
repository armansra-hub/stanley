import { normalizeDomain } from "../domain";

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
