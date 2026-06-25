/**
 * Minimal, dependency-free CSV parsing for the import flow (runs client-side).
 * Handles quoted fields, escaped quotes, and CRLF. Tolerant of column naming.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ImportRow {
  name: string;
  website: string;
}

/** Map parsed rows to {name, website}, detecting columns tolerantly. */
export function rowsToImportRows(rows: string[][]): ImportRow[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());

  const nameIdx =
    header.findIndex((h) => h === "name" || h === "company" || h === "company name" || h === "organization name") ;
  const nameFallback = header.findIndex((h) => h.includes("company") || h.includes("name"));
  const ni = nameIdx >= 0 ? nameIdx : nameFallback;

  const webIdx = header.findIndex(
    (h) => h.includes("website") || h.includes("url") || h.includes("domain") || h.includes("web"),
  );

  const out: ImportRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const name = (ni >= 0 ? cells[ni] : cells[0] ?? "").trim();
    const website = (webIdx >= 0 ? cells[webIdx] ?? "" : "").trim();
    if (name) out.push({ name, website });
  }
  return out;
}
