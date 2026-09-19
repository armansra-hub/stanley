import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { buildPublicScaleContext, publicScalePassages, MAX_PUBLIC_SCALE_CONTEXT_BYTES, type PublicContextObservation } from "./publicContext";
const row: PublicContextObservation = { id: "baseline", company_id: "account", source_kind: "website", source_url: "https://example.test/about",
  title: "Our company", evidence_text: "Acme operates two offices, in Austin and Denver. Our 85 employees deliver engineering projects.",
  event_date: "2026-09-01", observed_at: "2026-09-18", is_current: true,
  attributes: { companyRelationship: "direct", companyRelevance: .95 } };
describe("public account-relative scale context", () => {
  it("preserves exact attributable footprint/count passages and their separate source dates", () => {
    const result = buildPublicScaleContext("account", [row]);
    expect(result.status).toBe("sourced_context");
    expect(result.sources[0]).toMatchObject({ url: row.source_url, eventDate: "2026-09-01", observedAt: "2026-09-18" });
    expect(result.sources[0].passages.map(passage => passage.text).join(" ")).toContain("two offices");
    expect(result.sources[0].passages.map(passage => passage.text).join(" ")).toContain("85 employees");
    for (const passage of result.sources[0].passages) expect(row.evidence_text.slice(passage.start, passage.end)).toBe(passage.text);
  });
  it("never fills missing scale from source quantity, CRM fields, historical or related-company evidence", () => {
    const result = buildPublicScaleContext("account", [
      { ...row, is_current: false }, { ...row, feedback_excluded: true }, { ...row, company_id: "other" },
      { ...row, attributes: { companyRelationship: "related", companyRelevance: .99 } },
      { ...row, source_kind: "government" },
    ]);
    expect(result.status).toBe("unknown"); expect(result.sources).toEqual([]);
    expect(result.text).toContain("remain unknown unless"); expect(result.text).toContain("No private CRM size fields");
  });
  it("does not turn a customer's numbers or an old dated claim into an asserted current denominator", () => {
    const result = buildPublicScaleContext("account", [{ ...row, event_date: "2019-01-01", evidence_text: "Our customer operates 500 offices." }]);
    expect(result.text).toContain("Our customer operates 500 offices.");
    expect(result.text).toContain("customer/supplier footprint is not the account's footprint");
    expect(result.text).toContain("A collection date does not make an older claim current");
    expect(result).not.toHaveProperty("locationCount"); expect(result).not.toHaveProperty("revenue");
  });
  it("excludes the new observation itself and deduplicates source URLs", () => {
    expect(buildPublicScaleContext("account", [row], row.id).sources).toEqual([]);
    expect(buildPublicScaleContext("account", [row, { ...row, id: "duplicate" }]).sources).toHaveLength(1);
  });
  it("bounds UTF-8 context while retaining valid original span offsets", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...row, id: String(i), source_url: `https://example.test/${i}`,
      evidence_text: `Acme operates offices ${"文".repeat(1000)}. Our employees work worldwide.` }));
    const result = buildPublicScaleContext("account", rows);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_PUBLIC_SCALE_CONTEXT_BYTES);
    expect(result.bounded).toBe(true);
    for (const source of result.sources) for (const passage of source.passages)
      expect(rows[Number(source.observationId)].evidence_text.slice(passage.start, passage.end)).toBe(passage.text);
    expect(publicScalePassages("No relevant source detail.")).toEqual([]);
  });
});
