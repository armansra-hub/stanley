import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => { throw new Error("No database or provider calls permitted"); } }));
import { validateNewsAnalysis, validateNewsReview, newsDecisionHash, publicNewsPacket, verifyNewsCompletion, type NewsPacket } from "./codexNews";
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
