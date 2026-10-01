import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecentCustomerMatches from "./RecentCustomerMatches";
import { ApprovedCustomerMatchCard, CustomerCriterionDefinition, CustomerExampleEvidence } from "./CustomerCriteriaBrowser";
import type { ApprovedCustomerCriterion } from "@/lib/intelligence/customerApprovedCatalog";
import type { CustomerCriteriaAccount, CustomerCriterionExample } from "@/lib/intelligence/customerCriteria";
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
describe("published customer criteria UI", () => {
  it("defaults to research criteria with explicit legacy access and no retired progress boxes", () => {
    const markup = renderToStaticMarkup(React.createElement(RecentCustomerMatches, { enabled: true }));
    expect(markup).toContain("Customer research criteria"); expect(markup).toContain("Legacy saved matches");
    expect(markup).not.toContain("Saved Jev question sets"); expect(markup).not.toContain("Saved customer reference sources");
    expect(markup).not.toContain("0 unique matching");
  });
  it("renders full requirements and exclusions, distinguishing illustrative examples", () => {
    const criterion = { id: "one", label: "Installs own equipment", predicate: "Both sale and installation are established.", evidenceRules: ["Direct delivery evidence"], exclusions: ["Software serving installers is excluded"],
      applicability: { scope: "universal" }, positiveExamples: [{ scenario: "An installer", explanation: "Does both." }], negativeExamples: [{ scenario: "A vendor", explanation: "Does not install." }] } as unknown as ApprovedCustomerCriterion;
    const markup = renderToStaticMarkup(React.createElement(CustomerCriterionDefinition, { criterion }));
    for (const text of [criterion.predicate, criterion.evidenceRules[0], criterion.exclusions[0], "illustrative"]) expect(markup).toContain(text);
  });
  it("preserves in-record opening, multiselect, quick copy and dismissal controls", () => {
    const account = { companyId: "prospect", name: "Prospect", domain: "prospect.com", sharedCriteria: [], topics: [] } as unknown as CustomerCriteriaAccount;
    const markup = renderToStaticMarkup(React.createElement(ApprovedCustomerMatchCard, { account, selected: true, busy: false, onOpenAccount: vi.fn(), onSelect: vi.fn(), onStatus: vi.fn() }));
    for (const label of ["Select Prospect", "Copy company name", "Copy website", "Dismiss Prospect"]) expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).not.toContain('href="/headhunter/intelligence?companyId=');
  });
  it("keeps customer author, subject, qualification and exact evidence distinct from Jev", () => {
    const example = { name: "Customer", website: "https://customer.com", identityQualification: "Brand inference disclosed", offeringScope: "Managed service", whyMatches: "Direct delivery",
      sourceGaps: ["Pricing not public"], facts: [{ id: "fact", label: "Service", value: "Runs support", explanation: "Owned service", subject: { name: "Customer", kind: "customer" }, citations: [{ sourceId: "s", url: "https://customer.com", title: "Services", start: 0, end: 18, quote: "Our team operates." }] }] } as unknown as CustomerCriterionExample;
    const markup = renderToStaticMarkup(React.createElement(CustomerExampleEvidence, { example }));
    for (const text of ["authored research", "Brand inference disclosed", "Our team operates.", "Pricing not public"]) expect(markup).toContain(text);
    expect(markup).not.toContain("Raw Jev answer");
  });
});
