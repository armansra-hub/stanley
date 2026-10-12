import { describe, expect, it, vi } from "vitest";
import { oraclePartnershipSearchPlan } from "./oraclePartnershipQueries";
import { hasOraclePartnershipPassage, isOraclePartnershipSourceUrl } from "@/lib/intelligence/oraclePartnership";

describe("Oracle partnership discovery preparation", () => {
  it("plans bounded company-specific news and LinkedIn searches without I/O", () => {
    const fetch = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const plan = oraclePartnershipSearchPlan({ name: "Acme Energy", domain: "https://www.acme.example/" });
      expect(plan.execution).toBe("manual_only");
      expect(plan.news).toHaveLength(2);
      expect(plan.news[0].query).toContain('"Acme Energy" Oracle');
      expect(plan.news[1].query).toContain('"acme.example" Oracle');
      expect(new URL(plan.news[0].url).searchParams.get("q")).toBe(plan.news[0].query);
      expect(new URL(plan.linkedin.url).searchParams.get("keywords")).toBe("Acme Energy Oracle partnership");
      expect(plan.linkedin.publicSearchQuery).toContain('site:linkedin.com "Acme Energy"');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not invent a domain or allow a quoted name to escape its phrase", () => {
    expect(oraclePartnershipSearchPlan({ name: 'Acme" OR "Other\nCompany', domain: "https://user:password@example.com" }).news)
      .toEqual([expect.objectContaining({ query: expect.stringContaining('"Acme OR Other Company" Oracle') })]);
    expect(() => oraclePartnershipSearchPlan({ name: "  " })).toThrow("Company name");
  });
  it.each(["Acme partnered with Oracle to launch a joint initiative.", "Acme joined OraclePartnerNetwork."])("admits necessary passage syntax: %s", text => {
    expect(hasOraclePartnershipPassage(text)).toBe(true);
  });
  it.each(["Acme uses Oracle Cloud.", "Acme partnered with Microsoft.", "We hired a former Oracle employee.", "Oracle expertise required."])("rejects insufficient passage syntax: %s", text => {
    expect(hasOraclePartnershipPassage(text)).toBe(false);
  });
  it.each(["https://www.linkedin.com/posts/acme_oracle-partnership-activity-123", "https://www.linkedin.com/feed/update/urn:li:activity:123456/", "https://acme.example/news/oracle-alliance"])("accepts concrete source %s", url => {
    expect(isOraclePartnershipSourceUrl(url)).toBe(true);
  });
  it.each(["https://www.linkedin.com/search/results/content/?keywords=Oracle", "https://www.linkedin.com/company/acme", "https://acme.example/#Oracle", "https://www.google.com/search?q=Oracle", "https://news.google.com/rss/articles/example", "https://acme.example/", "javascript:alert(1)"])("rejects discovery or non-original source %s", url => {
    expect(isOraclePartnershipSourceUrl(url)).toBe(false);
  });
});
