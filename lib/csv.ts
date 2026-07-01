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

/** A richer row for the TAM Base bulk import (ZoomInfo / LinkedIn / NetSuite). */
export interface BaseRow {
  name: string;
  website: string;
  industry: string;
  state: string;
  city: string;
  employees: string;     // raw headcount string (parsed downstream)
  revenue: string;
  technologies: string;  // raw "QuickBooks; Salesforce; …" string (split downstream)
  internal_id: string;   // NetSuite INTERNAL ID (NetSuite exports only)
  // Old Gold columns (NetSuite TAM exports only — migration 0030)
  last_sql_date: string; // "Last BDR SQL Date" — last time their team met with NetSuite
  qual_note: string;     // "Qualification Note" — BANT/context from that meeting
}

const US_STATES: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };

/** "Casa Grande, Arizona" → { city: "Casa Grande", state: "AZ" }. Also accepts a
 * bare state ("TX" or "Texas"). */
function splitLocation(raw: string): { city: string; state: string } {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const tail = (parts[parts.length - 1] ?? "").toLowerCase();
  const state = US_STATES[tail] ?? (tail.length === 2 ? tail.toUpperCase() : "");
  const city = parts.length > 1 ? parts[0] : "";
  return { city, state };
}

const findCol = (header: string[], ...needles: string[]) =>
  header.findIndex((h) => needles.some((n) => h === n)) >= 0
    ? header.findIndex((h) => needles.some((n) => h === n))
    : header.findIndex((h) => needles.some((n) => h.includes(n)));

/** Map parsed rows → BaseRow, tolerantly detecting the columns ZoomInfo / Apollo /
 * LinkedIn exports use (their headers differ; we match loosely). */
export function rowsToBaseRows(rows: string[][]): BaseRow[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ni = findCol(header, "company name", "organization name", "account name", "company", "name");
  const wi = findCol(header, "web address", "website", "company domain", "domain", "url", "web");
  const ii = findCol(header, "primary industry", "industry", "sub-industry", "subindustry", "sic");
  const si = findCol(header, "billing state", "company state", "state", "hq state");
  const li = findCol(header, "location", "city, state", "headquarters");          // combined "City, State"
  const ei = findCol(header, "employees", "employee count", "# employees", "headcount", "company size", "size");
  const ri = findCol(header, "annual revenue", "revenue", "est. revenue");
  const ti = findCol(header, "technologies", "tech stack", "technology");
  const ii2 = findCol(header, "internal id", "internalid", "netsuite id", "entity id");
  const qi = findCol(header, "qualification note", "qual note", "qualification");
  const di = findCol(header, "last bdr sql date", "bdr sql date", "sql date", "last sql");
  const at = (cells: string[], idx: number) => (idx >= 0 ? (cells[idx] ?? "").trim() : "");

  const out: BaseRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const name = at(c, ni >= 0 ? ni : 0);
    if (!name || name.toLowerCase() === "duplicate") continue; // skip header gaps + NetSuite "Duplicate" placeholders
    // State: prefer a dedicated state column; else parse it out of a "City, State" location.
    let state = at(c, si), city = "";
    if (!state && li >= 0) { const loc = splitLocation(at(c, li)); state = loc.state; city = loc.city; }
    out.push({
      name,
      website: at(c, wi),
      industry: at(c, ii),
      state,
      city,
      employees: at(c, ei),
      revenue: at(c, ri),
      technologies: at(c, ti),
      internal_id: at(c, ii2),
      qual_note: at(c, qi),
      last_sql_date: at(c, di),
    });
  }
  return out;
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
