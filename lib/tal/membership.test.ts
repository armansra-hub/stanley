import { describe, expect, it } from "vitest";
import { resolveExactTalMembership, type TalCompanyIdentity } from "./membership";

const company = (
  patch: Partial<TalCompanyIdentity> & Pick<TalCompanyIdentity, "id" | "name">,
): TalCompanyIdentity => ({
  netsuite_internal_id: null,
  tal_claimed: false,
  tal_dq: false,
  lists: [],
  ...patch,
});

describe("resolveExactTalMembership", () => {
  it("uses only the exact NetSuite ID and never a domain or name alias", () => {
    const row = { name: "Western Healthcare", website: "western.example", internal_id: "160" };
    const result = resolveExactTalMembership(
      [row],
      [
        company({ id: "exact", name: "Different display name", netsuite_internal_id: "160" }),
        company({ id: "alias", name: "Western Healthcare", netsuite_internal_id: "999" }),
      ],
    );
    expect(result.assignments.map((assignment) => assignment.company.id)).toEqual(["exact"]);
  });

  it("accepts an exact Internal ID even when the optional display name is blank", () => {
    const result = resolveExactTalMembership(
      [{ name: "", internal_id: "160" }],
      [company({ id: "exact", name: "Live company name", netsuite_internal_id: "160" })],
    );
    expect(result.invalidRows).toHaveLength(0);
    expect(result.assignments.map((assignment) => assignment.company.id)).toEqual(["exact"]);
  });

  it("fails closed instead of falling back when the exact ID is absent", () => {
    const row = { name: "Mirendil", website: "mirendil.com", internal_id: "213915487" };
    const result = resolveExactTalMembership(
      [row],
      [company({ id: "same-domain", name: "Mirendil", netsuite_internal_id: null })],
    );
    expect(result.assignments).toHaveLength(0);
    expect(result.unmatched).toEqual([row]);
  });

  it("ignores an explicitly retired tam_duplicate row", () => {
    const result = resolveExactTalMembership(
      [{ name: "Acme", internal_id: "42" }],
      [
        company({ id: "current", name: "Acme", netsuite_internal_id: "42", lists: ["netsuite_tam"] }),
        company({ id: "retired", name: "Acme old", netsuite_internal_id: "42", lists: ["tam_duplicate"] }),
      ],
    );
    expect(result.assignments.map((assignment) => assignment.company.id)).toEqual(["current"]);
    expect(result.ambiguous).toHaveLength(0);
  });

  it("reports multiple non-retired rows for one ID as ambiguous", () => {
    const result = resolveExactTalMembership(
      [{ name: "Acme", internal_id: "42" }],
      [
        company({ id: "a", name: "Acme A", netsuite_internal_id: "42" }),
        company({ id: "b", name: "Acme B", netsuite_internal_id: "42" }),
      ],
    );
    expect(result.assignments).toHaveLength(0);
    expect(result.ambiguous).toEqual([
      { row: { name: "Acme", website: null, internal_id: "42" }, company_ids: ["a", "b"] },
    ]);
  });

  it("deduplicates repeated exact IDs and reports the collision", () => {
    const result = resolveExactTalMembership(
      [
        { name: "Acme LLC", internal_id: "1" },
        { name: "Acme", internal_id: "1" },
      ],
      [company({ id: "acme", name: "Acme", netsuite_internal_id: "1" })],
    );
    expect(result.uniqueRows).toHaveLength(1);
    expect(result.assignments).toHaveLength(1);
    expect(result.duplicateInputIds).toEqual(["1"]);
  });

  it("reports missing and malformed IDs before any assignment", () => {
    const result = resolveExactTalMembership(
      [
        { name: "Missing" },
        { name: "Malformed", internal_id: "abc-123" },
      ],
      [],
    );
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "missing_internal_id",
      "invalid_internal_id",
    ]);
    expect(result.assignments).toHaveLength(0);
  });
});
