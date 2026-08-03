import "server-only";
import { fetchJson } from "./http";

/* eslint-disable @typescript-eslint/no-explicit-any */

const API = "https://api.usaspending.gov/api/v2";
const CONTRACT_CODES = ["A", "B", "C", "D"];

export interface RecipientSuggestion { recipient_name: string; uei: string | null; duns: string | null }

export async function autocompleteRecipients(searchText: string): Promise<RecipientSuggestion[]> {
  const data = await fetchJson<{ results?: RecipientSuggestion[] }>(`${API}/autocomplete/recipient/`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ search_text: searchText }),
  });
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
  description: string;
  awardingAgency: string;
  awardingSubagency: string;
  fundingAgency: string;
  fundingSubagency: string;
}

export async function searchContractAwards(recipient: string, startDate = "2007-10-01", endDate = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10), maxPages = 25): Promise<AwardSearchRow[]> {
  const all: AwardSearchRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = {
      filters: { recipient_search_text: [recipient], award_type_codes: CONTRACT_CODES, time_period: [{ start_date: startDate, end_date: endDate }] },
      fields: ["Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Awarding Agency", "Awarding Sub Agency", "Funding Agency", "Funding Sub Agency", "Description", "Start Date", "End Date"],
      limit: 100, page, sort: "Start Date", order: "desc",
    };
    const data = await fetchJson<any>(`${API}/search/spending_by_award/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 20_000);
    const rows = (data.results ?? []).map((x: any): AwardSearchRow => ({
      generatedId: String(x.generated_internal_id ?? x.generated_unique_award_id ?? ""), awardId: String(x["Award ID"] ?? ""),
      recipientName: String(x["Recipient Name"] ?? ""), recipientUei: x["Recipient UEI"] ? String(x["Recipient UEI"]) : null,
      awardAmount: Number(x["Award Amount"] ?? 0), startDate: x["Start Date"] ?? null, endDate: x["End Date"] ?? null,
      description: String(x.Description ?? ""), awardingAgency: String(x["Awarding Agency"] ?? ""), awardingSubagency: String(x["Awarding Sub Agency"] ?? ""),
      fundingAgency: String(x["Funding Agency"] ?? ""), fundingSubagency: String(x["Funding Sub Agency"] ?? ""),
    })).filter((x: AwardSearchRow) => x.generatedId);
    all.push(...rows);
    if (!data.page_metadata?.hasNext || rows.length === 0) break;
  }
  return [...new Map(all.map((x) => [x.generatedId, x])).values()];
}

export async function searchReceivedContractSubawards(recipient: string, startDate = "2007-10-01", endDate = new Date().toISOString().slice(0, 10), maxPages = 25): Promise<any[]> {
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

export async function fetchAwardDetail(generatedId: string): Promise<any> {
  return fetchJson<any>(`${API}/awards/${encodeURIComponent(generatedId)}/`, {}, 20_000);
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
