import { createHash } from "node:crypto";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { normalizeName } from "@/lib/publicGrowth/identity";
import { sameCompanySite } from "@/lib/sources/siteDiscovery";

export const REGIONAL_SOURCES = {
  sf_supplier_contracts: { id: "sf_supplier_contracts", name: "San Francisco supplier contracts", host: "https://data.sf.gov", dataset: "cqi5-hm2d",
    scope: "San Francisco published supplier contracts, generally updated weekly. Excludes confidential records; not nationwide coverage.", cadence: "Weekly source publication" },
  wa_fy2025_contracts: { id: "wa_fy2025_contracts", name: "Washington agency contracts — FY2025", host: "https://data.wa.gov", dataset: "6fx9-ncas",
    scope: "Washington agency FY2025 contract disclosure, including amendments. Historical fiscal-year data; not a live award feed.", cadence: "Historical FY2025 disclosure" },
} as const;
export type RegionalSourceId = keyof typeof REGIONAL_SOURCES;
export type RegionalAccount = { id: string; name: string; domain?: string | null; state?: string | null; city?: string | null };
export type RegionalContractFact = {
  sourceId: RegionalSourceId; sourceRowId: string; sourceUrl: string; sourceUpdatedAt: string | null;
  contractNumber: string | null; amendment: string | null; supplierName: string; supplierDba: string | null; supplierRole: string;
  primeSupplierName: string | null; supplierIdentifier: string | null; agency: string | null; title: string; description: string;
  startDate: string | null; endDate: string | null; reportedAmount: number | null; amountBasis: string;
  paymentsReported: number | null; scope: string;
};
export type RegionalIdentityEvidence = { observationId: string; sourceUrl: string; excerpt: string; method: "company_site_contract_reference" };
export type RegionalCandidate = { companyId: string; externalKey: string; contentHash: string; fact: RegionalContractFact; identityEvidence?: RegionalIdentityEvidence };
export type RegionalWebsiteEvidence = { id: string; company_id: string; source_url: string; evidence_text: string };

/** A meaningful exact contract identifier, supplier and jurisdiction together on
 * the prospect's own site can establish identity without another model call. */
export function confirmRegionalCandidate(candidate: RegionalCandidate, account: RegionalAccount, rows: RegionalWebsiteEvidence[]): RegionalCandidate {
  const id = candidate.fact.contractNumber?.trim() ?? "", compact = id.replace(/[^a-z0-9]/gi, "");
  if (!account.domain || compact.length < 8 || !/\d/.test(compact) || /^\d+$/.test(compact) && compact.length < 10) return candidate;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "ig");
  const names = [candidate.fact.supplierName, candidate.fact.supplierDba].map(normalizeName).filter(name => name.length >= 5);
  const agency = normalizeName(candidate.fact.agency?.replace(/^\d+\s*[-–:]?\s*/, "") ?? "");
  for (const row of rows) {
    if (row.company_id !== account.id || !sameCompanySite(row.source_url, `https://${account.domain.replace(/^https?:\/\//, "")}`)) continue;
    for (const match of row.evidence_text.matchAll(pattern)) {
      const excerpt = row.evidence_text.slice(Math.max(0, match.index! - 500), match.index! + id.length + 500);
      const words = ` ${normalizeName(excerpt)} `;
      const jurisdiction = candidate.fact.sourceId === "sf_supplier_contracts" ? words.includes(" san francisco ")
        : words.includes(" washington state ") || words.includes(" state of washington ") || agency.length >= 14 && words.includes(` ${agency} `);
      if (jurisdiction && names.some(name => words.includes(` ${name} `))) return { ...candidate, identityEvidence: {
        observationId: row.id, sourceUrl: row.source_url, excerpt, method: "company_site_contract_reference",
      } };
    }
  }
  return candidate;
}
type Row = Record<string, unknown>;
const text = (value: unknown, max = 1000): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const date = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const money = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).replace(/[$,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(clean)) return null;
  const number = Number(clean); return Number.isFinite(number) ? number : null;
};
export function regionalSourceUrl(sourceId: RegionalSourceId) { const source = REGIONAL_SOURCES[sourceId]; return `${source.host}/d/${source.dataset}`; }

export function normalizeRegionalRow(sourceId: RegionalSourceId, row: Row): RegionalContractFact[] {
  const source = REGIONAL_SOURCES[sourceId], rowId = text(row.source_row_id, 180);
  if (!rowId) throw new Error("regional_source_row_id_missing");
  const rowUrl = new URL(`${source.host}/resource/${source.dataset}.json`);
  rowUrl.searchParams.set("$where", `:id='${rowId.replaceAll("'", "''")}'`);
  const common = { sourceId, sourceRowId: rowId, sourceUrl: rowUrl.toString(), sourceUpdatedAt: date(row.source_updated_at), scope: source.scope };
  if (sourceId === "sf_supplier_contracts") {
    const prime = text(row.prime_contractor, 300), supplier = text(row.project_team_supplier, 300);
    const base = { ...common, contractNumber: text(row.contract_no, 180), amendment: null, supplierDba: null, supplierIdentifier: null,
      primeSupplierName: prime, agency: text(row.department, 300), title: text(row.contract_title, 1000) ?? "Published supplier contract",
      description: text(row.scope_of_work, 3000) ?? "", startDate: date(row.term_start_date), endDate: date(row.term_end_date),
      reportedAmount: money(row.agreed_amt), paymentsReported: money(row.pmt_amt), amountBasis: "Reported contract amount; not an allocation to each project-team supplier. Amounts are not summed." };
    const facts: RegionalContractFact[] = [];
    if (prime) facts.push({ ...base, supplierName: prime, supplierRole: "Prime Contractor" });
    if (supplier && normalizeName(supplier) !== normalizeName(prime)) facts.push({ ...base, supplierName: supplier, supplierRole: text(row.project_team_constituent, 100) ?? "Project-team supplier (role unspecified)" });
    return facts;
  }
  const supplier = text(row.contractor_name_search_for, 300);
  if (!supplier) return [];
  return [{ ...common, contractNumber: text(row.agency_contract_no, 180), amendment: text(row.agency_contract_amendment, 180),
    supplierName: supplier, supplierDba: text(row.contractor_name_d_b_a_optional, 300), supplierRole: "Reported contractor",
    primeSupplierName: supplier, supplierIdentifier: text(row.statewide_vendor_number, 180), agency: text(row.agency_number_agency_name, 300),
    title: text(row.purpose_of_the_contract_1, 1000) ?? text(row.purpose_of_the_contract, 1000) ?? "Published agency contract",
    description: [text(row.purpose_of_the_contract_1, 2000), text(row.contract_modifications, 500), text(row.explanation_of_costs_optional, 500)].filter(Boolean).join("\n"),
    startDate: date(row.contract_effective_start), endDate: date(row.contract_effective_end_date), reportedAmount: money(row.cost_of_contract), paymentsReported: null,
    amountBasis: "FY2025 row-reported contract cost. Amendments can repeat totals; this is not a payment amount and rows are not summed." }];
}

/** Exact normalized names are retrieval candidates only. Neither dataset exposes
 * a prospect domain/address/UEI, so they cannot prove same-company identity. */
export function regionalCandidateIndex(accounts: RegionalAccount[]) {
  const index = new Map<string, RegionalAccount[]>();
  for (const account of accounts) {
    const key = normalizeName(account.name); if (key.length < 3) continue;
    index.set(key, [...(index.get(key) ?? []), account]);
  }
  return (facts: RegionalContractFact[]): RegionalCandidate[] => {
    const matches = new Map<string, RegionalCandidate>();
    for (const fact of facts) {
      const names = new Set([fact.supplierName, fact.supplierDba].map(normalizeName).filter(Boolean));
      for (const name of names) for (const account of index.get(name) ?? []) {
        const externalKey = createHash("sha256").update(JSON.stringify([fact.sourceId, fact.contractNumber ?? fact.sourceRowId,
          fact.agency, fact.amendment, normalizeName(fact.supplierName), fact.supplierRole])).digest("hex");
        const contentHash = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
        matches.set(`${account.id}:${externalKey}`, { companyId: account.id, externalKey, contentHash, fact });
      }
    }
    return [...matches.values()];
  };
}

export type RegionalCursor = { offset: number; version: string | null; complete: boolean };
export async function fetchRegionalPage(sourceId: RegionalSourceId, cursor: RegionalCursor, fetchText = fetchPublicHttpText) {
  const source = REGIONAL_SOURCES[sourceId];
  const metadata = await fetchText(`${source.host}/api/views/${source.dataset}.json`, { timeoutMs: 8000, maxBytes: 2_000_000, accept: "application/json" });
  if (metadata.status !== 200) throw new Error("regional_metadata_unavailable");
  const meta = JSON.parse(metadata.body) as { rowsUpdatedAt?: number };
  if (!Number.isFinite(meta.rowsUpdatedAt)) throw new Error("regional_snapshot_version_missing");
  const version = String(meta.rowsUpdatedAt), unchanged = cursor.complete && version === cursor.version;
  if (unchanged) return { rows: [] as Row[], offset: 0, version, complete: true, unchanged: true };
  const offset = cursor.version === version && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0;
  const url = new URL(`${source.host}/resource/${source.dataset}.json`);
  url.searchParams.set("$select", "*, :id as source_row_id, :updated_at as source_updated_at");
  url.searchParams.set("$order", ":id"); url.searchParams.set("$limit", "500"); url.searchParams.set("$offset", String(offset));
  const response = await fetchText(url.toString(), { timeoutMs: 10000, maxBytes: 3_000_000, accept: "application/json" });
  if (response.status !== 200) throw new Error("regional_contracts_unavailable");
  const rows = JSON.parse(response.body) as unknown;
  if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => !row || typeof row !== "object" || !text(row.source_row_id, 180))) throw new Error("regional_contracts_invalid_response");
  return { rows: rows as Row[], offset: offset + rows.length, version, complete: rows.length < 500, unchanged: false };
}
