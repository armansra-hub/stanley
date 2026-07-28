import { describe, expect, it } from "vitest";
import { coerceBool, coerceDate, coerceList, coerceScore, pick } from "./coerce";
import { applyScoringLaw, normalizeScoreBatch, normalizeScoreRow } from "./scores";

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
      expect(r.row.recordDead).toBe(false);
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

describe("applyScoringLaw — rules a pushed grade cannot override", () => {
  const row = { internalId: "1", tamScore: 55, oldGoldClass: null, oldGoldReasons: [], recordDigest: null,
    recordDead: false, recordDeadReason: null, revisitOn: null, qualNote: null, lastSqlDate: null };

  it("forces dead records to zero", () => {
    const r = applyScoringLaw({ ...row, recordDead: true, recordDeadReason: "not interested" }, {});
    expect(r.tamScore).toBe(0);
    expect(r.hardZeroReason).toContain("not interested");
  });

  it("forces NetSuite incumbents to zero", () => {
    expect(applyScoringLaw(row, { erp_incumbent: "netsuite" }).tamScore).toBe(0);
  });

  it("derives oldgold only for rows that are genuinely Old Gold", () => {
    expect(applyScoringLaw(row, { qual_note: "prior eval", last_sql_date: "2026-02-01" }).oldGoldScore).toBe(55);
    expect(applyScoringLaw(row, { qual_note: "prior eval" }).oldGoldScore).toBeNull();   // no SQL date
    expect(applyScoringLaw(row, { last_sql_date: "2026-02-01" }).oldGoldScore).toBeNull(); // no qual note
    expect(applyScoringLaw(row, {}).oldGoldScore).toBeNull();
  });

  it("zeroes the old gold score too when the record is dead", () => {
    const r = applyScoringLaw({ ...row, recordDead: true }, { qual_note: "x", last_sql_date: "2026-02-01" });
    expect(r.oldGoldScore).toBe(0);
  });
});
