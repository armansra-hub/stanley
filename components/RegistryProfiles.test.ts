import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RegistryProfiles from "./RegistryProfiles";
import { insightHeading, insightSourceLabel, type InsightBadge } from "@/lib/insights";
import { withInsights } from "@/lib/db/companies";

afterEach(() => vi.unstubAllGlobals());

function profile(): InsightBadge {
  return {
    source: "registry", kind: "ops_profile", label: "registry:fmcsa:12345", detail: null,
    evidence: "Acme Transport LLC operates 26 power units with 0 drivers reported.",
    evidence_url: "https://safer.fmcsa.dot.gov/query.asp?query_string=12345", confidence: "high",
    registry_profile: {
      version: 1, dataset: "fmcsa", recordId: "12345", displayLabel: "FMCSA carrier profile",
      sourceAsOf: "2026-08-02", observedAt: "2026-09-29T04:00:00Z",
      facts: [{ field: "power_units", label: "Power units", value: 26 }, { field: "drivers", label: "Drivers", value: 0 }],
      identity: { legalName: "Acme Transport LLC", addressLine1: "100 First Street", city: "Denver", state: "CO", postalCode: "80202" },
      provenance: { rowSha256: "a".repeat(64), quote: "Acme Transport LLC operates 26 power units with 0 drivers reported.", sourceRow: { dot_number: "12345" } },
      verification: { method: "exact_legal_name_address", verifiedAt: "2026-09-29T04:00:00Z", sourceIds: ["record-1"] },
    },
  };
}

function render(insights: InsightBadge[], loaded = true) {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(RegistryProfiles, { insights, loaded }));
}

describe("standing registry facts", () => {
  it("renders source dates, zero counts and original evidence without needing any trigger", () => {
    const html = render([profile()]);
    expect(html).toContain("FMCSA carrier profile");
    expect(html).toContain("Power units");
    expect(html).toContain(">26</dd>");
    expect(html).toContain("Drivers");
    expect(html).toContain(">0</dd>");
    expect(html).toContain("Aug 2, 2026");
    expect(html).toContain("Sep 29, 2026");
    expect(html).toContain("View public record source");
    expect(html).toContain("Acme Transport LLC operates 26 power units with 0 drivers reported.");
    expect(html).toContain("not total employee counts");
    expect(html).not.toContain("LinkedIn");
    expect(html).not.toContain("new growth");
  });

  it("keeps missing coverage and missing dates unknown rather than claiming no match", () => {
    expect(render([])).toContain("Registry coverage remains unknown");
    expect(render([])).not.toContain("No registry matches");
    expect(render([], false)).toBe("");
    const row = profile();
    row.registry_profile!.sourceAsOf = null;
    delete row.registry_profile!.displayLabel;
    delete row.registry_profile!.verification;
    expect(render([row])).toContain("Source as of: Date unavailable");
    expect(render([row])).toContain("not a claim that every registry has been checked");
    expect(render([row])).toContain("Identity verification details unavailable");
    expect(render([row])).not.toContain("Matched by legal name and business address");
  });

  it("keeps registry findings correctly labelled after the list projection", () => {
    const input = { id: "company-1", lead_insights: [profile()] };
    const result = withInsights(input);
    expect(result.rest).toEqual({ id: "company-1" });
    expect(result.insights[0].registry_profile).toEqual(input.lead_insights[0].registry_profile);
    expect(insightHeading(result.insights[0])).toBe("Public registry baseline — FMCSA carrier profile");
    expect(insightHeading({ ...profile(), source: "website", registry_profile: null, label: "Multi-location" })).toBe("Company website ops profile — Multi-location");
    expect(insightSourceLabel({ source: "linkedin", evidence_url: null })).toBe("LinkedIn");
    expect(insightSourceLabel({ evidence_url: "https://notlinkedin.com/company" })).toBe("Company research");
  });

  it("does not relabel source count categories as employees or expose unsafe source URLs", () => {
    const row = profile();
    row.evidence_url = "javascript:alert(1)";
    row.registry_profile!.facts = [{ field: "drivers", label: "Employees", value: 25, unit: "employees" },
      { field: "jobs_supported", label: "Employees", value: 90, unit: "employees" }];
    const html = render([row]);
    expect(html).toContain("Drivers");
    expect(html).toContain("Jobs supported");
    expect(html).not.toContain("Employees");
    expect(html).not.toContain("25 employees");
    expect(html).not.toContain("javascript:");
  });
});
