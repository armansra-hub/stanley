import { describe, expect, it } from "vitest";
import { savedNonAsset3plProof, NON_ASSET_3PL_TOPIC, type NonAssetObservation } from "./customerNonAsset3pl";

const row = (): NonAssetObservation => ({ id: "observation", company_id: "prospect", is_current: true, feedback_excluded: false,
  source_url: "https://prospect.test/about", title: "About", source_kind: "company_site", event_date: null, observed_at: "2026-09-29",
  evidence_text: "We are a non-asset-based 3PL.", attributes: { topicEvidence: [{ topic: NON_ASSET_3PL_TOPIC, probability: .96,
    start: 0, end: 29, companyRelationship: "direct", companyRelevance: .98 }], packetFindings: [{ start: 0, end: 29,
    criteria: { [NON_ASSET_3PL_TOPIC]: .96 }, rawAnswers: { original: "unchanged" }, model: "jev", questionVersion: "original" }] } });

describe("saved prospect non-asset qualification", () => {
  it("reuses exact paid native receipts and source text without changing them", () => {
    const evidence = row(), original = structuredClone(evidence);
    const proof = savedNonAsset3plProof([evidence]).get("prospect")!;
    expect(proof).toMatchObject({ id: NON_ASSET_3PL_TOPIC, state: "supported", sources: [{ url: evidence.source_url,
      contextPreview: evidence.evidence_text, probability: .96 }] });
    expect(proof.nativeResult).toEqual({ savedObservationReceipts: [{ observationId: evidence.id,
      topicEvidence: evidence.attributes!.topicEvidence, packetFindings: evidence.attributes!.packetFindings }] });
    expect(evidence).toEqual(original);
  });
  it("does not classify from brokerage, text keywords or a missing native answer", () => {
    const evidence = row(); evidence.attributes = { companyRelationship: "direct", companyRelevance: 1, criteria: { rr_t01: 1 } };
    expect(savedNonAsset3plProof([evidence]).size).toBe(0);
  });
  it("excludes retired, dismissed, unsafe and unrelated evidence", () => {
    const evidence = row();
    for (const change of [{ is_current: false }, { feedback_excluded: true }, { source_url: "javascript:alert(1)" },
      { source_url: "https://user:password@prospect.test" }]) {
      expect(savedNonAsset3plProof([{ ...evidence, ...change }]).size).toBe(0);
    }
    for (const change of [{ companyRelationship: "related" }, { companyRelevance: .4 }, { probability: .7 }, { end: 999 }, { start: -1 }]) {
      const altered = row(); const refs = altered.attributes!.topicEvidence as Record<string, unknown>[]; Object.assign(refs[0], change);
      expect(savedNonAsset3plProof([altered]).size).toBe(0);
    }
  });
  it("keeps companies separate and preserves older accepted receipts without inventing raw answers", () => {
    const evidence = row(); delete evidence.attributes!.packetFindings;
    const proof = savedNonAsset3plProof([evidence, { ...row(), company_id: "other", id: "other-observation" }]);
    expect([...proof.keys()]).toEqual(["prospect", "other"]);
    expect(proof.get("prospect")?.nativeResult).toMatchObject({ savedObservationReceipts: [{ packetFindings: [] }] });
  });
});
