import { OPERATING_FACETS } from "./operatingCatalog";
import type { CustomerReference } from "./customerMatches";

export type CustomerTraitCounts = {
  supported: number;
  not_supported: number;
  insufficient_evidence: number;
  conflicting: number;
  unanswered: number;
};
export type CustomerCohortSlice = { customers: number; completedCustomers: number; partialCustomers: number; traits: Record<string, CustomerTraitCounts> };
export type CustomerIndustryCohort = {
  industry: string | null;
  all: CustomerCohortSlice;
  recent: CustomerCohortSlice;
  older: CustomerCohortSlice;
};
export type CustomerCohortSummary = {
  asOf: string;
  recentDays: 180;
  customers: number;
  completedCustomers: number;
  partialCustomers: number;
  industries: CustomerIndustryCohort[];
};

const slice = (): CustomerCohortSlice => ({ customers: 0, completedCustomers: 0, partialCustomers: 0, traits: Object.fromEntries(OPERATING_FACETS.map(facet => [facet.id,
  { supported: 0, not_supported: 0, insufficient_evidence: 0, conflicting: 0, unanswered: 0 }])) });

/** Count already validated native answers, never infer another decision or a
 * new category. Call with the same eligible references used by the matcher.
 * Every trait denominator is its slice's customers, including native unknowns.
 * Registry IDs preserve distinct companies sharing a domain or buying program. */
export function summarizeCustomerCohort(references: readonly CustomerReference[], now: number): CustomerCohortSummary {
  const groups = new Map<string | null, CustomerIndustryCohort>();
  const seen = new Set<string>();
  let completedCustomers = 0, partialCustomers = 0;
  const add = (cohort: CustomerCohortSlice, reference: CustomerReference) => {
    cohort.customers++;
    if (reference.status === "verified") cohort.completedCustomers++;
    else cohort.partialCustomers++;
    for (const facet of OPERATING_FACETS) {
      const decision = reference.answers[facet.id]?.decision;
      const counts = cohort.traits[facet.id];
      if (decision && Object.hasOwn(counts, decision)) counts[decision]++;
      else counts.unanswered++;
    }
  };
  for (const reference of references) {
    if (!["verified", "partial"].includes(reference.status) || seen.has(reference.id)) continue;
    const announced = Date.parse(reference.announcementDate);
    if (!Number.isFinite(announced) || announced > now) continue;
    seen.add(reference.id);
    if (reference.status === "verified") completedCustomers++;
    else partialCustomers++;
    const industry = reference.subindustry?.trim() || null;
    let group = groups.get(industry);
    if (!group) { group = { industry, all: slice(), recent: slice(), older: slice() }; groups.set(industry, group); }
    add(group.all, reference);
    add(now - announced <= 180 * 86_400_000 ? group.recent : group.older, reference);
  }
  return { asOf: new Date(now).toISOString(), recentDays: 180, customers: seen.size, completedCustomers, partialCustomers,
    industries: [...groups.values()].sort((a, b) => (a.industry ?? "\uffff").localeCompare(b.industry ?? "\uffff")) };
}
