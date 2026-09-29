import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
vi.mock("./operatingCoverage", () => ({ catalogFacetVersion: (facet: { id: string }) => "current:" + facet.id }));
import { readyCustomerReference, customerWhyNow } from "./customerMatchesServer";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS } from "./operatingCatalog";
import { customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";

const seed: CustomerReferenceSeed = { id: "reference", name: "Reference", domain: "reference.test", website: "https://reference.test",
  announcementDate: "2026-07-31", announcementType: "new_customer", sources: [{ id: "source-1", url: "https://reference.test/services",
    title: "Services", text: "Our hardware, installation and managed IT services.", observedAt: "2026-09-28",
    contentHash: createHash("sha256").update("Our hardware, installation and managed IT services.").digest("hex") }] };
const stored = () => ({ id: seed.id, status: "complete", catalog_version: OPERATING_CATALOG_VERSION, evidence_key: customerReferenceEvidenceKey(seed), result: {
  id: seed.id, catalogVersion: OPERATING_CATALOG_VERSION, completedAt: "2026-09-28", status: "verified",
  answers: Object.fromEntries(OPERATING_FACETS.map(f => [f.id, { facetVersion: "current:" + f.id, decision: "insufficient_evidence",
    sourceUrls: [] as string[], nativeResult: { questionId: f.id, answer: { type: "choice", choice: "insufficient_evidence" } } }])) } });

describe("customer reference native provenance", () => {
  it("accepts complete native unknown answers with no mapped candidates", () => {
    expect(readyCustomerReference(seed, stored())).toMatchObject({ id: seed.id, status: "verified" });
  });
  it("requires current native source-backed support, preserving native result", () => {
    const row = stored();
    const answer = row.result.answers.rr_c01;
    answer.decision = "supported"; answer.nativeResult.answer.choice = "supported";
    expect(readyCustomerReference(seed, row)).toBeNull();
    answer.sourceUrls = [seed.sources[0].url];
    expect(readyCustomerReference(seed, row)?.answers.rr_c01.nativeResult).toEqual(answer.nativeResult);
  });
  it("rejects stale definitions, altered evidence, incomplete answers and foreign citations", () => {
    const old = stored(); old.catalog_version = "old"; expect(readyCustomerReference(seed, old)).toBeNull();
    const altered = { ...seed, sources: [{ ...seed.sources[0], text: "Changed content" }] };
    expect(readyCustomerReference(altered, stored())).toBeNull();
    const incomplete = stored(); delete incomplete.result.answers.rr_c01; expect(readyCustomerReference(seed, incomplete)).toBeNull();
    const foreign = stored(); foreign.result.answers.rr_c01.sourceUrls = ["https://unrelated.test"]; expect(readyCustomerReference(seed, foreign)).toBeNull();
  });
  it("uses maintained identity fields instead of provider-generated names or dates", () => {
    const row = stored(); Object.assign(row.result, { name: "Wrong name", announcementDate: "2026-09-28", website: "https://wrong.test" });
    expect(readyCustomerReference(seed, row)).toMatchObject({ name: "Reference", announcementDate: "2026-07-31", website: "https://reference.test" });
  });
  it("exposes current paid partial facts while preserving missing facets and held status", () => {
    const row = stored(), original = row.result.answers.rr_c01;
    original.decision = "supported"; original.nativeResult.answer.choice = "supported"; original.sourceUrls = [seed.sources[0].url];
    const partial = { id: row.id, status: "blocked", catalog_version: row.catalog_version, evidence_key: row.evidence_key,
      checkpoint_version: 1, checkpoint_evidence_key: row.evidence_key, checkpoint_answers: { rr_c01: original },
      checkpoint_last_error: "customer_context_relevant_evidence_still_large", updated_at: "2026-09-29T01:00:00Z" };
    const ref = readyCustomerReference(seed, partial)!;
    expect(ref).toMatchObject({ status: "partial", completedAt: null, reading: { status: "blocked", answered: 1, total: 47,
      lastError: "customer_context_relevant_evidence_still_large" } });
    expect(ref.answers.rr_c01).toBe(original); expect(ref.answers.rr_c11).toBeUndefined();
    expect(Object.keys(ref.answers)).toEqual(["rr_c01"]);
    expect(readyCustomerReference(seed, { ...partial, checkpoint_evidence_key: "old" })).toBeNull();
    expect(readyCustomerReference(seed, { ...partial, checkpoint_version: 2 })).toBeNull();
    expect(readyCustomerReference(seed, { ...partial, checkpoint_answers: {} })).toBeNull();
    const stale = structuredClone(original); stale.facetVersion = "old";
    const mixed = readyCustomerReference(seed, { ...partial, checkpoint_answers: { rr_c01: original, rr_i01: stale } })!;
    expect(mixed.answers.rr_c01).toBe(original); expect(mixed.answers.rr_i01).toBeUndefined();
    expect(mixed.reading).toMatchObject({ answered: 1, unavailableAnswers: 1 });
  });
});

describe("separate dated timing", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const company = { companyId: "id", name: "Services", domain: "services.test", subindustry: "Business Services", internalId: "123", status: "new",
    decisions: {}, description: null, ns_industry: null, record_dead: false, triggers: [] as Parameters<typeof customerWhyNow>[0]["triggers"] };
  const event = { id: "event", type: "ma", summary: "Acquisition", source_url: "https://services.test/news/acquisition", source_name: "Company", signal_date: "2026-09-20", metadata: {} };
  it("does not invent event dates from collection dates or make static systems facts urgent", () => {
    expect(customerWhyNow({ ...company, triggers: [{ ...event, signal_date: null }, { ...event, type: "erp_tech" }] }, now)).toEqual([]);
    expect(customerWhyNow({ ...company, triggers: [event] }, now)).toMatchObject([{ label: "Acquisition", eventDate: "2026-09-20" }]);
  });
  it("preserves quarantine, subject identity and publication gates", () => {
    expect(customerWhyNow({ ...company, triggers: [{ ...event, metadata: { stanley_quarantine: { active: true } } }] }, now)).toEqual([]);
    expect(customerWhyNow({ ...company, triggers: [{ ...event, metadata: { jevFinding: { attributes: { companyRelationship: "related", contentClass: "actual_company_development" } } } }] }, now)).toEqual([]);
    expect(customerWhyNow({ ...company, name: "Best CPA", triggers: [{ ...event, type: "finance_hire" }] }, now)).toEqual([]);
  });
  it("deduplicates reports of the same native event and ignores future/old events", () => {
    const native = { ...event, metadata: { jevFinding: { eventId: "same", attributes: { companyRelationship: "direct", contentClass: "actual_company_development" } } } };
    expect(customerWhyNow({ ...company, triggers: [native, { ...native, id: "duplicate" }, { ...event, signal_date: "2027-01-01" }, { ...event, signal_date: "2024-01-01" }] }, now)).toHaveLength(1);
  });
});
