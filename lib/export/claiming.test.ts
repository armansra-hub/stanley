import { describe, expect, it } from "vitest";
import { buildClaimingComments, claimingBullets } from "./claiming";
import { buildFullCsvExport } from "./csv";

describe("claimingBullets", () => {
  it("caps at 4 bullets, one per distinct reason, no repeats", () => {
    const bullets = claimingBullets({
      oldgold_score: 90,
      last_sql_date: "2026-02-01",
      oldgold_class: "timing_arrived",
      record_digest:
        "Staffing co on QB (unhappy) w/ deep in-house finance team + recent SQL 2/2026 + scoping call — live engagement; hiring a new controller amid 40% growth across 3 entities",
    });
    expect(bullets.length).toBeLessThanOrEqual(4);
    expect(new Set(bullets).size).toBe(bullets.length);
    expect(bullets[0]).toMatch(/Active ERP eval/);
    expect(bullets).toContain("Old Gold — prior SQL 2/2026, revive");
  });

  it("keeps each bullet terse (no BANT essays)", () => {
    const bullets = claimingBullets({
      record_digest: "New CFO hired amid Inc 5000 growth; multi-office law firm outgrowing QuickBooks.",
    });
    for (const b of bullets) expect(b.length).toBeLessThanOrEqual(70);
    expect(bullets).toContain("New finance hire");
    expect(bullets).toContain("Growing");
  });

  it("names the competitor on lost evals", () => {
    const bullets = claimingBullets({
      oldgold_class: "lost_to_competitor",
      record_digest: "Ran a real eval then signed with Acumatica (implementation began 6/2026).",
    });
    expect(bullets.join(" ")).toMatch(/lost to Acumatica — revisit/);
  });

  it("guards against claiming dead leads", () => {
    const bullets = claimingBullets({ record_dead: true, record_dead_reason: "CPA firm (blocked lane)" });
    expect(bullets).toEqual(["DO NOT CLAIM — dead lead: CPA firm (blocked lane)"]);
  });

  it("never returns an empty cell", () => {
    expect(claimingBullets({ name: "Thin Co", subindustry: "Consulting", state: "CA" })).toEqual([
      "ICP fit — Consulting, CA",
    ]);
  });

  it("uses the freshest trigger summary for triggered-tab rows", () => {
    const bullets = claimingBullets({
      top_trigger: { type: "finance_hiring", summary: "Hiring a Controller (posted 7/2026)" },
      record_digest: "",
    });
    expect(bullets[0]).toBe("Hiring a Controller (posted 7/2026)");
  });
});

describe("buildFullCsvExport claiming column", () => {
  it("emits Claiming Comments as the LAST column, newline-bulleted and CSV-quoted", () => {
    const csv = buildFullCsvExport([
      { name: "Acme", website_raw: "acme.com", record_digest: "outgrowing QuickBooks; new CFO hired" },
    ]);
    const header = csv.split("\r\n")[0];
    expect(header.endsWith(",Claiming Comments")).toBe(true);
    expect(csv).toContain('"• ');
    expect(csv).toContain("• New finance hire");
  });
});
