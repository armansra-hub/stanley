import { describe, expect, it } from "vitest";
import { assertFiniteCollection, finiteCollectionAccounting, parseFiniteCollection, validateFiniteScope } from "./finiteCollection";

const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"];
const scope = { companyIds: ids, runCutoff: "2026-01-01T01:02:03Z" };
const valid = `companyIds=${ids.join(",")}&runCutoff=${scope.runCutoff}&sourceOnly=1`;

describe("finite collector admission", () => {
  it("leaves legacy parameters alone and defaults a manual limit to the exact set size", () => {
    expect(parseFiniteCollection(new URLSearchParams("offset=12&n=250"))).toBeUndefined();
    expect(parseFiniteCollection(new URLSearchParams(valid))).toEqual({ collection: scope, limit: 2 });
    expect(parseFiniteCollection(new URLSearchParams(`${valid}&n=1&offset=0`))?.limit).toBe(1);
  });
  it.each([
    `companyIds=${ids[0]}&sourceOnly=1`, `runCutoff=${scope.runCutoff}&sourceOnly=1`,
    valid.replace("sourceOnly=1", "sourceOnly=0"), valid.replace("&sourceOnly=1", ""),
    valid.replace(ids[1], ids[0]), valid.replace(ids[1], "not-a-uuid"),
    valid.replace(ids.join(","), ""), valid.replace(scope.runCutoff, "2026-02-30T00:00:00Z"),
    valid.replace(scope.runCutoff, "2099-01-01T00:00:00Z"), valid.replace(scope.runCutoff, "2026-01-01"),
    `${valid}&offset=1`, `${valid}&offset=-1`, `${valid}&offset=abc`, `${valid}&scope=tail`, `${valid}&scope=unknown`,
    `${valid}&finance=1`, `${valid}&finance=true`, `${valid}&n=3`, `${valid}&n=0`, `${valid}&n=1.5`,
    `${valid}&companyIds=${ids[0]}`, `${valid}&sourceOnly=1`, `${valid}&n=1&n=2`,
  ])("rejects malformed or conflicting input before collection: %s", value => {
    expect(() => parseFiniteCollection(new URLSearchParams(value))).toThrow();
  });
  it("bounds the exact set and requires source-only even for direct callers", () => {
    const companyIds = Array.from({ length: 101 }, (_, n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);
    expect(() => validateFiniteScope({ ...scope, companyIds })).toThrow();
    expect(() => assertFiniteCollection(scope, { limit: 2 })).toThrow();
    expect(() => assertFiniteCollection(scope, { limit: 2, sourceOnly: true, finance: true })).toThrow();
    expect(() => assertFiniteCollection(scope, { limit: 2, sourceOnly: true, scope: "tail" })).toThrow();
    expect(() => assertFiniteCollection(scope, { limit: 2, sourceOnly: true, offset: 1 })).toThrow();
  });
  it("reports partial attempts and unknown non-admission without asserting source or analysis completion", () => {
    const accounting = finiteCollectionAccounting(scope);
    accounting.record(ids[0], "partial");
    expect(accounting.result()).toEqual({ collection: { ...{ runCutoff: scope.runCutoff, requestedCompanyIds: ids },
      outcomes: [{ companyId: ids[0], admission: "attempted", collectorOutcome: "partial" }, { companyId: ids[1], admission: "not_reserved", reason: "unknown" }],
      coverage: "reservation_and_collector_outcomes_only", analysisCompleted: false } });
    accounting.record(ids[0], "failed");
    expect(accounting.result().collection?.outcomes[0]).toHaveProperty("collectorOutcome", "failed");
    expect(finiteCollectionAccounting().result()).toEqual({});
  });
});
