import { describe, expect, it } from "vitest";
import { headlineIsAboutCompany } from "./sweep";

/** Every case below is a REAL headline from the 2026-07-30 full-TAM sweep. */
describe("headlineIsAboutCompany — noise found by reading real sweep output", () => {
  it("rejects a month name matching a date in the headline", () => {
    // "August" scored a finance_hire off V.F. Corporation's CFO announcement.
    expect(headlineIsAboutCompany("August",
      "V.F. Corporation Announces Chief Financial Officer Changes, Effective as of August 1, 2026 - marketscreener.com")).toBe(false);
  });

  it("rejects an ordinary English word used in its ordinary sense", () => {
    expect(headlineIsAboutCompany("Diagram",
      "Curant.ai Secures $3.1 Million Seed Round Led by Diagram to Power the Next Generation of AI for Insurance")).toBe(false);
    expect(headlineIsAboutCompany("Outpace", "Hush lands $30m as AI agents outpace enterprise security")).toBe(false);
    expect(headlineIsAboutCompany("Mineral", "FAST Metals Raises $4.3 Million and Commercializes Critical Mineral Recovery Technology")).toBe(false);
  });

  it("rejects our name being a substring of a LONGER company name", () => {
    expect(headlineIsAboutCompany("Jordan LLC",
      "Mindstream Energy d/b/a Mindstream Jordan LLC Expands Sovereign AI Platform")).toBe(false);
    expect(headlineIsAboutCompany("Point Partners", "Wind Point Partners Closes $3.2 Billion Fund XI")).toBe(false);
    expect(headlineIsAboutCompany("Family Farms", "Lipman Family Farms acquires SoCal repacker")).toBe(false);
  });

  it("still accepts a headline genuinely about the company", () => {
    expect(headlineIsAboutCompany("48North Partners",
      "48North Partners Expands Los Angeles Team With Five New Hires Amid Continued Growth")).toBe(true);
    expect(headlineIsAboutCompany("Midwest Energy",
      "Midwest Energy reshuffles board, appoints new CFO amid four resignations")).toBe(true);
    expect(headlineIsAboutCompany("Synaptiq",
      "Synaptiq Therapeutics Launches with Acquisition of Clinical-Stage SYN-001 Program")).toBe(true);
  });

  it("accepts a name after a connective or punctuation", () => {
    // "acquires"/"of" legitimately precede the subject; a bare word does not.
    expect(headlineIsAboutCompany("Acme Freight", "Blackstone acquires Acme Freight in $40M deal")).toBe(true);
    expect(headlineIsAboutCompany("Acme Freight", "Breaking: Acme Freight opens Dallas hub")).toBe(true);
  });

  it("still rejects names that are entirely generic business words", () => {
    expect(headlineIsAboutCompany("Strategic CFO", "Strategic CFO services expand nationwide")).toBe(false);
  });
});

describe("the left-edge guard must not eat normal headline grammar", () => {
  it("accepts a lowercase descriptor before the name", () => {
    expect(headlineIsAboutCompany("Acme Freight", "Texas company Acme Freight raises $5M Series A")).toBe(true);
    expect(headlineIsAboutCompany("Acme Freight", "Logistics provider Acme Freight names new CFO")).toBe(true);
  });

  it("accepts a hyphenated location descriptor", () => {
    expect(headlineIsAboutCompany("Acme Freight", "Dallas-based Acme Freight opens second hub")).toBe(true);
    expect(headlineIsAboutCompany("Acme Freight", "PE-backed Acme Freight acquires rival")).toBe(true);
  });

  it("still rejects a capitalised proper noun before the name", () => {
    expect(headlineIsAboutCompany("Jordan LLC", "Mindstream Energy d/b/a Mindstream Jordan LLC Expands Platform")).toBe(false);
    expect(headlineIsAboutCompany("Point Partners", "Wind Point Partners Closes $3.2 Billion Fund XI")).toBe(false);
  });
});

/**
 * Second audit pass (2026-08-10). These are verbatim rows that were sitting on the
 * live Triggered tab, each attributing another company's news to one of ours.
 */
describe("ordinary nouns as solo company names — the 2026-08-10 Triggered audit", () => {
  it("rejects a possessive use of a generic noun name", () => {
    // "The Brand" normalises to "brand", which then matched another brand's story.
    expect(headlineIsAboutCompany("The Brand",
      "BEING FRENSHE EXPANDS INTO CANADA, MARKING THE BRAND'S FIRST INTERNATIONAL RETAIL EXPANSION")).toBe(false);
    expect(headlineIsAboutCompany("The Brand",
      "Hands-On: ProTek Series 4000 Aggressor Dive Watches Expand The Brand's Identity")).toBe(false);
  });

  it("rejects ordinary-sense nouns", () => {
    expect(headlineIsAboutCompany("Access",
      "USDA awards $2.8M to expand public access to outdoor recreation in Pennsylvania")).toBe(false);
    expect(headlineIsAboutCompany("Bonanza",
      "Goliath Resources Confirms Bonanza & Golden Gate Expansion With 8.09 g/t AuEq Over 16m")).toBe(false);
    expect(headlineIsAboutCompany("Office",
      "State Treasurer's Office names new chief financial officer")).toBe(false);
  });

  it("still accepts a distinctive solo name in the same shape", () => {
    expect(headlineIsAboutCompany("ClimateDoor",
      "ClimateDoor Acquires Standard Demand Partners, Expanding Into the United States")).toBe(true);
  });
});
