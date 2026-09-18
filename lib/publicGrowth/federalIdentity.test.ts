import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { assertFrozenFederalIdentities, federalSearchTargets, matchesFederalIdentifiers, targetAcceptsSearchRow } from "./federalIdentity";
import { parseFederalDiscoveryContinuation } from "./federalDiscoveryState";

const identity = { entityId: "11111111-1111-4111-8111-111111111111", legalName: "Acme Legal", dbaName: "Brand",
  uei: "ABCDEFGHIJKL", recipientId: "recipient-1" };
describe("verified federal retrieval identities", () => {
  it("keeps legal/DBA/UEI targets attached to their exact verified entity", () => {
    expect(federalSearchTargets("Unrelated CRM label", [identity])).toEqual([identity.uei, identity.legalName, identity.dbaName]
      .map((query) => ({ query, identity })));
    expect(federalSearchTargets("Acme", [])).toEqual([{ query: "Acme", identity: null }]);
  });
  it("requires a matching stable identifier and rejects conflicting secondary identifiers", () => {
    expect(matchesFederalIdentifiers(identity, { uei: identity.uei.toLowerCase(), recipientId: "recipient-1" })).toBe(true);
    expect(matchesFederalIdentifiers(identity, { uei: identity.uei, recipientId: "another" })).toBe(false);
    expect(matchesFederalIdentifiers(identity, { uei: "ZYXWVUTSRQPO", recipientId: "recipient-1" })).toBe(false);
    expect(matchesFederalIdentifiers(identity, { uei: null, recipientId: null })).toBe(false);
  });
  it("uses names only as candidate retrieval and lets absent search identifiers reach detail validation", () => {
    expect(targetAcceptsSearchRow({ query: "Acme", identity }, { recipientName: "Acme", recipientUei: "ZYXWVUTSRQPO" })).toBe(false);
    expect(targetAcceptsSearchRow({ query: "Acme", identity }, { recipientName: "New Legal Name", recipientUei: null })).toBe(true);
    expect(targetAcceptsSearchRow({ query: "Acme", identity: null }, { recipientName: "Other", recipientUei: identity.uei })).toBe(false);
  });
  it("allows legal-name refreshes but fails closed on changed or removed verified identifiers", () => {
    expect(() => assertFrozenFederalIdentities([identity], [{ ...identity, legalName: "Renamed" }])).not.toThrow();
    expect(() => assertFrozenFederalIdentities([identity], [{ ...identity, recipientId: "another" }])).toThrow();
    expect(() => assertFrozenFederalIdentities([identity], [])).toThrow();
  });
  it("rejects malformed frozen discovery identities and dates before they can become query filters", () => {
    const state = { version: 1, companyId: identity.entityId, companyIdentity: "hash", searchEndDate: "2026-09-18",
      targets: [{ query: identity.uei, identity }], targetIndex: 0, page: 1, candidate: null, lastPageHash: null };
    expect(parseFederalDiscoveryContinuation(state, identity.entityId)).toEqual(state);
    expect(() => parseFederalDiscoveryContinuation({ ...state, searchEndDate: "2026-02-31" }, identity.entityId)).toThrow();
    expect(() => parseFederalDiscoveryContinuation({ ...state, targets: [{ query: "query", identity: { ...identity, entityId: "bad)" } }] }, identity.entityId)).toThrow();
    expect(() => parseFederalDiscoveryContinuation({ ...state, page: 10001 }, identity.entityId)).toThrow();
  });
});
