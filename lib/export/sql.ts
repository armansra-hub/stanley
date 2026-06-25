import { uniqueNormalizedDomains } from "../domain";

/**
 * NetSuite saved-search SQL export.
 *
 * Reproduces the exact "Formula (Numeric)" criterion the user already uses:
 * a pipe-delimited domain list tested against the same normalization applied
 * to NetSuite's Web Address field token ({url}). Domains are chunked so each
 * formula stays under NetSuite's per-formula character limit.
 */
export interface SqlExportConfig {
  /** Max normalized domains per formula chunk. Default 40. */
  chunkSize?: number;
  /** NetSuite Web Address field token. Default "{url}". */
  urlField?: string;
  /** Base-criteria Stage value. Default "Lead". */
  stage?: string;
  /** Base-criteria Sales Rep value. Default "Nurturing Marketing". */
  salesRep?: string;
}

export interface SqlChunk {
  /** 1-based chunk number. */
  index: number;
  domains: string[];
  formula: string;
}

export interface SqlExportResult {
  /** Unique normalized domains, in first-seen order, that went into the export. */
  domains: string[];
  chunks: SqlChunk[];
  /** Copy-paste-ready block: numbered formulas + grid-layout instructions. */
  text: string;
}

/** Build one chunk's Formula (Numeric) criterion. */
function buildChunkFormula(domains: string[], urlField: string): string {
  const list = "|" + domains.join("|") + "|";
  return (
    `CASE WHEN INSTR('${list}', '|' || ` +
    `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(NVL(${urlField}, ''))), ` +
    `'^https?://', ''), '^www\\.', ''), '[/?#].*$', '') || '|') > 0 THEN 1 ELSE 0 END`
  );
}

export function buildNetsuiteSqlExport(
  urls: Iterable<string | null | undefined>,
  cfg: SqlExportConfig = {},
): SqlExportResult {
  const chunkSize = cfg.chunkSize ?? 40;
  const urlField = cfg.urlField ?? "{url}";
  const stage = cfg.stage ?? "Lead";
  const salesRep = cfg.salesRep ?? "Nurturing Marketing";

  if (chunkSize < 1) throw new Error("chunkSize must be >= 1");

  const domains = uniqueNormalizedDomains(urls);

  const chunks: SqlChunk[] = [];
  for (let i = 0; i < domains.length; i += chunkSize) {
    const part = domains.slice(i, i + chunkSize);
    chunks.push({
      index: chunks.length + 1,
      domains: part,
      formula: buildChunkFormula(part, urlField),
    });
  }

  const lines: string[] = [];
  lines.push(
    `NetSuite Saved-Search Export — ${domains.length} compan${domains.length === 1 ? "y" : "ies"}, ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`,
  );
  lines.push("");
  lines.push("Base criteria:");
  lines.push(`  Stage = ${stage}`);
  lines.push(`  Sales Rep = ${salesRep}`);
  lines.push("");
  lines.push(
    "Then an AND group: ( " +
      chunks.map((c) => `chunk${c.index} = 1`).join(" OR ") +
      " )",
  );
  lines.push("");
  for (const c of chunks) {
    lines.push(`--- Chunk ${c.index} (${c.domains.length} domain${c.domains.length === 1 ? "" : "s"}) ---`);
    lines.push(c.formula);
    lines.push("");
  }
  lines.push("Grid layout (Use Expressions ON):");
  lines.push('  - Put "(" on the first formula row.');
  lines.push('  - Put "OR" after each chunk except the last.');
  lines.push('  - Put ")" on the far right of the last chunk row.');
  lines.push("  - Leave And/Or after the last chunk blank.");
  lines.push('  - Each formula\'s condition is "is 1" (equal to 1).');

  return { domains, chunks, text: lines.join("\n") };
}
