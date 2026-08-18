import "server-only";
import { compactSamOpportunity } from "./sam";

const BULK_URL = "https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv";

/** Streaming RFC-4180 parser. SAM descriptions can contain commas, quotes, and
 * embedded newlines, so line splitting is not safe for this extract. */
async function* csvRows(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder("windows-1252");
  let row: string[] = [], field = "", quoted = false, quotePending = false;
  const feed = function* (text: string) {
    for (const char of text) {
      if (quoted) {
        if (quotePending) {
          if (char === '"') { field += '"'; quotePending = false; continue; }
          quoted = false; quotePending = false;
        } else {
          if (char === '"') quotePending = true;
          else field += char;
          continue;
        }
      }
      if (char === '"' && field.length === 0) quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field); field = ""; const complete = row; row = []; yield complete; }
      else if (char !== "\r") field += char;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    yield* feed(decoder.decode(value, { stream: true }));
  }
  yield* feed(decoder.decode());
  if (field.length || row.length) { row.push(field); yield row; }
}

export async function fetchSamOpportunityBulk(days = 31) {
  const response = await fetch(BULK_URL, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`SAM bulk download failed: ${response.status}`);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let headers: string[] | null = null, scanned = 0;
  const rows: ReturnType<typeof compactSamOpportunity>[] = [];
  for await (const values of csvRows(response.body)) {
    if (!headers) { headers = values.map((value) => value.replace(/^\uFEFF/, "")); continue; }
    scanned++;
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    if (!raw.NoticeId || String(raw.PostedDate ?? "").slice(0, 10) < cutoff) continue;
    const compact = compactSamOpportunity({
      noticeId: raw.NoticeId,
      title: raw.Title,
      solicitationNumber: raw["Sol#"] || null,
      department: raw["Department/Ind.Agency"] || null,
      subTier: raw["Sub-Tier"] || null,
      office: raw.Office || null,
      postedDate: raw.PostedDate || null,
      type: raw.Type || null,
      active: raw.Active,
      archiveDate: raw.ArchiveDate || null,
      typeOfSetAsideDescription: raw.SetAside || null,
      responseDeadLine: raw.ResponseDeadLine || null,
      naicsCode: raw.NaicsCode || null,
      classificationCode: raw.ClassificationCode || null,
      placeOfPerformance: { street: raw.PopStreetAddress || null, city: raw.PopCity || null, state: raw.PopState || null, zip: raw.PopZip || null, country: raw.PopCountry || null },
      award: { number: raw.AwardNumber || null, amount: raw["Award$"] || null, awardee: { name: raw.Awardee || null } },
      uiLink: raw.Link || `https://sam.gov/opp/${encodeURIComponent(raw.NoticeId)}/view`,
      // Do not retain the often multi-page description for 30k+ unmatched rows.
      // The exact SAM link remains the evidence source for matched TAM records.
      description: null,
    });
    compact.evidence = { source: "SAM public Contract Opportunities bulk CSV", noticeId: raw.NoticeId, lastModified: response.headers.get("last-modified") };
    rows.push(compact);
  }
  return {
    rows,
    scanned,
    sourceUrl: BULK_URL,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}
