import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerMatchAccount } from "@/lib/intelligence/customerMatches";
import OperatingMatches from "./OperatingMatches";
import { CustomerMatchCard, customerMatchesWithStatus } from "./RecentCustomerMatches";
import CustomerReferenceProgress from "./CustomerReferenceProgress";

const makeAccount = (): CustomerMatchAccount => ({
  companyId: "prospect-1", name: "Prospect Integrator", domain: "https://www.prospect.example/services", subindustry: "IT services",
  internalId: "123", status: "new", primaryPattern: { id: "integrators", label: "IT, AV and security integrators", branchId: "it-integrators", branchLabel: "Equipment, installation and support" },
  otherPatterns: [{ id: "field-service", label: "Equipment and field-service operators" }],
  reference: {
    id: "customer-1", name: "Customer Integrator", domain: "customer.example", website: "https://customer.example", announcementDate: "2026-07-31",
    announcementType: "new_customer", recent: true, ageDays: 59, sources: [{ url: "https://customer.example/services", title: "Customer services", contentHash: "customer-hash", text: "We install equipment and provide ongoing support." }],
    sharedTraits: [{ id: "rr_c01", label: "Equipment, installation and ongoing service" }],
    sharedTraitSources: [{ traitId: "rr_c01", urls: ["https://customer.example/services"] }],
    sharedNativeAnswers: [{ traitId: "rr_c01", nativeResult: { answer: { type: "choice", choice: "supported" }, source: "customer-native-receipt" } }],
    unknownTraits: [{ id: "rr_c05", label: "Works across customer sites" }],
    differentTraits: [{ id: "rr_c06", label: "Operates several businesses" }],
  },
  fit: { label: "Evidence-backed operating resemblance", explanation: "Ordered by the documented operating combination and the reference date.", rarity: { matched: 20, assessed: 150 }, industryBasis: "Shared operating facts." },
  whyNow: [],
  topics: [{ id: "rr_c01", label: "Equipment, installation and ongoing service", state: "supported", classification: "native_choice",
    nativeResult: { type: "choice", choice: "supported" }, sources: [{ observationId: "obs-1", url: "https://prospect.example/services", title: "Prospect services", sourceKind: "website", eventDate: null,
      observedAt: "2026-09-28T12:00:00Z", probability: null, companyRelevance: null, contextPreview: "Our team installs systems and supports them.", previewTruncated: false, start: 0, end: 48 }] }],
});

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("recent-customer shortlist", () => {
  it("starts with customer patterns while leaving the complete advanced library collapsed", () => {
    const markup = renderToStaticMarkup(React.createElement(OperatingMatches, { enabled: true }));
    expect(markup).toContain("Similar to recent customers");
    expect(markup).toContain("All characteristics");
    expect(markup).toContain("47 categories · 22 existing traits · 10 research combinations");
    expect(markup).not.toContain("Filter operating categories");
    expect(markup).not.toContain("count unavailable");
    expect(markup).not.toContain("Choose up to 8 traits");
  });

  it("keeps a dismissal applied when a stale page arrives, with an exact rollback and restore", () => {
    const account = makeAccount();
    expect(customerMatchesWithStatus([account], { "prospect-1": "dismissed" }, false)).toEqual([]);
    expect(customerMatchesWithStatus([account], {}, false)).toEqual([account]);
    expect(customerMatchesWithStatus([{ ...account, status: "dismissed" }], { "prospect-1": "new" }, false)[0].status).toBe("new");
    expect(account.status).toBe("new");
  });

  it("keeps one card per company across patterns and respects shared hidden statuses", () => {
    const account = makeAccount();
    const rows = [account, { ...account }, { ...account, companyId: "reviewed", status: "reviewed" }, { ...account, companyId: "exported", status: "exported_batch" }];
    expect(customerMatchesWithStatus(rows, {}, false)).toHaveLength(1);
    expect(customerMatchesWithStatus(rows, {}, true)).toHaveLength(3);
  });

  it("retains in-record opening, quick-copy controls, selection and dismissal", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, {
      account: makeAccount(), selected: true, statusBusy: false, onOpenAccount: vi.fn(), onSelect: vi.fn(), onStatus: vi.fn(),
    }));
    expect(markup).toContain('aria-label="Select Prospect Integrator"');
    expect(markup).toContain('aria-label="Copy company name"');
    expect(markup).toContain('aria-label="Copy website"');
    expect(markup).toContain('aria-label="Dismiss Prospect Integrator"');
    expect(markup).toContain("prospect.example");
    expect(markup).not.toContain('href="/headhunter/intelligence?companyId=');
    expect(markup).toContain("Also: Equipment and field-service operators");
  });

  it("makes both companies' actual source wording and attribution accessible", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account: makeAccount(), selected: false, statusBusy: false }));
    expect(markup).toContain("See the evidence on both companies");
    expect(markup).toContain('aria-label="Customer source 1 for Equipment, installation and ongoing service"');
    expect(markup).toContain('aria-label="Prospect source 1 for Equipment, installation and ongoing service"');
    expect(markup).toContain('href="https://customer.example/services"');
    expect(markup).toContain('href="https://prospect.example/services"');
    expect(markup).toContain("We install equipment and provide ongoing support.");
    expect(markup).toContain("Our team installs systems and supports them.");
    expect(markup).toContain("Raw Jev answer");
    expect(markup).toContain("Raw Jev answers · customer");
    expect(markup).toContain("customer-native-receipt");
    expect(markup).toContain("New customer announcement: ");
    expect(markup).toContain("Jul 31, 2026");
    expect(markup).toContain("Recent customer example");
  });

  it("labels an older comparison as historical while keeping its exact announcement date", () => {
    const account = makeAccount();
    account.reference = { ...account.reference, recent: false, ageDays: 365, announcementDate: "2025-09-28" };
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: false }));
    expect(markup).toContain("Historical customer comparison");
    expect(markup).toContain("Sep 28, 2025");
    expect(markup).not.toContain("Recent customer example");
  });

  it("separates unknowns and documented differences from a reason to act now", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account: makeAccount(), selected: false, statusBusy: false }));
    expect(markup).toContain("Operating fit");
    expect(markup).toContain("Why now");
    expect(markup).toContain("No recent, dated buying signal");
    expect(markup).toContain("Not established for this prospect:");
    expect(markup).toContain("Known differences:");
    expect(markup).toContain("not a win rate");
  });

  it("uses the timing event's date and source without substituting capture time", () => {
    const account = makeAccount();
    account.whyNow = [{ id: "event-1", label: "Acquired a regional operator", eventDate: "2026-08-15", sourceUrl: "https://prospect.example/acquisition" }];
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: false }));
    expect(markup).toContain("Acquired a regional operator");
    expect(markup).toContain("Event: Aug 15, 2026");
    expect(markup).toContain('href="https://prospect.example/acquisition"');
    expect(markup).not.toContain("No recent, dated buying signal");
  });

  it("offers restore for hidden accounts and blocks write controls during a save", () => {
    const account = { ...makeAccount(), status: "dismissed" };
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: true, onStatus: vi.fn(), onSelect: vi.fn() }));
    expect(markup).toContain('aria-label="Restore Prospect Integrator"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps customer reading an explicit action separate from viewing saved results", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceProgress, { enabled: true, onComplete: vi.fn() }));
    expect(markup).toContain("Customer reference sources");
    expect(markup).toContain("the same 47 characteristics used for prospects");
    expect(markup).toContain("does not start paid research");
    expect(markup).not.toContain("Reading customer websites…");
  });
});
