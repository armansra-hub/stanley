import { describe, expect, it } from "vitest";
import { extractGrowthSignals } from "./growth";
import { isRealCareersPage, scanFinanceRoles } from "./careers";

/** Every string below is real output from the 2026-07-30 full-TAM sweep, or real
 * page content fetched from the site that produced a bad signal. */
describe("extractGrowthSignals — marketing copy is not news", () => {
  it("rejects philosophical and aspirational copy", () => {
    // Lifework Systems scored "expansion announced" on this.
    expect(extractGrowthSignals(
      "What can we do to create a world in which, rather than systems that diminish people and demean the human spirit, each person is assisted in expanding into their wholeness?",
    )).toHaveLength(0);
    // Vivid Candi.
    expect(extractGrowthSignals(
      "Being an agency that dreams advertising, we relish the opportunity to expand into other industries. $1m-$50m+ national campaigns our agency delivers.",
    )).toHaveLength(0);
    // Manski Media.
    expect(extractGrowthSignals(
      "Your marketing should grow with it. We continue refining your strategy, expanding into new opportunities, increasing successful campaigns.",
    )).toHaveLength(0);
  });

  it("rejects a customer testimonial about the customer's own office", () => {
    // PROJECTUS scored "new location/office" on a review of its work.
    expect(extractGrowthSignals(
      "Great company to work with. Brad, Projectus just completed an install for us for our new office, they designed a complete sound masking system for our customers.",
    )).toHaveLength(0);
  });

  it("rejects an article about a different company", () => {
    // Texas News Express scored "expansion announced" on airline news it republished.
    expect(extractGrowthSignals(
      "American Airlines new flagship business-class suites are expanding to more routes this year.",
    )).toHaveLength(0);
  });

  it("rejects a historical self-description", () => {
    // QA Graphics — true years ago, not news.
    expect(extractGrowthSignals(
      "Since then, we have become the industry leader in BAS graphics and have expanded into a full-service design firm. Our interactive design team is ready to help you.",
    )).toHaveLength(0);
  });

  it("accepts a real, dated, located opening", () => {
    // Goranson Bain Ausley — the one true positive in the whole sweep.
    const hits = extractGrowthSignals(
      "Goranson Bain Ausley opens Flower Mound office to serve families across Denton County. The new office brings together attorneys with deep Denton County roots.",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("Flower Mound");
  });

  it("accepts an explicit announcement with a date", () => {
    const hits = extractGrowthSignals(
      "March 4, 2026 — Ajax Logistics announced it has opened a new warehouse in Reno, NV to serve the western region.",
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("careers page verification — the soft-404 problem", () => {
  const home = "All Access Accounting | Award-Winning Bookkeeping, Payroll & CFO Services in Pueblo CO. " +
    "We provide bookkeeping, payroll and CFO services to small businesses across Colorado. ".repeat(6);

  it("rejects a homepage served under /careers", () => {
    // allaccessaccounting.net/careers returned exactly this: no job content, and the
    // CFO mention is a service they sell.
    expect(isRealCareersPage(home, home)).toBe(false);
    expect(scanFinanceRoles(home, { homeText: home })).toHaveLength(0);
  });

  it("rejects a real careers page with no finance opening", () => {
    // advantexps.com/careers is a genuine careers page, but nothing finance is posted —
    // yet the sweep recorded "Hiring for Accounts Receivable".
    const page = "JOIN ADVANTEX. We are hiring across our service teams. Apply now. " +
      "Responsibilities include field service and customer support. Full-time positions available. ".repeat(4);
    expect(isRealCareersPage(page, home)).toBe(true);
    expect(scanFinanceRoles(page, { homeText: home })).toHaveLength(0);
  });

  it("accepts a genuine finance opening on a genuine careers page", () => {
    const page = "Careers at Ajax Freight. Open positions. We are hiring a Controller to own month-end close. " +
      "Job description: responsibilities include AP/AR oversight, month-end close, and reporting to the CEO. " +
      "Qualifications: 5 years experience, CPA preferred. Full-time, benefits include health and 401k. Apply now.";
    const roles = scanFinanceRoles(page, { homeText: home });
    expect(roles.map((r) => r.role)).toContain("Controller");
    expect(roles[0].snippet.length).toBeGreaterThan(20);
  });

  it("rejects role words that are the firm's own service offering", () => {
    const page = "Careers. Open positions. We are hiring! Apply now. Job description and qualifications below. " +
      "About us: we deliver outsourced CFO and bookkeeping services to growing companies.";
    expect(scanFinanceRoles(page, { homeText: home }).map((r) => r.role)).not.toContain("CFO");
  });

  it("rejects a page too short or with no job markers to be a careers page", () => {
    expect(isRealCareersPage("Contact us for opportunities.", home)).toBe(false);
    expect(isRealCareersPage("We are hiring. ".repeat(30), home)).toBe(false); // one marker only
  });
});
