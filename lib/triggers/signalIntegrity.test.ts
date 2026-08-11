import { describe, expect, it } from "vitest";
import {
  financeHireEligibility,
  isCareerEvidenceUrl,
  isFabricatedRootAnchor,
  isLegacyNameOnlyGovernmentTrigger,
  isPublishableTriggerEvidence,
  isPublishableTriggerForCompany,
  strictEntityIdentityMatches,
  triggerQuarantineReason,
} from "./signalIntegrity";

describe("finance-hire company eligibility", () => {
  it("rejects record-dead companies without changing their TAM status", () => {
    expect(financeHireEligibility({ name: "Operating Co", record_dead: true })).toEqual({
      eligible: false,
      reason: "record_dead",
    });
  });

  it.each([
    "KPM CPA",
    "Tax Goddess",
    "Netpay Payroll",
    "John Warekois CPA",
    "Blair Dance CPA",
    "VPTax",
  ])("treats %s as finance-core and signal-ineligible", (name) => {
    expect(financeHireEligibility({ name }).eligible).toBe(false);
  });

  it("uses industry/service evidence but does not reject an ordinary operator", () => {
    expect(financeHireEligibility({ name: "Acme Logistics", subindustry: "Accounting firm" }).eligible).toBe(false);
    expect(financeHireEligibility({ name: "Acme Logistics", description: "Provides outsourced bookkeeping and payroll services." }).eligible).toBe(false);
    expect(financeHireEligibility({ name: "Acme Logistics", description: "Hiring a controller to own internal accounting." }).eligible).toBe(true);
  });
});

describe("career evidence", () => {
  it("accepts actual career/job pages and recognized hosted boards", () => {
    expect(isCareerEvidenceUrl("https://acme.example/careers/controller")).toBe(true);
    expect(isCareerEvidenceUrl("https://boards.greenhouse.io/acme/jobs/123")).toBe(true);
    expect(isCareerEvidenceUrl("https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Controller_R1")).toBe(true);
  });

  it("rejects homepages, unrelated redirects, malformed URLs, and fabricated role anchors", () => {
    expect(isCareerEvidenceUrl("https://acme.example/")).toBe(false);
    expect(isCareerEvidenceUrl("https://acme.example/solutions/")).toBe(false);
    expect(isPublishableTriggerEvidence({ type: "finance_hire", source_name: "Careers page", source_url: "https://acme.example/solutions/" })).toBe(false);
    expect(isCareerEvidenceUrl("not a url")).toBe(false);
    expect(isFabricatedRootAnchor("https://acme.example/#Staff%20Accountant")).toBe(true);
    expect(isCareerEvidenceUrl("https://acme.example/#Staff%20Accountant")).toBe(false);
  });
});

describe("Form D name component", () => {
  it("recognizes exact names across legal suffix and punctuation differences", () => {
    expect(strictEntityIdentityMatches("Acme Services LLC", "ACME SERVICES, INC. (CIK 1234567) (Filer)")).toBe(true);
  });

  it.each([
    ["Pacific Opportunities", "SAM Asia Pacific Opportunities Fund"],
    ["Growth Partners", "Bridge Growth Partners III"],
    ["Highline", "Highline Capital Fund II"],
  ])("rejects substring false match %s <- %s", (company, filer) => {
    expect(strictEntityIdentityMatches(company, filer)).toBe(false);
  });
});

describe("legacy quarantine visibility", () => {
  it("hides finance-hire root anchors as well as prior affected types", () => {
    for (const type of ["finance_hire", "ma", "press", "new_entity"]) {
      expect(isPublishableTriggerEvidence({ type, source_url: "https://example.com/#Controller" })).toBe(false);
    }
  });

  it("hides explicit quarantine markers and company-ineligible finance rows", () => {
    expect(isPublishableTriggerEvidence({
      type: "press",
      source_url: "https://example.com/news/expansion",
      metadata: { stanley_quarantine: { active: true, reason: "reviewed_false_positive" } },
    })).toBe(false);
    expect(isPublishableTriggerForCompany({
      type: "finance_hire",
      source_name: "Job posting",
      source_url: "https://jobs.lever.co/kpm/controller",
    }, { name: "KPM CPA" })).toBe(false);
  });

  it("allows an inactive or malformed marker to be repaired by the cleanup", () => {
    const base = {
      type: "press",
      source_url: "https://example.com/news/expansion",
    };
    expect(isPublishableTriggerEvidence({
      ...base,
      metadata: { stanley_quarantine: { active: false, reason: "reversed" } },
    })).toBe(true);
    expect(isPublishableTriggerEvidence({
      ...base,
      metadata: { stanley_quarantine: "malformed" },
    })).toBe(true);
    expect(isPublishableTriggerEvidence({
      ...base,
      metadata: { stanley_quarantine: { reason: "missing active flag" } },
    })).toBe(true);
  });

  it("hides every name-only Form D row, including an exact filing link", () => {
    expect(isPublishableTriggerEvidence({
      type: "funding",
      source_name: "SEC EDGAR",
      summary: "Filed SEC Form D (private capital raise) — Pacific Opportunities LLC",
      source_url: "https://www.sec.gov/cgi-bin/srqsb?text=Pacific%20Opportunities",
    })).toBe(false);
    expect(isPublishableTriggerEvidence({
      type: "funding",
      source_name: "SEC EDGAR",
      summary: "Filed SEC Form D (private capital raise) — Acme Services LLC",
      source_url: "https://www.sec.gov/Archives/edgar/data/123/000000000000000001/0000000000-00-000001.txt",
    })).toBe(false);
  });

  it("hides and quarantines only the retired name-only USAspending writer rows", () => {
    const legacy = {
      type: "gov_contract",
      source_name: "USAspending",
      source_url: "https://www.usaspending.gov/award/CONT_AWD_123",
    };
    expect(isLegacyNameOnlyGovernmentTrigger(legacy)).toBe(true);
    expect(isPublishableTriggerEvidence(legacy)).toBe(false);
    expect(triggerQuarantineReason(legacy, { name: "Acme" }))
      .toBe("legacy_name_only_government_identity_unverifiable");

    expect(isLegacyNameOnlyGovernmentTrigger({
      type: "federal_award",
      source_name: "USAspending",
    })).toBe(false);
    expect(isPublishableTriggerEvidence({
      type: "federal_award",
      source_name: "USAspending",
      source_url: "https://www.usaspending.gov/award/CONT_AWD_123",
    })).toBe(true);
  });

  it("plans mismatch and core-business quarantine reasons deterministically", () => {
    expect(triggerQuarantineReason({
      type: "funding",
      source_name: "SEC EDGAR",
      summary: "Filed SEC Form D (private capital raise) — Bridge Growth Partners III",
      source_url: "https://www.sec.gov/cgi-bin/srqsb?text=Growth%20Partners",
    }, { name: "Growth Partners" })).toBe("form_d_entity_mismatch");

    expect(triggerQuarantineReason({
      type: "funding",
      source_name: "SEC EDGAR",
      summary: "Filed SEC Form D (private capital raise) — Acme Services LLC",
      source_url: "https://www.sec.gov/Archives/edgar/data/123/000000000000000001/0000000000-00-000001.txt",
    }, { name: "Acme Services" })).toBe("form_d_identity_unverifiable");

    expect(triggerQuarantineReason({
      type: "finance_hire",
      source_name: "Job posting",
      source_url: "https://jobs.lever.co/kpm/staff-accountant",
    }, { name: "KPM CPA" })).toBe("finance_hire_finance_is_core_business");
  });
});
