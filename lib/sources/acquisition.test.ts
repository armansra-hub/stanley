import { describe, expect, it } from "vitest";
import { extractAcquisitions } from "./acquisition";

describe("extractAcquisitions", () => {
  it("fires on a real acquirer-position announcement with a named target", () => {
    const hits = extractAcquisitions(
      "Big news for our clients: Netgain Property Management has acquired Secure Property Management, expanding our service area to nine Utah counties.",
      "Netgain Property Management",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].target).toBe("Secure Property Management");
    expect(hits[0].snippet).toContain("has acquired Secure Property Management");
  });

  it("fires on 'completed the acquisition of X' and 'we've acquired X'", () => {
    expect(extractAcquisitions("This month we completed the acquisition of Tactical Safety Solutions LLC.")[0].target)
      .toBe("Tactical Safety Solutions LLC");
    expect(extractAcquisitions("We’ve acquired C2 Group to expand our paid-media practice.")[0].target).toBe("C2 Group");
  });

  it("ignores talent/customer/data acquisition copy", () => {
    expect(extractAcquisitions("Our talent acquisition of Top Performers is unmatched.")).toHaveLength(0);
    expect(extractAcquisitions("We drive the acquisition of New Customers at scale.")).toHaveLength(0);
  });

  it("ignores M&A-advisory / brokerage service copy (the Agenda Health case)", () => {
    expect(
      extractAcquisitions(
        "As home health care brokers we specialize in the acquisition of Home Health Agencies for our buyers and sellers.",
      ),
    ).toHaveLength(0);
    expect(
      extractAcquisitions("Our consultants advise on every acquisition of Middle Market Companies, helping owners exit."),
    ).toHaveLength(0);
  });

  it("ignores being acquired (parent detection's job) and unnamed targets", () => {
    expect(extractAcquisitions("We were proud to be acquired by MegaCorp after our acquisition of top engineering talent.")).toHaveLength(0);
    expect(extractAcquisitions("has acquired several new locations this year")).toHaveLength(0);
  });

  it("returns nothing on bare category words (the old false-fire shape)", () => {
    expect(extractAcquisitions("Read our latest news: acquisition of; joined forces with; growth stories.")).toHaveLength(0);
  });

  it("ignores third-party deal NEWS about other companies (the homehealthcarebrokers case)", () => {
    // Real snippets from a broker's industry-news blog — the subject is another company.
    const news =
      "Superior Health Holdings (Superior), a portfolio company of Renovus Capital Partners, today announced the acquisition of Chant Healthcare Services. " +
      "In other news, Already Autism Health has acquired Commonwealth ABA to expand its footprint.";
    expect(extractAcquisitions(news, "Agenda Health")).toHaveLength(0);
    // Same text on the ACQUIRER'S OWN site still fires (subject matches the company).
    const own = extractAcquisitions(news, "Already Autism Health");
    expect(own).toHaveLength(1);
    expect(own[0].target).toBe("Commonwealth ABA");
    // Third-person with no company name to verify against → suppressed, not guessed.
    expect(extractAcquisitions("Acme Corp has acquired Beta Industries this week.")).toHaveLength(0);
  });

  it("dedupes and caps at two", () => {
    const hits = extractAcquisitions(
      "We acquired Alpha Co in March. Later we acquired Alpha Co again per the press. We acquired Beta LLC too. We acquired Gamma Inc as well.",
    );
    expect(hits.map((h) => h.target)).toEqual(["Alpha Co", "Beta LLC"]);
  });
});
