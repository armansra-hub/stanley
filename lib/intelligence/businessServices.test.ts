import { describe, expect, it } from "vitest";
import { SUBINDUSTRIES } from "@/config/territory";
import { OPERATING_TOPICS } from "./profiles";
import { businessServicesResearchContext, operatingTopicPriority, researchSourcePriority } from "./businessServices";

describe("business-services research focus", () => {
  it("uses valid operating topics for every actual territory subindustry", () => {
    for (const industry of SUBINDUSTRIES) for (const kind of ["website", "ats_job", "news"]) {
      const topics = operatingTopicPriority(industry, kind);
      expect(topics.length).toBeGreaterThan(6);
      expect(new Set(topics).size).toBe(topics.length);
      expect(topics.every(topic => topic in OPERATING_TOPICS)).toBe(true);
    }
  });
  it("prioritizes specific service economics and distinct client attribution", () => {
    expect(operatingTopicPriority("HR & Staffing", "website")[0]).toBe("workforce_billing");
    expect(operatingTopicPriority("Management Consulting", "website")[0]).toBe("project_financials");
    expect(operatingTopicPriority("Publishing", "website")[0]).toBe("media_rights");
    expect(operatingTopicPriority("Trucking, Moving & Storage", "website")[0]).toBe("fleet_costs");
    expect(businessServicesResearchContext("HR & Staffing")).toContain("Client vacancies are not");
    expect(businessServicesResearchContext("Management Consulting")).toContain("inside the consultancy");
    expect(businessServicesResearchContext("Law Firms & Legal Services")).toContain("client funds/trust accounting distinct");
  });
  it("reads real delivery and finance sources before generic site policies", () => {
    expect(researchSourcePriority("https://company.com/services/payroll", "HR & Staffing", ["workforce_billing"]))
      .toBeGreaterThan(researchSourcePriority("https://company.com/privacy", "HR & Staffing", ["workforce_billing"]));
    expect(researchSourcePriority("https://company.com/careers/controller", "Management Consulting", ["systems_project"]))
      .toBeGreaterThan(researchSourcePriority("https://company.com/careers/controller", "Management Consulting", ["media_rights"]));
    expect(researchSourcePriority("not a url", null, [])).toBe(0);
  });
});
