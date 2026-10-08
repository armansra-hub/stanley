import { describe, expect, it } from "vitest";
import { parseFederalDiscoveryContinuation, readFederalDiscoveryContinuations, type FederalDiscoveryContinuation } from "./federalDiscoveryState";

const companyId = "11111111-1111-4111-8111-111111111111";
const legacy: FederalDiscoveryContinuation = { version: 1, companyId, companyIdentity: "snapshot", searchEndDate: "2026-09-20",
  targets: [{ query: "Acme", identity: null }], targetIndex: 0, page: 3,
  candidate: { id: "A1", name: "Acme", uei: "ABCDEFGHIJKL" }, lastPageHash: "prior-page" };
const queued: FederalDiscoveryContinuation = { ...legacy, searchAfter: null,
  candidateQueue: [{ id: "A2", name: "Acme Holdings", uei: "ZZZZZZZZZZZZ" }],
  pendingPage: { hasNext: true, pageHash: "current-page", nextCursor: { lastRecordUniqueId: 23, lastRecordSortValue: "source-sort-value" } },
  evaluatedRecipients: ["uei:123456789012"], foundVerified: true };

describe("durable federal discovery candidate state", () => {
  it("keeps legacy candidate and unread page semantics without adding new fields", () => {
    expect(parseFederalDiscoveryContinuation(legacy, companyId)).toEqual(legacy);
    expect(readFederalDiscoveryContinuations({ discoveryContinuations: { [companyId]: legacy } })).toEqual({ [companyId]: legacy });
  });
  it("round-trips the candidate tail, native evaluation progress and exact provider cursor", () => {
    const parsed = parseFederalDiscoveryContinuation(JSON.parse(JSON.stringify(queued)), companyId);
    expect(parsed).toEqual(queued);
    parsed.candidateQueue!.shift(); parsed.evaluatedRecipients!.push("award:changed");
    expect(queued.candidateQueue).toHaveLength(1); expect(queued.evaluatedRecipients).toHaveLength(1);
  });
  it("permits only held, bounded recovery headroom without changing the ordinary 1000 limit", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const map = Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [id(n + 1), { ...legacy, companyId: id(n + 1) }]));
    expect(() => readFederalDiscoveryContinuations({ discoveryContinuations: map })).toThrow("invalid discovery continuation queue");
    const hold = { version: 1, status: "held", reason: "reviewed_journal_capacity_recovery_requires_manual_resume",
      operationId: id(8000), journalId: id(8001), companyIds: [id(998), id(999), id(1000), id(1001)],
      evidenceSha256: "a".repeat(64), readerTaskId: "reader", reviewerTaskId: "reviewer", heldAt: "2026-10-08T00:00:00Z" };
    expect(Object.keys(readFederalDiscoveryContinuations({ discoveryContinuations: map, discoveryCapacityHold: hold }))).toHaveLength(1001);
    expect(() => readFederalDiscoveryContinuations({ discoveryContinuations: map, discoveryCapacityHold: { ...hold, reviewerTaskId: "reader" } })).toThrow();
    expect(() => readFederalDiscoveryContinuations({ discoveryContinuations: map, discoveryCapacityHold: { ...hold, companyIds: [id(9999)] } })).toThrow();
    for (let n = 1002; n <= 1005; n++) map[id(n)] = { ...legacy, companyId: id(n) };
    expect(() => readFederalDiscoveryContinuations({ discoveryContinuations: map, discoveryCapacityHold: hold })).toThrow("invalid discovery continuation queue");
  });
  it.each([
    { candidate: null },
    { pendingPage: undefined },
    { candidateQueue: [{ id: "A2", name: "Acme", uei: "malformed" }] },
    { pendingPage: { hasNext: true, pageHash: "current-page" } },
    { pendingPage: { hasNext: true, pageHash: "current-page", nextCursor: { lastRecordUniqueId: 23 } } },
    { evaluatedRecipients: ["uei:one", "uei:one"] },
    { evaluatedRecipients: ["not-an-identity"] },
    { foundVerified: "yes" },
  ])("rejects corrupt or detached candidate progress before source requests", (mutation) => {
    expect(() => parseFederalDiscoveryContinuation({ ...queued, ...mutation }, companyId)).toThrow();
  });
});
