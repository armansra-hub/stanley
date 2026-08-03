import { describe, expect, it } from "vitest";
import { coerceBool, coerceDate, coerceList, coerceScore, pick } from "./coerce";
import { assessDigest, deriveOldGold, normalizeScoreBatch, normalizeScoreRow } from "./scores";
import { adjustScore, readVerdict } from "./adjust";

describe("coerceDate — the field that broke the 2026-07-15 import", () => {
  it("accepts the format the old validator wanted", () => {
    expect(coerceDate("2026-07-15")).toBe("2026-07-15");
  });

  it("accepts an OMITTED field — the actual bug (undefined !== null, so /regex/.test(undefined) failed)", () => {
    expect(coerceDate(undefined)).toBeNull();
    expect(coerceDate(null)).toBeNull();
    expect(coerceDate("")).toBeNull();
    expect(coerceDate("N/A")).toBeNull();
  });

  it("accepts US-style dates from the NetSuite UI and spreadsheets", () => {
    expect(coerceDate("7/15/2026")).toBe("2026-07-15");
    expect(coerceDate("07/05/2026")).toBe("2026-07-05");
    expect(coerceDate("7-15-26")).toBe("2026-07-15");
  });

  it("accepts ISO timestamps without drifting a day for readers west of UTC", () => {
    expect(coerceDate("2026-07-15T00:00:00Z")).toBe("2026-07-15");
    expect(coerceDate("2026-07-15 09:30:00")).toBe("2026-07-15");
  });

  it("accepts Excel/Sheets serial dates", () => {
    expect(coerceDate(46218)).toBe("2026-07-15");
    expect(coerceDate("46218")).toBe("2026-07-15");
  });

  it("accepts month names", () => {
    expect(coerceDate("Jul 15, 2026")).toBe("2026-07-15");
  });

  it("reports unreadable values instead of guessing", () => {
    expect(coerceDate("Superior Health Holdings")).toBeUndefined();
    expect(coerceDate("13/45/2026")).toBeUndefined();
    expect(coerceDate(42)).toBeUndefined();
  });
});

describe("coerceScore / coerceBool / coerceList", () => {
  it("reads scores in the shapes agents and spreadsheets emit", () => {
    expect(coerceScore(12)).toBe(12);
    expect(coerceScore("12")).toBe(12);
    expect(coerceScore("12%")).toBe(12);
    expect(coerceScore(9.55)).toBe(9.6);
    expect(coerceScore("")).toBeNull();
    expect(coerceScore(101)).toBeUndefined();
    expect(coerceScore(-1)).toBeUndefined();
    expect(coerceScore("high")).toBeUndefined();
  });

  it("reads booleans loosely", () => {
    for (const v of [true, "true", "TRUE", "yes", "Y", 1, "1"]) expect(coerceBool(v)).toBe(true);
    for (const v of [false, "false", "no", 0, "0"]) expect(coerceBool(v)).toBe(false);
    expect(coerceBool("")).toBeNull();
    expect(coerceBool("perhaps")).toBeUndefined();
  });

  it("reads lists as arrays, JSON, or delimited text", () => {
    expect(coerceList(["a", "b"])).toEqual(["a", "b"]);
    expect(coerceList('["a","b"]')).toEqual(["a", "b"]);
    expect(coerceList("a | b | c")).toEqual(["a", "b", "c"]);
    expect(coerceList("")).toEqual([]);
  });

  it("matches field names regardless of case, spaces, and separators", () => {
    expect(pick({ "Internal ID": "123" }, "internalId")).toBe("123");
    expect(pick({ internal_id: "123" }, "internalId")).toBe("123");
    expect(pick({ nsid: "123" }, "internalId", "nsid")).toBe("123");
    expect(pick({ other: "x" }, "internalId")).toBeUndefined();
  });
});

describe("normalizeScoreRow", () => {
  it("accepts a minimal row — only id and score are required", () => {
    const r = normalizeScoreRow({ internalId: "92847818", tamScore: 12 }, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.internalId).toBe("92847818");
      expect(r.row.tamScore).toBe(12);
      expect(r.row.revisitOn).toBeNull();
      // null, NOT false — an unmentioned field must not un-kill a dead lead.
      expect(r.row.recordDead).toBeNull();
    }
  });

  it("accepts the alias spellings a CSV export produces", () => {
    const r = normalizeScoreRow({ "Internal ID": "92847818", Score: "8", digest: "thin record", dead: "no" }, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.recordDigest).toBe("thin record");
  });

  it("names the field and shows the value when a row is unusable", () => {
    const r = normalizeScoreRow({ internalId: "abc", tamScore: 500, revisitOn: "someday" }, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.field).sort()).toEqual(["internalId", "revisitOn", "tamScore"]);
      expect(r.errors.every((e) => e.index === 3)).toBe(true);
      expect(r.errors.find((e) => e.field === "tamScore")?.received).toBe("500");
    }
  });

  it("keeps good rows when a neighbour is bad — the all-or-nothing failure that killed the last import", () => {
    const batch = normalizeScoreBatch([
      { internalId: "1", tamScore: 5 },
      { internalId: "2", tamScore: 9, revisitOn: "garbage" }, // the poison row
      { internalId: "3", tamScore: 12 },
    ]);
    expect(batch.rows.map((r) => r.internalId)).toEqual(["1", "3"]);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0].internalId).toBe("2");
  });

  it("takes the last grade on a duplicate id, and reports the collision", () => {
    const batch = normalizeScoreBatch([
      { internalId: "7", tamScore: 5 },
      { internalId: "7", tamScore: 40 },
    ]);
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0].tamScore).toBe(40);
    expect(batch.duplicates).toEqual(["7"]);
  });
});

describe("deriveOldGold", () => {
  it("derives oldgold only for rows that are genuinely Old Gold", () => {
    expect(deriveOldGold(55, { qual_note: "prior eval", last_sql_date: "2026-02-01" })).toBe(55);
    expect(deriveOldGold(55, { qual_note: "prior eval" })).toBeNull();      // no SQL date
    expect(deriveOldGold(55, { last_sql_date: "2026-02-01" })).toBeNull();  // no qual note
    expect(deriveOldGold(55, {})).toBeNull();
  });

  it("accepts a last-SQL date supplied by the push when the row lacks one", () => {
    expect(deriveOldGold(55, { qual_note: "prior eval" }, "2026-02-01")).toBe(55);
  });

  it("includes an exact audited opportunity-backed lead without a qual-note/SQL pair", () => {
    expect(deriveOldGold(67, {}, null, "Opportunity confirmed: 2025-04-03 — creation date not exposed; #12345 Example ERP.")).toBe(67);
    expect(deriveOldGold(61, { record_digest: "Opportunity created: 2024-09-12 — #98765 Example ERP." })).toBe(61);
  });

  it("does not grant Old Gold membership for generic opportunity prose", () => {
    expect(deriveOldGold(67, {}, null, "This may be a good opportunity someday.")).toBeNull();
    expect(deriveOldGold(67, {}, null, "No Opportunity status was selected.")).toBeNull();
  });
});

describe("adjustScore — external intelligence stays out of TAM and Old Gold", () => {
  const today = new Date("2026-07-27T00:00:00Z");
  const fresh = (type: string) => ({ type, signal_date: "2026-07-20", half_life_days: 30 });

  it("ignores triggers, headcount, PE, and competitor ERP when returning the grade", () => {
    const many = ["funding", "ma", "finance_hire", "federal_award"].map(fresh);
    const r = adjustScore(37, { headcount_growth_pct: 400, pe_owned: true, erp_incumbent: "intacct" }, many, today);
    expect(r).toMatchObject({ score: 37, bump: 0, penalty: 0, reasons: [], note: "" });
  });

  it("keeps record-derived hard zeros", () => {
    expect(adjustScore(80, { record_dead: true }, [fresh("funding")], today).score).toBe(0);
    expect(adjustScore(80, { erp_incumbent: "netsuite" }, [fresh("funding")], today).score).toBe(0);
  });

  it("preserves an ordinary raw grade exactly", () => {
    const r = adjustScore(9, {}, [], today);
    expect(r.score).toBe(9);
    expect(r.bump).toBe(0);
  });
});

describe("adjustScore — a graded zero is decisive", () => {
  const today = new Date("2026-07-27T00:00:00Z");
  it("never lets outside signals resurrect a lead graded 0", () => {
    const r = adjustScore(0, { pe_owned: true, headcount_growth_pct: 400 },
      [{ type: "funding", signal_date: "2026-07-25", half_life_days: 30 }], today);
    expect(r.score).toBe(0);
    expect(r.bump).toBe(0);
    expect(r.note).toContain("decisive");
  });

  it("also preserves a lead graded even slightly above zero", () => {
    expect(adjustScore(1, { pe_owned: true }, [], today).score).toBe(1);
  });
});

describe("assessDigest — is a grade's rationale checkable?", () => {
  it("accepts a digest citing something concrete", () => {
    expect(assessDigest('Spoke 4/28/26; CFO Ken says "we are staying on QuickBooks" until $5M.').auditable).toBe(true);
    expect(assessDigest("Runs Sage Intacct across 3 entities; 40 employees.").markers).toContain("system");
  });

  it("rejects the categorical template that carries no checkable fact", () => {
    const boiler = "Score 27/100: current evidence points to disqualification, poor timing, or a low " +
      "probability of an ERP close. Finance: Not confirmed. Budget: Capacity plausible; budget not " +
      "confirmed. No reliable current six-month buying window was found.";
    expect(assessDigest(boiler).auditable).toBe(false);
    expect(assessDigest(boiler).markers).toEqual([]);
  });

  it("treats a missing or trivial digest as unauditable", () => {
    expect(assessDigest(null).auditable).toBe(false);
    expect(assessDigest("thin record").auditable).toBe(false);
  });
});

describe("assessDigest reads the whole rationale, not one field", () => {
  const boiler = "Score 53/100: some historical fit or pain exists, but current budget, finance " +
    "ownership, timing, or interest is weak. Finance: Confirmed in-house. Budget: Not confirmed.";

  it("credits sourced oldGoldReasons that the digest itself lacks", () => {
    // Real shape from Optimal Edge Consulting, which a digest-only check wrongly called unsupported.
    const reasons = ["an acquisition, merger, or ownership event creates a change window [NEED_NOTE (saved-search row 1), 2026-04-20]"];
    expect(assessDigest(boiler).auditable).toBe(false);
    expect(assessDigest(boiler, reasons).auditable).toBe(true);
    expect(assessDigest(boiler, reasons).markers).toContain("citation");
  });

  it("still reports a row with template digest and nothing else", () => {
    expect(assessDigest(boiler, []).auditable).toBe(false);
    expect(assessDigest(boiler, ["[COMMENTS] # 8 employees"]).markers).toContain("headcount");
  });
});

describe("readVerdict maps the grader's own declared bands", () => {
  it("reads all three canned verdicts", () => {
    expect(readVerdict(27, "Score 27/100: current evidence points to disqualification, poor timing, or a low probability of an ERP close.")).toBe("disqualified");
    expect(readVerdict(53, "Score 53/100: some historical fit or pain exists, but current budget, finance ownership, timing, or interest is weak.")).toBe("weak");
    expect(readVerdict(60, "Score 60/100: credible ERP potential, but one or more closing requirements remain unconfirmed.")).toBe("viable");
  });

  it("falls back to the score band only when no verdict was declared", () => {
    expect(readVerdict(45, "2-year Idaho flatbed carrier with a brand-new CFO, Peter Diehl")).toBe("viable");
    expect(readVerdict(9, null)).toBe("weak");
  });

  it("an explicit verdict from the grader still wins", () => {
    expect(readVerdict(9, "…points to disqualification…", "viable")).toBe("viable");
  });
});
