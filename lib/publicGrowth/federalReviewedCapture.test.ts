import { describe, expect, it } from "vitest";
import { readFederalDiscoveryContinuations, readFederalDiscoveryManualSourceOnly } from "./federalDiscoveryState";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hold = { version: 1, status: "held", reason: "reviewed_journal_capacity_recovery_requires_manual_resume", operationId: id(8000),
  journalId: id(8001), companyIds: [id(1), id(2), id(3), id(4)], evidenceSha256: "a".repeat(64), readerTaskId: "reader", reviewerTaskId: "reviewer", heldAt: "2026-10-07T00:00:00Z" };
const continuation = (n: number) => ({ version: 1, companyId: id(n), companyIdentity: "b".repeat(64), searchEndDate: "2026-09-29", targets: [{ query: "Company", identity: null }], targetIndex: 0, page: 1, candidate: null, lastPageHash: null });
const mode = { version: 1, status: "manual_source_only", holdOperationId: hold.operationId, establishedEventId: id(8002), manualRunCutoff: "2026-10-08", retiredCapacityCompanyIds: [id(1)] };
describe("manual source-only capacity parsing", () => {
  it("retains the original hold and permits only explicitly retired original positions to be absent", () => {
    const cursor = { discoveryCapacityHold: hold, discoveryManualSourceOnly: mode, discoveryContinuations: Object.fromEntries([2, 3, 4].map(n => [id(n), continuation(n)])) };
    expect(readFederalDiscoveryManualSourceOnly(cursor)).toEqual(mode);
    expect(Object.keys(readFederalDiscoveryContinuations(cursor))).toEqual([id(2), id(3), id(4)]);
    expect(() => readFederalDiscoveryContinuations({ ...cursor, discoveryManualSourceOnly: { ...mode, retiredCapacityCompanyIds: [] } })).toThrow();
    expect(() => readFederalDiscoveryContinuations({ ...cursor, discoveryContinuations: { ...cursor.discoveryContinuations, [id(1)]: continuation(1) } })).toThrow();
    expect(() => readFederalDiscoveryManualSourceOnly({ ...cursor, discoveryManualSourceOnly: { ...mode, retiredCapacityCompanyIds: [id(999)] } })).toThrow();
    expect(() => readFederalDiscoveryManualSourceOnly({ ...cursor, discoveryCapacityHold: undefined })).toThrow();
  });
  it("retirement removes reserved overflow headroom and never increases the 1000 ordinary admission capacity", () => {
    const map = Object.fromEntries(Array.from({ length: 1003 }, (_, n) => [id(n + 2), continuation(n + 2)]));
    const cursor = { discoveryCapacityHold: hold, discoveryManualSourceOnly: mode, discoveryContinuations: map };
    expect(Object.keys(readFederalDiscoveryContinuations(cursor))).toHaveLength(1003);
    expect(() => readFederalDiscoveryContinuations({ ...cursor, discoveryContinuations: { ...map, [id(1005)]: continuation(1005) } })).toThrow();
  });
});
