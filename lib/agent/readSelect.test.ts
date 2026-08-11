import { describe, expect, it } from "vitest";
import { isReadableTable, safeScalarSelect } from "./readSelect";

describe("agent read scalar select contract", () => {
  it("accepts allowlisted scalar columns and removes duplicates", () => {
    expect(safeScalarSelect("companies", "name,tam_score,name")).toEqual({
      ok: true,
      select: "name,tam_score",
    });
  });

  it.each([
    "name,tam_regrade_records(reader_claim_token)",
    "seed:tam_regrade_records(reader_claim_token)",
    "...tam_regrade_records(reader_claim_token)",
    "name::text",
    "metadata->secret",
    "count()",
  ])("rejects PostgREST traversal or expression syntax: %s", (select) => {
    expect(safeScalarSelect("companies", select)).toMatchObject({ ok: false });
  });

  it("rejects unknown scalar columns instead of relying on the live schema", () => {
    expect(safeScalarSelect("companies", "name,reader_claim_token")).toEqual({
      ok: false,
      error: "select contains unreadable column(s): reader_claim_token",
    });
  });

  it("expands star to the explicit table contract without relationship fields", () => {
    const result = safeScalarSelect("companies", "*");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.select).toContain("netsuite_internal_id");
    expect(result.select).not.toContain("tam_regrade_records");
    expect(result.select).not.toContain("claim_token");
    expect(result.select).not.toContain("(");
  });

  it("does not expose TAM coordination tables as readable roots", () => {
    expect(isReadableTable("companies")).toBe(true);
    expect(isReadableTable("tam_regrade_records")).toBe(false);
    expect(isReadableTable("tam_checkpoint_seeds")).toBe(false);
  });

  it("uses the canonical filename column for the migration ledger", () => {
    expect(safeScalarSelect("schema_migrations", "name")).toEqual({ ok: true, select: "name" });
    expect(safeScalarSelect("schema_migrations", "version")).toMatchObject({ ok: false });
  });
});
