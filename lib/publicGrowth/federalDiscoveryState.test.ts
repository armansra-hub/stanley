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
