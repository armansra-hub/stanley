import { OPERATING_INDUSTRY_GUIDES } from "./operatingCatalog";

/** Public context rules only. No provider, database or paid dispatch dependency. */
export function providerIndustryContextDefinitions() {
  return OPERATING_INDUSTRY_GUIDES.map(g => ({ id: g.id, label: g.label,
    predicate: `The target provider itself operates in ${g.label}. Classify its own sold products/services and operating model, not the industries of its customers.`,
    evidenceRules: [g.guidance, "Require affirmative source evidence about the target provider. Mixed models can support more than one industry. Missing evidence is unknown."],
    exclusions: [g.boundary, "Serving customers in this industry alone is not evidence the provider operates in it."] }));
}
