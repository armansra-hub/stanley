import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerMatchAccount } from "@/lib/intelligence/customerMatches";
import OperatingMatches from "./OperatingMatches";
import { CustomerMatchCard, CustomerReferenceCoverage, CustomerCohortCounts, customerMatchesWithStatus, customerMatchesNeedRefresh } from "./RecentCustomerMatches";
import CustomerReferenceProgress, { CustomerReferenceProgressRow } from "./CustomerReferenceProgress";
import { summarizeCustomerCohort } from "@/lib/intelligence/customerCohortSummary";
import { OPERATING_FACETS } from "@/lib/intelligence/operatingCatalog";

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
  it.each(["typesafe_timeout", "typesafe_http_520"])("explains a held provider failure without claiming zero billing (%s)", lastError => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceProgressRow, { reference: {
      id: "failed", name: "Customer", website: "https://customer.example", status: "blocked", answered: 2, totalQuestions: 47, lastError,
    } }));
    expect(markup).toContain("Stanley will not automatically resend it");
    expect(markup).toContain("2/47 characteristics answered");
    expect(markup).not.toContain("charged again");
  });
  it("labels incomplete website analysis while accepting Slack-established customer status", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceCoverage, {
      coverage: { verified: 18, pending: 805, total: 823, asOf: "2026-09-28" },
      progress: { total: 823, complete: 18, pending: 796, blocked: 9, running: 0 },
    }));
    expect(markup).toContain("Saved Jev question sets: 18 of 823 customer records answered");
    expect(markup).toContain("Slack establishes that these companies are customers");
    expect(markup).toContain("source gaps, not questions about customer status");
    expect(markup).toContain("partial customer cohort");
    expect(markup).toContain("legacy Jev completion is not substituted for it");
    expect(markup).toContain("existing 47 definitions are the legacy library");
    expect(markup).toContain("do not mean every website page was researched");
    expect(markup).not.toContain("more need supporting website evidence");
  });

  it("requests a new match snapshot only when completed readings increase", () => {
    expect(customerMatchesNeedRefresh(18, 18)).toBe(false);
    expect(customerMatchesNeedRefresh(18, 17)).toBe(false);
    expect(customerMatchesNeedRefresh(18, 19)).toBe(true);
    expect(customerMatchesNeedRefresh(0, 1)).toBe(true);
  });
  it("separates authored site research from legacy answer counts and preserves source gaps", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceCoverage, {
      coverage: { verified: 76, pending: 747, total: 823, asOf: "2026-09-28" },
      research: { available: true, progress: { total: 823, started: 8, notStarted: 815, draft: 0, inProgress: 2,
        complete: 3, completeWithGaps: 3, unresolved: 0, facts: 61, readPages: 80, pendingPages: 200, unreadPages: 100,
        unavailablePages: 9, latestUpdatedAt: "2026-09-29T20:00:00Z", origin: "codex_research", providerCalls: 0 } },
    }));
    expect(markup).toContain("Saved Jev question sets: 76 of 823");
    expect(markup).toContain("New Codex website research: 3 complete · 3 reviewed with source gaps · 0 unresolved · 2 in progress · 815 not started");
    expect(markup).toContain("Unresolved records do not count as researched examples");
    expect(markup).toContain("80 pages read");
    expect(markup).toContain("revised categories are not active yet");
    expect(markup).not.toContain("76 complete · 3 reviewed");
  });

  it("refreshes for newly saved partial answers, but not unchanged mapping or source progress", () => {
    expect(customerMatchesNeedRefresh(38, 38, 1000, 1005)).toBe(true);
    expect(customerMatchesNeedRefresh(38, 38, 1005, 1005)).toBe(false);
    expect(customerMatchesNeedRefresh(38, 38, 1005, 1000)).toBe(false);
  });

  it("keeps completed coverage separate from usable partial readings", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceCoverage, {
      coverage: { verified: 38, partial: 2, usable: 40, pending: 785, total: 823, asOf: "2026-09-28" },
    }));
    expect(markup).toContain("Saved Jev question sets: 38 of 823 customer records answered");
    expect(markup).toContain("38 complete and 2 partial legacy question sets");
    expect(markup).toContain("2 partial readings are not included in the completed question-set count");
    expect(markup).toContain("unanswered characteristics stay unanswered");
    expect(markup).not.toContain("Website analysis complete: 40");
  });

  it("renders every existing category with separate native unknown and conflict counts", () => {
    const cohort = summarizeCustomerCohort([{ id: "reference", name: "Reference", domain: "reference.example", website: "https://reference.example",
      announcementDate: "2026-09-01", announcementType: "new_customer", catalogVersion: "catalog", completedAt: "2026-09-28", status: "verified", sources: [],
      answers: Object.fromEntries(OPERATING_FACETS.map(facet => [facet.id, { decision: "insufficient_evidence", nativeResult: {}, facetVersion: "version", sourceUrls: [] }])) }], Date.parse("2026-09-29"));
    const markup = renderToStaticMarkup(React.createElement(CustomerCohortCounts, { cohort }));
    expect(markup).toContain("1 customer references in this match snapshot: 1 complete and 0 partial");
    expect(markup).toContain("not the full registry or the original 704 research entries");
    expect(markup).toContain("Insufficient evidence"); expect(markup).toContain("Conflicting"); expect(markup).toContain("Unanswered");
    expect(markup.match(/<tr /g)).toHaveLength(48);
    expect(markup).toContain("Industry not recorded");
  });

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

  it("separates a saved non-asset qualification from the customer's shared operating traits", () => {
    const account = makeAccount();
    account.nonAsset3pl = {
      id: "non_asset_3pl", label: "Non-asset-based 3PL", state: "supported", classification: "native_choice",
      nativeResult: { answer: { type: "choice", choice: "supported" }, source: "saved-non-asset-receipt" },
      sources: [{ ...account.topics[0].sources[0], url: "https://prospect.example/non-asset", title: "Our logistics model",
        contextPreview: "We are a non-asset-based 3PL and use independent carriers.", previewTruncated: false }],
    };
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: false }));
    expect(markup).toContain('aria-label="Prospect non-asset-based 3PL qualification"');
    expect(markup).toContain("Saved Jev evidence for this prospect; customer comparison below covers shared services, not assumed customer asset ownership.");
    expect(markup).toContain('href="https://prospect.example/non-asset"');
    expect(markup).toContain("We are a non-asset-based 3PL and use independent carriers.");
    expect(markup).toContain("Raw Jev answer · prospect qualification");
    expect(markup).toContain("saved-non-asset-receipt");
    expect(markup).not.toContain('aria-label="Customer source 1 for Non-asset-based 3PL"');
    expect(markup).toContain('aria-label="Customer source 1 for Equipment, installation and ongoing service"');
  });

  it("does not attach a non-asset qualification to other customer matches", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account: makeAccount(), selected: false, statusBusy: false }));
    expect(markup).not.toContain("Prospect non-asset-based 3PL qualification");
    expect(markup).not.toContain("Raw Jev answer · prospect qualification");
  });

  it("labels an older comparison as historical while keeping its exact announcement date", () => {
    const account = makeAccount();
    account.reference = { ...account.reference, recent: false, ageDays: 365, announcementDate: "2025-09-28" };
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: false }));
    expect(markup).toContain("Historical customer comparison");
    expect(markup).toContain("Sep 28, 2025");
    expect(markup).not.toContain("Recent customer example");
  });

  it.each(["typesafe_context_limit", "customer_context_relevant_evidence_still_large"])("explains a partially read customer's size hold (%s)", lastError => {
    const account = makeAccount();
    account.reference.reading = { status: "blocked", answered: 46, total: 47, lastError, updatedAt: "2026-09-29" };
    const markup = renderToStaticMarkup(React.createElement(CustomerMatchCard, { account, selected: false, statusBusy: false }));
    expect(markup).toContain("Partial legacy question set · 46/47 characteristics answered");
    expect(markup).toContain("remaining source text does not fit the current request size limit");
    expect(markup).toContain("Every required trait below is already supported");
    expect(markup).toContain("Raw Jev answers · customer");
    expect(markup).not.toContain("Complete legacy question set");
  });

  it("keeps a blocked 43-answer progress row visibly partial with its saved work retained", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceProgressRow, { reference: {
      id: "held-customer", name: "Held Customer", website: "https://customer.example", status: "blocked", answered: 43, totalQuestions: 47,
      lastError: "typesafe_http_422", sourceGaps: 2,
    } }));
    expect(markup).toContain("Partial reading · 43/47 characteristics answered");
    expect(markup).toContain("provider could not process the remaining reading request");
    expect(markup).toContain("2 source gaps retained");
    expect(markup).not.toContain("Complete ·");
  });

  it.each(["reference_continuation", "source_continuation"])("describes %s as saved continuation rather than a failure", lastError => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceProgressRow, { reference: {
      id: "continuing-customer", name: "Continuing Customer", website: "https://customer.example", status: "pending", answered: 5, totalQuestions: 47, lastError,
    } }));
    expect(markup).toContain("Partial reading · 5/47 characteristics answered");
    expect(markup).toContain("The legacy reading stopped at a saved checkpoint");
    expect(markup).not.toContain("needs attention");
    expect(markup).not.toContain("could not be read");
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

  it("keeps saved customer evidence available without offering retired paid reading", () => {
    const markup = renderToStaticMarkup(React.createElement(CustomerReferenceProgress, { enabled: true, onComplete: vi.fn() }));
    expect(markup).toContain("Saved customer reference sources");
    expect(markup).toContain("without paid Jev calls");
    expect(markup).toContain("This list is read-only");
    expect(markup).not.toContain("Read all customer websites");
    expect(markup).not.toContain("Continue all unread customers");
    expect(markup).not.toContain("Reading customer websites…");
  });
});
