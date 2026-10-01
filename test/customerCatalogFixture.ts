import { customerCharacteristicVersion } from "../lib/intelligence/customerResearchProfiles";
import { providerIndustryContextDefinitions } from "../lib/intelligence/customerIndustryContext";

export function catalogFixture(version = "approved-fixture-one", changed = false) {
  const facets = ["policy-owned-fleet", "inventory-project-service"].map((id, index) => {
    const rule = { id, label: `Criterion ${index + 1}`, applicability: { scope: "universal" as const },
      predicate: index === 0 ? "The target owns and operates its delivery fleet." : changed ? "The target sells recurring managed operations." : "The target sells finite implementation projects.",
      evidenceRules: ["Require explicit evidence about this target's own sold services or assets."],
      exclusions: ["Customer and partner activities do not establish this target's operations."],
      positiveExamples: [{ kind: "illustrative" as const, scenario: "The target explicitly describes its own operation.", explanation: "The source attributes the activity to this company." }],
      negativeExamples: [{ kind: "illustrative" as const, scenario: "A customer uses the service.", explanation: "Customer activity does not establish provider operations." }], customerSupport: [] };
    return { ...rule, definitionVersion: customerCharacteristicVersion(rule), familyId: "navigation-family", originalScope: "retained" };
  });
  return { version, status: "approved", facets, navigationFamilies: [{ id: "navigation-family" }],
    evidenceFields: [{ id: "description-field" }], industryContextDefinitions: providerIndustryContextDefinitions() };
}
