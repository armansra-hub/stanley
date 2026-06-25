import { uniqueNormalizedDomains } from "../domain";

/**
 * NetSuite saved-search SQL export.
 *
 * Emits Formula (Numeric) criteria that match a company on EITHER its website
 * OR its name — so a record is found even when one field is blank or differs in
 * NetSuite. Two formula families:
 *   • URL match  — normalized {url} (web address) tested against a domain list.
 *   • Name match — normalized {companyname} tested against a name list.
 * Each family is chunked to stay under NetSuite's per-formula character limit;
 * the final criterion is an OR across every chunk.
 */
export interface SqlExportConfig {
  /** Max entries per formula chunk. Default 40. */
  chunkSize?: number;
  /** NetSuite Web Address field token. Default "{url}". */
  urlField?: string;
  /** NetSuite Company Name field token. Default "{companyname}". */
  nameField?: string;
  /** Base-criteria Stage value. Default "Lead". */
  stage?: string;
  /** Base-criteria Sales Rep value. Default "Nurturing Marketing". */
  salesRep?: string;
}

export interface SqlChunk {
  index: number;
  kind: "url" | "name";
  values: string[];
  formula: string;
}

export interface SqlExportResult {
  domains: string[];
  names: string[];
  chunks: SqlChunk[];
  text: string;
}

export interface ExportCompany {
  name?: string | null;
  website?: string | null;
}

/** Normalize a company name to a comparison token: lowercase, strip punctuation,
 * drop a trailing legal suffix, remove spaces. Must mirror the SQL chain below. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase().trim();
  s = s.replace(/[^a-z0-9 ]/g, "");
  s = s.replace(/ +(inc|llc|llp|lp|corp|corporation|co|company|ltd|limited|group|holdings|incorporated)$/g, "");
  s = s.replace(/ /g, "");
  return s;
}

export function uniqueNormalizedNames(companies: Iterable<ExportCompany>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of companies) {
    const n = normalizeName(c.name);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** URL chunk: normalize {url} (strip scheme/www/path) and test list membership. */
function buildUrlFormula(domains: string[], urlField: string): string {
  const list = "|" + domains.join("|") + "|";
  return (
    `CASE WHEN INSTR('${list}', '|' || ` +
    `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(NVL(${urlField}, ''))), ` +
    `'^https?://', ''), '^www\\.', ''), '[/?#].*$', '') || '|') > 0 THEN 1 ELSE 0 END`
  );
}

/** Name chunk: normalize {companyname} the same way as normalizeName() and test. */
function buildNameFormula(names: string[], nameField: string): string {
  const list = "|" + names.join("|") + "|";
  return (
    `CASE WHEN INSTR('${list}', '|' || ` +
    `REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(NVL(${nameField}, ''))), ` +
    `'[^a-z0-9 ]', ''), ' +(inc|llc|llp|lp|corp|corporation|co|company|ltd|limited|group|holdings|incorporated)$', ''), ` +
    `' ', '') || '|') > 0 THEN 1 ELSE 0 END`
  );
}

export function buildNetsuiteSqlExport(
  companies: Iterable<ExportCompany>,
  cfg: SqlExportConfig = {},
): SqlExportResult {
  const chunkSize = cfg.chunkSize ?? 40;
  const urlField = cfg.urlField ?? "{url}";
  const nameField = cfg.nameField ?? "{companyname}";
  const stage = cfg.stage ?? "Lead";
  const salesRep = cfg.salesRep ?? "Nurturing Marketing";
  if (chunkSize < 1) throw new Error("chunkSize must be >= 1");

  const list = [...companies];
  const domains = uniqueNormalizedDomains(list.map((c) => c.website));
  const names = uniqueNormalizedNames(list);

  const chunks: SqlChunk[] = [];
  for (let i = 0; i < domains.length; i += chunkSize) {
    const part = domains.slice(i, i + chunkSize);
    chunks.push({ index: chunks.length + 1, kind: "url", values: part, formula: buildUrlFormula(part, urlField) });
  }
  for (let i = 0; i < names.length; i += chunkSize) {
    const part = names.slice(i, i + chunkSize);
    chunks.push({ index: chunks.length + 1, kind: "name", values: part, formula: buildNameFormula(part, nameField) });
  }

  const lines: string[] = [];
  lines.push(
    `NetSuite Saved-Search Export — ${list.length} compan${list.length === 1 ? "y" : "ies"} ` +
      `(${domains.length} by website, ${names.length} by name), ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`,
  );
  lines.push("");
  lines.push("Base criteria:");
  lines.push(`  Stage = ${stage}`);
  lines.push(`  Sales Rep = ${salesRep}`);
  lines.push("");
  lines.push("Then an AND group matching on website OR name: ( " + chunks.map((c) => `chunk${c.index} = 1`).join(" OR ") + " )");
  lines.push("");
  for (const c of chunks) {
    lines.push(`--- Chunk ${c.index} · match by ${c.kind === "url" ? "WEBSITE" : "NAME"} (${c.values.length}) ---`);
    lines.push(c.formula);
    lines.push("");
  }
  lines.push("Grid layout (Use Expressions ON):");
  lines.push('  - Put "(" on the first formula row.');
  lines.push('  - Put "OR" after each chunk except the last.');
  lines.push('  - Put ")" on the far right of the last chunk row.');
  lines.push("  - Leave And/Or after the last chunk blank.");
  lines.push('  - Each formula\'s condition is "is 1" (equal to 1).');

  return { domains, names, chunks, text: lines.join("\n") };
}
