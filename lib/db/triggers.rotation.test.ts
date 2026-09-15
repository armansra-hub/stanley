import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: [
  { id: "first", netsuite_internal_id: "100", domain: "example.com", website_raw: "https://other.example" },
  { id: "second", netsuite_internal_id: "101", domain: null, website_raw: "https://www.example.com/contact" },
], error: null })));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
import { pickAtsForRotation, pickSitesForRotation } from "./triggers";

describe("monitoring websites for distinct exact NetSuite IDs", () => {
  it("retains independent IDs while deriving ATS/site domains from source URLs", async () => {
    for (const load of [pickAtsForRotation, pickSitesForRotation]) {
      const rows = await load(12);
      expect(rows.map((row) => ({ id: row.id, domain: row.domain }))).toEqual([
        { id: "first", domain: "example.com" }, { id: "second", domain: "example.com" },
      ]);
    }
  });

  it("changes only the two website eligibility guards in the existing fenced reservation SQL", () => {
    const original = readFileSync("supabase/migrations/0042_source_rotation_cursors.sql", "utf8").replace(/\r\n/g, "\n");
    const forward = readFileSync("supabase/migrations/0056_tam_website_rotation.sql", "utf8").replace(/\r\n/g, "\n");
    const functionStart = "create or replace function reserve_company_rotation(";
    const oldFunction = original.slice(original.indexOf(functionStart));
    const newFunction = forward.slice(forward.indexOf(functionStart));
    const replacement = "and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)";
    expect(newFunction.split(replacement)).toHaveLength(3);
    expect(newFunction.replaceAll(replacement, "and c.domain is not null")).toBe(oldFunction);
  });
});
