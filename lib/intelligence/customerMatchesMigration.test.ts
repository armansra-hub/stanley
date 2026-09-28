import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync(new URL("../../supabase/migrations/0128_customer_reference_matches.sql", import.meta.url), "utf8");
describe("customer match read-side contract", () => {
  it("retains current native versions, evidence and exact source attribution", () => {
    expect(sql).toContain("a.evidence_key=f.evidence_key");
    expect(sql).toContain("f.facet_version=p_facet_versions->>f.facet_id");
    expect(sql).toContain("f.native_result->'answer'->>'choice'=f.decision");
    expect(sql).toContain("o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash");
  });
  it("reads canonical eligibility and visibility without a hidden result cap or TAM writes", () => {
    expect(sql).toContain("lists @> array['netsuite_tam']");
    expect(sql).toContain("tam_duplicate");
    expect(sql).toContain("p_show_hidden");
    expect(sql).not.toMatch(/limit\s+1000/i);
    expect(sql).not.toMatch(/(?:update|insert into|delete from)\s+(?:public\.)?(?:companies|intelligence_catalog_facets|intelligence_research_jobs)\b/i);
    expect(sql).toContain("jsonb_agg(jsonb_build_object(");
  });
  it("keeps native unknown completion and limits wide evidence hydration to one25-account page", () => {
    expect(sql).toContain("f.native_result->'answer'->>'choice'='insufficient_evidence'");
    expect(sql).toContain("jsonb_array_length(p_selection)>25");
    expect(sql).toContain("s.facets ? f.facet_id");
  });
  it("exposes neither private customer receipts nor SQL functions to anon/authenticated", () => {
    expect(sql).toContain("alter table public.intelligence_customer_references enable row level security");
    expect(sql).toContain("revoke all on public.intelligence_customer_references from public,anon,authenticated");
    expect(sql).toContain("revoke all on function public.intelligence_customer_match_candidates(text,jsonb,boolean) from public,anon,authenticated");
    expect(sql).toContain("revoke all on function public.intelligence_customer_match_evidence(jsonb,text,jsonb) from public,anon,authenticated");
  });
});
