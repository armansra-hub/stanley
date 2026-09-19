import "server-only";
import { fetchJson } from "./http";
import { SUBAWARD_HISTORY_START, SUBAWARD_SEARCH_PAGE_SIZE } from "./subawardPartitions";
import { usaspendingCursorRequest, usaspendingNextCursor, type UsaspendingSearchAfter, type UsaspendingSearchCursor } from "./usaspendingCursor";

/* eslint-disable @typescript-eslint/no-explicit-any */

const API = "https://api.usaspending.gov/api/v2";
const CONTRACT_CODES = ["A", "B", "C", "D"];
export const IDV_CODES = ["IDV_A", "IDV_B", "IDV_B_A", "IDV_B_B", "IDV_B_C", "IDV_C", "IDV_D", "IDV_E"];
export type FederalAwardCollection = "contracts" | "idvs";

export interface RecipientSuggestion { recipient_name: string; uei: string | null; duns: string | null }

export async function autocompleteRecipients(searchText: string, attempts = 3, deadlineMs?: number): Promise<RecipientSuggestion[]> {
  const data = await fetchJson<{ results?: RecipientSuggestion[] }>(`${API}/autocomplete/recipient/`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ search_text: searchText }),
  }, 20_000, attempts, deadlineMs);
  return data.results ?? [];
}

export interface AwardSearchRow {
  generatedId: string;
  awardId: string;
  recipientName: string;
  recipientUei: string | null;
  awardAmount: number;
  startDate: string | null;
  endDate: string | null;
  lastDateToOrder?: string | null;
  description: string;
  awardingAgency: string;
  awardingSubagency: string;
  fundingAgency: string;
  fundingSubagency: string;
}

export interface AwardSearchPage {
  rows: AwardSearchRow[];
  hasNext: boolean;
  nextCursor?: UsaspendingSearchCursor;
}

function awardSearchRow(x: any): AwardSearchRow {
  return {
    generatedId: String(x.generated_internal_id ?? x.generated_unique_award_id ?? ""), awardId: String(x["Award ID"] ?? ""),
    recipientName: String(x["Recipient Name"] ?? ""), recipientUei: x["Recipient UEI"] ? String(x["Recipient UEI"]) : null,
    awardAmount: Number(x["Award Amount"] ?? 0), startDate: x["Start Date"] ?? null, endDate: x["End Date"] ?? null,
    lastDateToOrder: typeof x["Last Date to Order"] === "string" && /^\d{4}-\d{2}-\d{2}/.test(x["Last Date to Order"]) ? x["Last Date to Order"].slice(0, 10) : null,
    description: String(x.Description ?? ""), awardingAgency: String(x["Awarding Agency"] ?? ""), awardingSubagency: String(x["Awarding Sub Agency"] ?? ""),
    fundingAgency: String(x["Funding Agency"] ?? ""), fundingSubagency: String(x["Funding Sub Agency"] ?? ""),
  };
}

/** One bounded page used by the durable cron continuation state machine. */
export async function searchContractAwardsPage(
  recipient: string,
  page: number,
  endDate: string,
  limit = 100,
  deadlineMs?: number,
  searchAfter?: UsaspendingSearchAfter,
  collection: FederalAwardCollection = "contracts",
): Promise<AwardSearchPage> {
  const body = {
    filters: { recipient_search_text: [recipient], award_type_codes: collection === "idvs" ? IDV_CODES : CONTRACT_CODES, time_period: [{ start_date: "2007-10-01", end_date: endDate }] },
    fields: ["Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Awarding Agency", "Awarding Sub Agency", "Funding Agency", "Funding Sub Agency", "Description", "Start Date", collection === "idvs" ? "Last Date to Order" : "End Date"],
    limit: Math.max(1, Math.min(100, Math.trunc(limit))), page: Math.max(1, Math.trunc(page)), sort: "Start Date", order: "desc",
    ...usaspendingCursorRequest(searchAfter),
  };
  const data = await fetchJson<any>(`${API}/search/spending_by_award/`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, 20_000, 1, deadlineMs);
  if (!Array.isArray(data?.results) || data.results.length > body.limit || typeof data.page_metadata?.hasNext !== "boolean") {
    throw new Error("award search page omitted results or explicit pagination metadata");
  }
  const rows: AwardSearchRow[] = data.results.map(awardSearchRow);
  if (rows.some((row) => !row.generatedId || !row.recipientName)) throw new Error("award search page contains invalid identity rows");
  const nextCursor = usaspendingNextCursor(data.page_metadata, data.results.length, searchAfter);
  return { rows: [...new Map(rows.map((row: AwardSearchRow) => [row.generatedId, row])).values()], hasNext: data.page_metadata.hasNext,
    ...(nextCursor ? { nextCursor } : {}) };
}

export async function searchContractAwards(recipient: string, startDate = "2007-10-01", endDate = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10), maxPages = 100): Promise<AwardSearchRow[]> {
  const all: AwardSearchRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = {
      filters: { recipient_search_text: [recipient], award_type_codes: CONTRACT_CODES, time_period: [{ start_date: startDate, end_date: endDate }] },
      fields: ["Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Awarding Agency", "Awarding Sub Agency", "Funding Agency", "Funding Sub Agency", "Description", "Start Date", "End Date"],
      limit: 100, page, sort: "Start Date", order: "desc",
    };
    const data = await fetchJson<any>(`${API}/search/spending_by_award/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 20_000);
    const rows = (data.results ?? []).map(awardSearchRow).filter((x: AwardSearchRow) => x.generatedId);
    all.push(...rows);
    if (!data.page_metadata?.hasNext || rows.length === 0) break;
  }
  return [...new Map(all.map((x) => [x.generatedId, x])).values()];
}

export async function searchReceivedContractSubawards(recipient: string, startDate = "2007-10-01", endDate = new Date().toISOString().slice(0, 10), maxPages = 100): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = { filters: { recipient_search_text: [recipient], award_type_codes: CONTRACT_CODES, time_period: [{ start_date: startDate, end_date: endDate }] }, fields: ["Sub-Award ID", "Sub-Awardee Name", "Sub-Award Date", "Sub-Award Amount", "Sub-Award Description", "Sub-Recipient UEI", "Awarding Agency", "Awarding Sub Agency", "Prime Award ID", "Prime Recipient Name", "Prime Award Recipient UEI"], limit: 100, page, sort: "Sub-Award Date", order: "desc", subawards: true, spending_level: "subawards" };
    const data = await fetchJson<any>(`${API}/search/spending_by_award/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 20_000);
    for (const result of data.results ?? []) {
      const nested = Array.isArray(result.Subawards) ? result.Subawards : [result];
      for (const sub of nested) all.push({ ...sub, primeAwardId: result["Prime Award ID"] ?? result["Award ID"] ?? result.prime_award_id ?? sub.prime_award_id ?? null, primeAwardGeneratedId: result.prime_award_generated_internal_id ?? sub.prime_award_generated_internal_id ?? null, awardingAgency: result["Awarding Agency"] ?? sub["Awarding Agency"] ?? null });
    }
    if (!data.page_metadata?.hasNext) break;
  }
  return all;
}

/** A single provider page; callers persist stable IDs before moving the cursor. */
export async function searchReceivedContractSubawardsPage(
  recipient: string, page: number, endDate: string, deadlineMs?: number, startDate = SUBAWARD_HISTORY_START,
  searchAfter?: UsaspendingSearchAfter,
): Promise<{ rows: any[]; hasNext: boolean; sourceResultCount: number; nextCursor?: UsaspendingSearchCursor }> {
  const body = {
    filters: { recipient_search_text: [recipient], award_type_codes: CONTRACT_CODES, time_period: [{ start_date: startDate, end_date: endDate }] },
    fields: ["Sub-Award ID", "Sub-Awardee Name", "Sub-Award Date", "Sub-Award Amount", "Sub-Award Description", "Sub-Recipient UEI", "Awarding Agency", "Awarding Sub Agency", "Prime Award ID", "Prime Recipient Name", "Prime Award Recipient UEI"],
    limit: SUBAWARD_SEARCH_PAGE_SIZE, page: Math.max(1, Math.trunc(page)), sort: "Sub-Award Date", order: "desc", subawards: true, spending_level: "subawards",
    ...usaspendingCursorRequest(searchAfter),
  };
  const data = await fetchJson<any>(`${API}/search/spending_by_award/`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, 20_000, 1, deadlineMs);
  if (!Array.isArray(data?.results) || data.results.length > body.limit || typeof data.page_metadata?.hasNext !== "boolean") {
    throw new Error("subaward search page omitted results or explicit pagination metadata");
  }
  const rows: any[] = [];
  for (const result of data.results) {
    const nested = Array.isArray(result.Subawards) ? result.Subawards : [result];
    for (const sub of nested) rows.push({ ...sub,
      primeAwardId: result["Prime Award ID"] ?? result["Award ID"] ?? result.prime_award_id ?? sub.prime_award_id ?? null,
      primeAwardGeneratedId: result.prime_award_generated_internal_id ?? sub.prime_award_generated_internal_id ?? null,
      awardingAgency: result["Awarding Agency"] ?? sub["Awarding Agency"] ?? null,
      "Prime Recipient Name": sub["Prime Recipient Name"] ?? result["Prime Recipient Name"] ?? null,
      "Prime Award Recipient UEI": sub["Prime Award Recipient UEI"] ?? result["Prime Award Recipient UEI"] ?? null,
      "Sub-Recipient UEI": sub["Sub-Recipient UEI"] ?? result["Sub-Recipient UEI"] ?? null,
    });
  }
  const nextCursor = usaspendingNextCursor(data.page_metadata, data.results.length, searchAfter);
  return { rows, hasNext: data.page_metadata.hasNext, sourceResultCount: data.results.length, ...(nextCursor ? { nextCursor } : {}) };
}

export async function fetchAwardDetail(generatedId: string, attempts = 3, deadlineMs?: number): Promise<any> {
  return fetchJson<any>(`${API}/awards/${encodeURIComponent(generatedId)}/`, {}, 20_000, attempts, deadlineMs);
}

export interface AwardTransactionPage {
  rows: any[];
  hasNext: boolean;
}

/** One bounded transaction page used by the durable cron continuation. */
export async function fetchAwardTransactionsPage(generatedId: string, page: number, deadlineMs?: number): Promise<AwardTransactionPage> {
  const data = await fetchJson<any>(`${API}/transactions/`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ award_id: generatedId, page: Math.max(1, Math.trunc(page)), limit: 500, sort: "action_date", order: "desc" }),
  }, 20_000, 1, deadlineMs);
  if (!Array.isArray(data?.results) || data.results.length > 500 || typeof data.page_metadata?.hasNext !== "boolean") {
    throw new Error("award transaction page omitted results or explicit pagination metadata");
  }
  return { rows: data.results, hasNext: data.page_metadata.hasNext };
}

export async function fetchAwardTransactions(generatedId: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJson<any>(`${API}/transactions/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ award_id: generatedId, page, limit: 5000, sort: "action_date", order: "desc" }),
    }, 20_000);
    all.push(...(data.results ?? []));
    if (!data.page_metadata?.hasNext) break;
  }
  return all;
}

export function awardUrl(generatedId: string): string {
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedId)}/latest`;
}

export function recipientProfileUrl(identity: { recipientId?: string | null; uei?: string | null; name: string }): string {
  const key = identity.recipientId ?? identity.uei ?? identity.name;
  return `https://www.usaspending.gov/recipient/${encodeURIComponent(key)}/latest`;
}

export function compactAward(detail: any) {
  const recipient = detail.recipient ?? {}, location = recipient.location ?? {};
  const contract = detail.latest_transaction_contract_data ?? {};
  const businessCategories = Array.isArray(recipient.business_categories) ? recipient.business_categories.map(String) : [];
  const businessSizeStatus = businessCategories.some((x: string) => /not designated a small business/i.test(x)) ? "other_than_small"
    : businessCategories.some((x: string) => /^small business$/i.test(x)) ? "small" : "unknown";
  return {
    generatedAwardId: String(detail.generated_unique_award_id ?? ""), awardId: String(detail.piid ?? ""),
    parentAwardId: detail.parent_award?.generated_unique_award_id ? String(detail.parent_award.generated_unique_award_id) : null,
    awardType: String(detail.type_description ?? detail.type ?? ""), description: String(detail.description ?? ""),
    awardTypeCode: String(detail.type ?? ""),
    awardCategory: detail.category === "idv" || /^IDV_/.test(String(detail.type ?? "")) ? "idv" : "contract",
    recipient: { legalName: String(recipient.recipient_name ?? ""), uei: recipient.recipient_uei ? String(recipient.recipient_uei) : null,
      parentUei: recipient.parent_recipient_uei ? String(recipient.parent_recipient_uei) : null, parentName: recipient.parent_recipient_name ? String(recipient.parent_recipient_name) : null,
      address: location.address_line1 ?? null, city: location.city_name ?? null, state: location.state_code ?? null, postalCode: location.zip5 ?? null, countryCode: location.location_country_code ?? null,
      recipientId: recipient.recipient_hash ?? null, businessCategories },
    awardingAgency: detail.awarding_agency?.toptier_agency?.name ?? null,
    awardingSubagency: detail.awarding_agency?.subtier_agency?.name ?? null,
    awardingOffice: detail.awarding_agency?.office_agency_name ?? null,
    fundingAgency: detail.funding_agency?.toptier_agency?.name ?? null,
    fundingSubagency: detail.funding_agency?.subtier_agency?.name ?? null,
    naicsCode: contract.naics ?? detail.naics_hierarchy?.base_code?.code ?? null,
    pscCode: contract.product_or_service_code ?? detail.psc_hierarchy?.base_code?.code ?? null,
    startDate: detail.period_of_performance?.start_date ?? detail.date_signed ?? null,
    endDate: detail.period_of_performance?.end_date ?? null,
    potentialEndDate: detail.period_of_performance?.potential_end_date?.slice?.(0, 10) ?? null,
    signedDate: detail.date_signed?.slice?.(0, 10) ?? null,
    // Ordering dates are carried from the explicitly named IDV search field;
    // a performance end alone is not substituted for a last-date-to-order.
    orderingEndDate: detail.last_date_to_order?.slice?.(0, 10) ?? null,
    sourceUpdatedAt: detail.period_of_performance?.last_modified_date ?? null,
    awardCeiling: Number(detail.base_and_all_options ?? 0),
    currentAwardAmount: Number(detail.base_exercised_options ?? 0),
    totalObligations: Number(detail.total_obligation ?? 0),
    solicitationIdentifier: contract.solicitation_identifier ?? null,
    offersReceived: contract.number_of_offers_received ?? null,
    extentCompeted: contract.extent_competed_description ?? null,
    setAside: contract.type_set_aside_description ?? null,
    businessSizeStatus,
  };
}
