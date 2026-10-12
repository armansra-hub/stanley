import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => { throw new Error("No database or provider calls permitted"); } }));
import { validateNewsAnalysis, validateNewsReview, newsDecisionHash, publicNewsPacket, verifyNewsCompletion, completeCodexSource, newsActionSchema, type NewsPacket } from "./codexNews";
import { operatingCriteria } from "./profiles";

const now = Date.parse("2026-09-29T12:00:00Z");
const hash = "a".repeat(64);
function packet(): NewsPacket {
  const text = "Acme expanded into a second office on September 20, 2026. Its staff will support existing clients. 😀";
  return { jobId: "10000000-0000-4000-8000-000000000001", status: "running", lease: "20000000-0000-4000-8000-000000000001", leaseUntil: "2026-09-29T12:20:00Z", snapshotHash: hash,
    review: { actor: "/root/reader", requestId: "30000000-0000-4000-8000-000000000001", snapshotHash: hash },
    snapshot: { observation: { id: "40000000-0000-4000-8000-000000000001", company_id: "50000000-0000-4000-8000-000000000001", source_kind: "news",
      source_url: "https://acme.com/news/second-office", title: "Acme opens a second office", evidence_text: text, content_hash: "b".repeat(64),
      event_date: "2026-09-20T00:00:00Z", observed_at: "2026-09-29T10:00:00Z", is_current: true, feedback_excluded: false,
      metadata: { articleBodyAvailable: true, evidenceKind: "article_body", textTruncated: false }, sections: [] },
      company: { id: "50000000-0000-4000-8000-000000000001", name: "Acme", domain: "acme.com", website_raw: null, city: null, state: null,
        netsuite_internal_id: "1234", status: "new", lists: ["netsuite_tam"], tal_claimed: true, record_dead: false, description: null, subindustry: null, ns_industry: null }, identity: {} } };
}
function analysis(p = packet()) {
  return { reader: { taskId: "/root/reader", model: "gpt-6-astra", snapshotHash: hash, readStart: 0 as const, readEnd: p.snapshot.observation.evidence_text.length, fullTextRead: true as const },
    disposition: "publish" as "publish" | "no_signal", rationale: "The original dated source explicitly reports a second office for this company.",
    identityReason: "The named company and its official source domain exactly match the supplied account.",
    dateReason: "The article explicitly dates this office opening to September 20, 2026.",
    attributes: { signalType: "press" as const, companyRelationship: "direct" as const, contentClass: "actual_company_development" as const,
      companyRole: "subject" as const, contractActivity: "none" as const, operatingChangeType: "expansion" as const, evidenceSectionId: "selected" as string | null,
      companyRelevance: .99, concreteEvent: .95, isAcquirer: 0, operationalComplexity: .5, growthRelevance: .8, evidenceStrength: .9, requiresResearch: 0 },
    criteria: Object.fromEntries(operatingCriteria(null, "news").map(c => [c.id, 0])),
    passage: { start: 0, end: 56, text: p.snapshot.observation.evidence_text.slice(0, 56) } as { start: number; end: number; text: string } | null };
}
function review(p: NewsPacket) {
  return { reviewer: { ...analysis(p).reader, taskId: "/root/independent" }, decisionHash: p.review.decisionHash!, approved: true as const,
    rationale: "I independently read the full source and verified the identity, date and cited office development.", identityConfirmed: true as const, dateChecked: true as const, sourceLimitationsChecked: true as const };
}
describe("Codex canonical news review", () => {
  function oracleFixture() {
    const p = packet();
    p.snapshot.observation.evidence_text = "Acme announced a partnership with Oracle on September 20, 2026 to jointly develop energy procurement services.";
    const base = analysis(p);
    const a = { ...base, attributes: { ...base.attributes, signalType: "oracle_partnership" as const, companyRole: "partner" as const, operatingChangeType: "other" as const },
      passage: { start: 0, end: p.snapshot.observation.evidence_text.length, text: p.snapshot.observation.evidence_text } };
    return { p, a };
  }
  it("routes a dated Oracle partnership through the same full-read and independent reviewer gates", () => {
    const { p, a } = oracleFixture();
    expect(validateNewsAnalysis(p, a, now).trigger).toMatchObject({ type: "oracle_partnership", strength: 65, half_life_days: 180 });
    p.review.analysis = a; p.review.decisionHash = newsDecisionHash(a);
    expect(validateNewsReview(p, review(p), now).trigger?.type).toBe("oracle_partnership");
    expect(() => validateNewsReview(p, { ...review(p), reviewer: a.reader }, now)).toThrow("independent_reviewer");
    expect(publicNewsPacket(p)?.contract.signalDefinitions.oracle_partnership).toContain("Oracle product use");
  });
  const levelTenText = "It has been a pleasure working with Oracle to help them achieve their clean energy goals. Congrats on 1.7GW+ of wind in Texas, Mark Porter, C.E.M., Michael Pariser, and team! ⚡ Let's keep the momentum going in New Mexico! Developers: We're seeking 2GW. Please reach out to our team to learn more. Deadline is Oct. 9, so don't delay! https://lnkd.in/ex9qb8VY";
  function collaborationFixture(text = levelTenText) {
    const { p, a } = oracleFixture();
    Object.assign(p.snapshot.company, { name: "LevelTen Energy", domain: "leveltenenergy.com", status: "removed_from_tam", tal_claimed: true });
    Object.assign(p.snapshot.observation, { evidence_text: text, title: "Working with Oracle on clean energy goals",
      event_date: "2026-09-17T19:16:25.419Z", source_url: "https://www.linkedin.com/posts/leveltenenergy_it-has-been-a-pleasure-working-with-oracle-activity-7506430883806240768-STXv" });
    return { p, a: { ...a, reader: { ...a.reader, readEnd: text.length },
      rationale: "The company itself describes direct clean-energy work with Oracle and a dated Texas wind milestone; the text does not allocate the entire 1.7GW to LevelTen or establish a legal partnership.",
      identityReason: "The original post author is LevelTen Energy, matching this exact claimed TAL company.",
      dateReason: "The original publication timestamp is September 17, 2026; the dated post describes the work and milestone.",
      attributes: { ...a.attributes, companyRole: "service_provider" as const }, passage: { start: 0, end: text.length, text } } };
  }
  it("accepts the complete LevelTen author text with its truthful service-provider role and independent review", () => {
    const { p, a } = collaborationFixture();
    expect(validateNewsAnalysis(p, a, now).trigger?.type).toBe("oracle_partnership");
    expect(a.attributes.companyRole).toBe("service_provider");
    p.review.analysis = a; p.review.decisionHash = newsDecisionHash(a);
    expect(validateNewsReview(p, review(p), now).trigger?.type).toBe("oracle_partnership");
    expect(() => validateNewsReview(p, { ...review(p), reviewer: a.reader }, now)).toThrow("independent_reviewer");
    p.snapshot.observation.metadata.sourceTruncated = true;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("hold_required");
  });
  it.each([
    "Our customers include Oracle, Microsoft and Acme.",
    "We are a supplier and partner to Oracle.",
    "We are working with Oracle Cloud to improve our reporting system.",
    "We are working with Oracle Database to organize company records.",
    "We are working with Oracle partner Acme to deliver a new project.",
    "We have been working with Oracle.",
  ])("does not convert a generic supplier/product/third-party reference into collaboration: %s", text => {
    const { p, a } = collaborationFixture(text);
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("oracle_partnership_original_evidence_required");
  });
  it("keeps job skills, third-party coverage and hypothetical work outside publication despite a matching phrase", () => {
    const { p, a } = collaborationFixture("Candidates need experience working with Oracle to deliver clean energy projects.");
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, contentClass: "promotional_content" } }, now)).toThrow("publication_policy");
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, companyRelationship: "related" } }, now)).toThrow("publication_policy");
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, companyRole: "publisher" } }, now)).toThrow("publication_policy");
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, concreteEvent: .2 } }, now)).toThrow("publication_policy");
    p.snapshot.observation.event_date = null;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("publication_policy");
  });
  it.each(["customer", "publisher", "namesake", "unknown"] as const)("does not treat %s attribution as an Oracle partnership", companyRole => {
    const { p, a } = oracleFixture();
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, companyRole } }, now)).toThrow("publication_policy_rejected");
  });
  it("rejects missing originals, unknown dates, unrelated identity and product-use-only passages", () => {
    const { p, a } = oracleFixture();
    for (const companyRelationship of ["related", "unrelated", "unknown"] as const) expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, companyRelationship } }, now)).toThrow("publication_policy");
    p.snapshot.observation.event_date = null;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("publication_policy");
    p.snapshot.observation.event_date = "2026-09-20T00:00:00Z";
    p.snapshot.observation.metadata.articleBodyAvailable = false;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("hold_required");
    p.snapshot.observation.metadata.articleBodyAvailable = true;
    p.snapshot.observation.evidence_text = "Acme uses Oracle Cloud software.";
    const unsupported = { ...a, reader: { ...a.reader, readEnd: p.snapshot.observation.evidence_text.length }, passage: { start: 0, end: p.snapshot.observation.evidence_text.length, text: p.snapshot.observation.evidence_text } };
    expect(() => validateNewsAnalysis(p, unsupported, now)).toThrow("oracle_partnership_original_evidence_required");
  });
  it("rejects LinkedIn search snippets while accepting a fully captured original post", () => {
    const { p, a } = oracleFixture();
    p.snapshot.observation.source_url = "https://www.linkedin.com/search/results/content/?keywords=Acme";
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("oracle_partnership_original_evidence_required");
    p.snapshot.observation.source_url = "https://www.linkedin.com/posts/acme_oracle-partnership-activity-123";
    expect(validateNewsAnalysis(p, a, now).trigger?.type).toBe("oracle_partnership");
    p.snapshot.observation.metadata.evidenceKind = "headline_only";
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("hold_required");
  });
  it("requires validated adapter body provenance even when legacy metadata claimed availability", () => {
    const p = packet(), o = p.snapshot.observation; o.source_kind = "job";
    Object.assign(o.metadata, { textTruncated: false, retainedCharacters: o.evidence_text.length, sourceCharacters: o.evidence_text.length,
      atsType: "greenhouse", atsToken: "acme", atsJobKey: "1", descriptionAvailable: true });
    expect(completeCodexSource(p)).toBe(false);
    Object.assign(o.metadata, { bodySchemaValidated: true, bodySchemaVersion: "wrong" });
    expect(completeCodexSource(p)).toBe(false);
    o.metadata.bodySchemaVersion = "ats-body-schema-v1";
    expect(completeCodexSource(p)).toBe(true);
    o.metadata.bodySchemaValidated = "true";
    expect(completeCodexSource(p)).toBe(false);
  });
  it("binds finite selectors without broadening default news claims", () => {
    const claim = { action: "claim", requestId: packet().review.requestId, taskId: "/root/reader" };
    expect(newsActionSchema.parse(claim)).toEqual(claim);
    expect(() => newsActionSchema.parse({ ...claim, sourceKind: "federal_award" })).toThrow();
    expect(() => newsActionSchema.parse({ ...claim, companyIds: [packet().snapshot.company.id] })).toThrow();
    expect(() => newsActionSchema.parse({ ...claim, companyIds: [packet().snapshot.company.id, packet().snapshot.company.id], observedThrough: "2026-09-29T00:00:00Z" })).toThrow();
  });
  it("accepts an exact observation only with explicit source kind, one company and cutoff", () => {
    const p = packet();
    const targeted = { action: "claim", requestId: p.review.requestId, taskId: "/root/reader", sourceKind: "website",
      companyIds: [p.snapshot.company.id], observedThrough: "2026-09-29T00:00:00Z", observationId: p.snapshot.observation.id };
    expect(newsActionSchema.parse(targeted)).toEqual(targeted);
    for (const key of ["sourceKind", "companyIds", "observedThrough"] as const) {
      const incomplete = { ...targeted } as Record<string, unknown>; delete incomplete[key];
      expect(() => newsActionSchema.parse(incomplete)).toThrow();
    }
    expect(() => newsActionSchema.parse({ ...targeted, companyIds: [p.snapshot.company.id, "50000000-0000-4000-8000-000000000002"] })).toThrow();
    for (const observationId of [null, "", "not-a-uuid", [p.snapshot.observation.id]]) {
      expect(() => newsActionSchema.parse({ ...targeted, observationId })).toThrow();
    }
  });
  it.each(["website", "job"])("reviews complete %s sources with truthful provenance and independent validation", kind => {
    const p = packet(), o = p.snapshot.observation; o.source_kind = kind;
    o.metadata = { textTruncated: false, retainedCharacters: o.evidence_text.length, sourceCharacters: o.evidence_text.length,
      discovery: { collector: "website" }, meaningfulContentHash: "b".repeat(64), atsType: "lever", atsToken: "acme", atsJobKey: "job-1", descriptionAvailable: true, bodySchemaValidated: true, bodySchemaVersion: "ats-body-schema-v1" };
    const a = analysis(p); a.criteria = Object.fromEntries(operatingCriteria(null, kind).map(c => [c.id, 0]));
    expect(completeCodexSource(p)).toBe(true);
    expect(validateNewsAnalysis(p, a, now).trigger?.source_name).toBe(`Codex · Independently reviewed public ${kind}`);
    p.review.analysis = a; p.review.decisionHash = newsDecisionHash(a);
    expect(() => validateNewsReview(p, review(p), now)).not.toThrow();
    o.metadata.sourceCharacters = o.evidence_text.length + 1;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("hold_required");
  });
  it("holds snippet-only or missing completeness provenance and rejects dedicated federal evidence", () => {
    const p = packet(), a = analysis(p); p.snapshot.observation.source_kind = "job";
    Object.assign(p.snapshot.observation.metadata, { retainedCharacters: a.reader.readEnd, sourceCharacters: a.reader.readEnd,
      atsType: "wizehire", atsToken: "acme", atsJobKey: "1", descriptionAvailable: true });
    expect(completeCodexSource(p)).toBe(false);
    p.snapshot.observation.source_kind = "website";
    expect(completeCodexSource(p)).toBe(false);
    p.snapshot.observation.source_kind = "news"; p.snapshot.observation.metadata.structuredAward = true;
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("dedicated_federal_policy");
  });
  it("uses original full text, exact spans and existing routing without fabricated Jev provenance", () => {
    const p = packet(), result = validateNewsAnalysis(p, analysis(p), now);
    expect(result.trigger).toMatchObject({ type: "press", strength: 50, source_name: "Codex · Independently reviewed public news" });
    expect(JSON.stringify(result)).not.toMatch(/typesafe-direct|rawAnswers|jevFinding/);
    expect(publicNewsPacket(p)?.snapshot.observation.evidence_text).toBe(p.snapshot.observation.evidence_text);
    expect(publicNewsPacket(p)?.contract.completeArticleBody).toBe(true);
  });
  it("requires every character, unchanged snapshot, all criteria, exact quotes and declared section", () => {
    const p = packet(), a = analysis(p);
    expect(() => validateNewsAnalysis(p, { ...a, reader: { ...a.reader, readEnd: a.reader.readEnd - 1 } }, now)).toThrow("full_source_read");
    expect(() => validateNewsAnalysis(p, { ...a, reader: { ...a.reader, snapshotHash: "c".repeat(64) } }, now)).toThrow("snapshot_changed");
    expect(() => validateNewsAnalysis(p, { ...a, criteria: {} }, now)).toThrow("criteria_coverage");
    expect(() => validateNewsAnalysis(p, { ...a, passage: { ...a.passage!, text: "An invented event quotation" } }, now)).toThrow("passage_mismatch");
  });
  it("cannot hide a routable source by omitting the passage or choosing no_signal", () => {
    const p = packet(), a = analysis(p);
    expect(() => validateNewsAnalysis(p, { ...a, disposition: "no_signal" }, now)).toThrow("requires_publication");
    expect(() => validateNewsAnalysis(p, { ...a, disposition: "no_signal", passage: null, attributes: { ...a.attributes, evidenceSectionId: null } }, now)).toThrow("passage_required");
  });
  it("closes a fully read unrelated article without further source research", () => {
    const p = packet(), a = analysis(p);
    const result = validateNewsAnalysis(p, { ...a, disposition: "no_signal", passage: null,
      attributes: { ...a.attributes, evidenceSectionId: null, companyRelationship: "unrelated", companyRole: "namesake", companyRelevance: 0 } }, now);
    expect(result.trigger).toBeNull();
  });
  it("keeps missing or truncated bodies on explicit hold instead of crediting completion", () => {
    for (const metadata of [{ articleBodyAvailable: false }, { textTruncated: true }, { sourceTruncated: true }, { evidenceKind: "headline_only" }]) {
      const p = packet(); Object.assign(p.snapshot.observation.metadata, metadata);
      expect(() => validateNewsAnalysis(p, analysis(p), now)).toThrow("hold_required");
    }
  });
  it("applies date, acquisition, finance-source and quarantine policies", () => {
    const p = packet(), a = analysis(p);
    p.snapshot.observation.event_date = "2025-01-01T00:00:00Z";
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("publication_policy");
    p.snapshot.observation.event_date = "2026-09-20T00:00:00Z";
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, signalType: "ma", isAcquirer: .2 } }, now)).toThrow("publication_policy");
    p.snapshot.company.name = "Acme Accounting";
    expect(() => validateNewsAnalysis(p, { ...a, attributes: { ...a.attributes, signalType: "finance_hire" } }, now)).toThrow("publication_policy");
    p.snapshot.observation.metadata.stanley_quarantine = { active: true };
    expect(() => validateNewsAnalysis(p, a, now)).toThrow("publication_policy");
  });
  it("requires an independent full read of the identical decision and records truthful tasks", () => {
    const p = packet(); p.review.analysis = analysis(p); p.review.decisionHash = newsDecisionHash(p.review.analysis);
    const r = review(p);
    expect(validateNewsReview(p, r, now).review.reviewer.taskId).toBe("/root/independent");
    expect(() => validateNewsReview(p, { ...r, reviewer: { ...r.reviewer, taskId: p.review.actor } }, now)).toThrow("independent_reviewer");
    expect(() => validateNewsReview(p, { ...r, decisionHash: "c".repeat(64) }, now)).toThrow("decision_hash");
    expect(() => validateNewsReview(p, { ...r, reviewer: { ...r.reviewer, readEnd: 1 } }, now)).toThrow("full_source_read");
  });
  it("does not accept a completion receipt without its exact persisted event and trigger", () => {
    const p = packet(); p.status = "complete"; p.review.decisionHash = hash;
    p.review.receipt = { decisionHash: hash, snapshotHash: hash, disposition: "publish", triggerId: "trigger", eventId: "event" };
    expect(() => verifyNewsCompletion(p, hash)).toThrow("readback_unconfirmed");
    p.publication = { event: { id: "event", meta: { jobId: p.jobId, decisionHash: hash, snapshotHash: hash } }, trigger: null };
    expect(() => verifyNewsCompletion(p, hash)).toThrow("trigger_readback");
    p.publication.trigger = { id: "trigger", company_id: p.snapshot.company.id, type: "press", signal_date: p.snapshot.observation.event_date, source_url: p.snapshot.observation.source_url,
      metadata: { codexNewsFindings: { [p.jobId]: { decisionHash: hash, snapshotHash: hash } } } };
    expect(() => verifyNewsCompletion(p, hash)).not.toThrow();
  });
});
