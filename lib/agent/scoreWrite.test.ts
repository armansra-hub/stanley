import { describe, expect, it } from "vitest";
import type { NormalizedScoreRow } from "./scores";
import { deriveStoredScores, effectiveRecordDeadReason, isRetiredTamDuplicate } from "./scoreWrite";

const row = (overrides: Partial<NormalizedScoreRow> = {}): NormalizedScoreRow => ({
  internalId: "123",
  tamScore: 37,
  oldGoldScore: null,
  oldGoldClass: null,
  oldGoldClassProvided: false,
  oldGoldReasons: [],
  oldGoldReasonsProvided: false,
  recordDigest: "Audited lead record 2026-08-10",
  recordDead: null,
  recordDeadReason: null,
  recordDeadReasonProvided: false,
  revisitOn: null,
  revisitOnProvided: false,
  qualNote: null,
  lastSqlDate: null,
  ...overrides,
});

describe("agent score write law", () => {
  it("stores an ordinary non-dead TAM grade unchanged", () => {
    const result = deriveStoredScores(row(), {
      // These legacy signal-shaped properties are intentionally irrelevant.
      record_dead: false,
      record_digest: "Uses QuickBooks across 3 entities",
    });
    expect(result).toMatchObject({ codexScore: 37, tamScore: 37, hardZeroReason: null });
    expect(result.scoreNote).toContain("Triggered-only");
  });

  it("preserves the raw grade while applying record-dead hard zero", () => {
    const result = deriveStoredScores(row({ tamScore: 82, oldGoldScore: 61 }), {
      record_dead: true,
      qual_note: "prior evaluation",
      last_sql_date: "2025-04-03",
    });
    expect(result).toMatchObject({ codexScore: 82, tamScore: 0, oldGoldScore: 0, hardZeroReason: "record dead" });
  });

  it("applies the same hard zero to a confirmed NetSuite incumbent", () => {
    const result = deriveStoredScores(row({ tamScore: 82, oldGoldScore: 61 }), {
      erp_incumbent: "NetSuite",
      qual_note: "prior evaluation",
      last_sql_date: "2025-04-03",
    });
    expect(result).toMatchObject({ codexScore: 82, tamScore: 0, oldGoldScore: 0, hardZeroReason: "already on NetSuite" });
  });

  it("keeps artifact zero distinct from non-member live storage null", () => {
    const result = deriveStoredScores(row({ oldGoldScore: 0 }), {});
    expect(result.oldGoldScore).toBeNull();
  });

  it("stores an independent Old Gold score only for a qualifying row", () => {
    const result = deriveStoredScores(row({ tamScore: 55, oldGoldScore: 18 }), {
      qual_note: "prior evaluation",
      last_sql_date: "2025-04-03",
    });
    expect(result).toMatchObject({ codexScore: 55, tamScore: 55, oldGoldScore: 18 });
  });

  it("keeps retired duplicate history immutable", () => {
    expect(isRetiredTamDuplicate({ lists: ["netsuite_tam", "tam_duplicate"] })).toBe(true);
    expect(isRetiredTamDuplicate({ lists: ["netsuite_tam"] })).toBe(false);
  });

  it("requires a dead reason and clears it when a record is made live", () => {
    expect(effectiveRecordDeadReason(row(), { record_dead_reason: "specific dated DQ" }, true)).toBe("specific dated DQ");
    expect(effectiveRecordDeadReason(row({ recordDeadReasonProvided: true, recordDeadReason: null }), { record_dead_reason: "old" }, true)).toBeNull();
    expect(effectiveRecordDeadReason(row({ recordDead: false }), { record_dead_reason: "old" }, false)).toBeNull();
  });
});
