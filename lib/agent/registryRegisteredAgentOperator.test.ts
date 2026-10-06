import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import catalog from "./registryOfficialApiEntries.json";
import { registryOfficialApiCanonicalHash, registryOfficialApiEntry, registryOfficialApiEvidenceHash, verifyRegistryOfficialApi, type RegistryOfficialApiEntry } from "./registryOfficialApi";
import { stableRegistryJson, type RegistryFinding } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { RegisteredAgentOperatorBridge } from "./registryRegisteredAgentOperator";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const objectHash = (x: unknown) => sha(stableRegistryJson(x));
const now = new Date("2026-10-06T12:00:00Z"), date = "2026-10-06T10:00:00Z";
const review = (label: string, at = "2026-10-06T11:00:00Z") => ({ taskId: `/test-only/${label}`, reviewedAt: at, receiptSha256: sha(label) });
// Completely synthetic source and company. Test-only catalog mutation is memory-only.
function setup(apostrophe = false) {
  const company = { id: "11111111-1111-4111-8111-111111111111", netsuite_internal_id: "12345", name: "Northridge Advisors", domain: "northridge-advisors.com" };
  const context: CompanyIdentityContext = { aliases: ["Northridge Advisors LLC"], addresses: [{ addressLine1: "200 Current Street", addressLine2: "Suite 2", city: "Denver", state: "CO", postalCode: "80202", countryCode: "US", sourceKind: "netsuite_record", sourceId: "synthetic-record", capturedAt: "2026-09-01T00:00:00Z" }], context: "" };
  const original = { entityid: "20201111111", entityname: "Northridge Advisors LLC", principaladdress1: "100 Historical Street", principaladdress2: "Suite 1", principalcity: "Niwot", principalstate: "CO", principalzipcode: "80503", principalcountry: "US", entitystatus: "Good Standing", entitytype: "DLLC", entityformdate: "2020-01-01T00:00:00.000" };
  const raw = JSON.stringify(original), identity = { legalName: original.entityname, addressLine1: original.principaladdress1, addressLine2: original.principaladdress2, city: original.principalcity, state: original.principalstate, postalCode: original.principalzipcode, countryCode: "US" as const };
  const row: RegistryFinding = { label: `registry:co_sos:${original.entityid}`, companyId: company.id, internalId: company.netsuite_internal_id, sourceUrl: `https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=${original.entityid}`, evidence: raw, detail: "TEST ONLY. Reviewed company association; both addresses remain separate.",
    profile: { version: 1, dataset: "co_sos", recordId: original.entityid, displayLabel: "Colorado business registration", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T12:00:00Z", identity,
      facts: [{ field: "registration_number", label: "Registration number", value: original.entityid }], provenance: { rowSha256: sha(raw), quote: raw, sourceRow: { ...identity, registration_number: original.entityid } } } };
  const sourceRow = { ...original, agentfirstname: "MORGAN", agentmiddlename: "ALEXANDRA H", agentlastname: apostrophe ? "OSHORE" : "LANE", agentprincipaladdress1: original.principaladdress1, agentprincipalcity: original.principalcity, agentprincipalstate: "CO", agentprincipalzipcode: "80503", agentprincipalcountry: "US" };
  const sourceRaw = JSON.stringify(sourceRow), sourceUrl = `https://data.colorado.gov/resource/4ykn-tg5h.json?$select=entityid,entityname,agentfirstname,agentlastname&$where=entityid+in+(${original.entityid})&$order=entityid&$limit=1`;
  const last = apostrophe ? "O’Shore" : "Lane", legalText = "These terms are between Northridge Advisors LLC and you.", personText = `Morgan ${last}\nFounder and CEO`;
  const page = (slug: string, text: string) => ({ requestedUrl: `https://${company.domain}/${slug}/`, finalUrl: `https://${company.domain}/${slug}/`, status: 200, contentType: "text/html; charset=utf-8", observedAt: date, hops: [{ url: `https://${company.domain}/${slug}/`, status: 200 }], htmlSha256: sha(`<p>${text}</p>`), textSha256: sha(text), receiptSha256: sha(slug), text, representation: "complete_retained_static_text_v1" as const });
  const pages = [page("terms", legalText), page("team", personText)];
  const quote = (i: number, html: string) => ({ pageTextSha256: pages[i].textSha256, start: 0, end: pages[i].text.length, text: pages[i].text, ordinaryHtml: { start: 0, end: html.length, html, sha256: sha(html) } });
  const bridge: RegisteredAgentOperatorBridge = { schema: "reviewed_registered_agent_operator_v1", canonicalName: company.name, siteLegalName: "Northridge Advisors LLC", sourceInputSha256: sha("test-only-input"), primaryDecisionSha256: sha("test-only-primary-decision"), independentDecisionSha256: sha("test-only-independent-decision"),
    officialAgent: { firstName: "MORGAN", middleName: "ALEXANDRA H", lastName: sourceRow.agentlastname, suffix: "" }, siteOperator: { firstName: "Morgan", lastName: last, displayName: `Morgan ${last}`, role: "Founder and CEO" }, pages,
    legalQuote: quote(0, `<p>${legalText}</p>`), operatorQuote: quote(1, `<h3>Morgan ${last}</h3><p>Founder and CEO</p>`),
    limitations: { association: "independently_reviewed_company_inference", statutoryPersonIdentityVerified: false, omittedMiddleNamesVerified: false, addressEquivalenceClaimed: false, agentOwnershipClaimed: false, canonicalIdentityChanged: false, literalDifferences: ["Historical Suite 1 and current Suite 2 are different; omitted middle names are unverified."] } };
  const entry: RegistryOfficialApiEntry = { id: "test-only-operator", companyId: company.id, internalId: company.netsuite_internal_id, canonicalDomain: company.domain, canonicalIdentitySha256: registryOfficialApiCanonicalHash(company, context), sourceKind: "colorado_business_entity",
    source: { requestedUrl: sourceUrl, finalUrl: sourceUrl, status: 200, contentType: "application/json", observedAt: date, responseSha256: sha(`[${sourceRaw}]`), receiptSha256: sha("test-only-official-receipt"), rawRow: sourceRaw, rawRowSha256: sha(sourceRaw), arrayIndex: 0, byteOffset: 1, byteLength: Buffer.byteLength(sourceRaw) },
    sourceReader: review("source-primary"), sourceReviewer: review("source-independent", "2026-10-06T11:01:00Z"), originalReviews: { primary: review("historical-primary", "2026-09-30T00:00:00Z"), independent: review("historical-independent", "2026-09-30T01:00:00Z"), packetSha256: sha("test-only-original-packet") },
    target: { dataset: "co_sos", recordId: original.entityid, sourceUrl: row.sourceUrl, rowSha256: sha(raw), evidenceSha256: sha(raw), identitySha256: objectHash(identity), sourceRowSha256: objectHash(row.profile.provenance.sourceRow), factsSha256: objectHash(row.profile.facts.map(({ field, value }) => ({ field, value }))), sourceAsOf: row.profile.sourceAsOf!, observedAt: row.profile.observedAt },
    anchor: { mode: "reviewed_registered_agent_operator" }, registeredAgentOperatorBridge: bridge };
  const memory = catalog as unknown as { version: number; entries: RegistryOfficialApiEntry[] }; memory.entries = [entry];
  const proof = () => { const bare = { schema: "official_api_roles_v1" as const, entryId: entry.id, entrySha256: registryOfficialApiEntry(entry.id).sha256, canonicalIdentitySha256: entry.canonicalIdentitySha256 }; const evidenceSha256 = registryOfficialApiEvidenceHash(row, bare); return { ...bare, reader: { taskId: "/test-only/final-primary", reviewedAt: "2026-10-06T11:30:00Z", evidenceSha256 }, reviewer: { taskId: "/test-only/final-independent", reviewedAt: "2026-10-06T11:31:00Z", evidenceSha256 } }; };
  const check = (p = proof()) => verifyRegistryOfficialApi(row, p, company, context, now);
  const rawChange = (delta: Record<string, string>) => { entry.source.rawRow = JSON.stringify({ ...JSON.parse(entry.source.rawRow), ...delta }); entry.source.rawRowSha256 = sha(entry.source.rawRow); entry.source.byteLength = Buffer.byteLength(entry.source.rawRow); };
  return { company, context, row, entry, bridge, memory, proof, check, rawChange };
}
type Fixture = ReturnType<typeof setup>;
describe("compiled reviewed registered-agent/operator inference", () => {
  for (const apostrophe of [false, true]) it(`accepts reviewed literal first/last correspondence, apostrophe=${apostrophe}`, () => {
    const f = setup(apostrophe), before = JSON.stringify([f.row, f.context]), result = f.check();
    assert.equal(result.method, "reviewed_official_registration_history"); assert.equal(JSON.stringify([f.row, f.context]), before);
    assert.deepEqual((result.officialHistory as Record<string, unknown>).targetAddress, { role: "principal_street", addressLine1: "100 Historical Street", addressLine2: "Suite 1", city: "Niwot", state: "CO", postalCode: "80503", countryCode: "US" });
    assert.ok(JSON.stringify(result).includes("does not certify a statutory person identity"));
  });
  const negatives: [string, (f: Fixture) => void][] = [
    ["company UUID", f => { f.company.id = "22222222-2222-4222-8222-222222222222"; }],
    ["Internal ID", f => { f.row.internalId = "999"; }],
    ["profile ID", f => { f.row.profile.recordId = "20202222222"; }],
    ["original suite changed", f => { f.row.profile.identity.addressLine2 = "Suite 9"; }],
    ["raw role physical suite changed", f => f.rawChange({ principaladdress2: "Suite 9" })],
    ["raw role target entity", f => f.rawChange({ entityid: "20202222222" })],
    ["raw role source hash", f => { f.entry.source.rawRowSha256 = sha("wrong"); }],
    ["wrong source timestamp", f => { f.entry.source.observedAt = "2026-10-06T11:00:00.0000001Z"; }],
    ["wrong literal agent first", f => { f.bridge.officialAgent.firstName = "JORDAN"; }],
    ["wrong literal agent middle", f => { f.bridge.officialAgent.middleName = ""; }],
    ["registered organization agent", f => f.rawChange({ agentorganizationname: "Some Agent LLC" })],
    ["different person", f => { f.bridge.siteOperator.firstName = "Jordan"; }],
    ["person surname prefix", f => { f.bridge.siteOperator.lastName = "Laneville"; }],
    ["nonoperator title", f => { f.bridge.siteOperator.role = "Customer Success Manager"; }],
    ["conflicting site legal form", f => { f.bridge.siteLegalName = "Northridge Advisors Inc."; }],
    ["conflicting canonical legal form", f => { f.context.aliases.push("Northridge Advisors Inc."); f.entry.canonicalIdentitySha256 = registryOfficialApiCanonicalHash(f.company, f.context); }],
    ["wrong complete source text hash", f => { f.bridge.pages[0].text += "changed"; }],
    ["quote offsets", f => { f.bridge.operatorQuote.start++; }],
    ["raw HTML pin", f => { f.bridge.operatorQuote.ordinaryHtml.sha256 = sha("wrong"); }],
    ["inert raw HTML", f => { const h = f.bridge.operatorQuote.ordinaryHtml; h.html = `<template>${h.html}</template>`; h.end = h.html.length; h.sha256 = sha(h.html); }],
    ["name only in an attribute", f => { const h = f.bridge.operatorQuote.ordinaryHtml; h.html = '<div title="Morgan Lane Founder and CEO">Other Person</div>'; h.end = h.html.length; h.sha256 = sha(h.html); }],
    ["off-domain page", f => { f.bridge.pages[0].finalUrl = "https://other-company.com/terms/"; f.bridge.pages[0].hops[0].url = f.bridge.pages[0].finalUrl; }],
    ["subdomain is not exact canonical", f => { f.bridge.pages[0].requestedUrl = f.bridge.pages[0].finalUrl = "https://other.northridge-advisors.com/terms/"; f.bridge.pages[0].hops[0].url = f.bridge.pages[0].finalUrl; }],
    ["wrong canonical domain", f => { f.company.domain = "northridge-advisors.co"; }],
    ["off-domain intermediate redirect", f => { f.bridge.pages[0].hops.unshift({ url: "https://elsewhere.com/", status: 302 }); }],
    ["source read predates page at 100ns", f => { f.bridge.pages[0].observedAt = "2026-10-06T11:00:00.0000001Z"; }],
    ["same source actor", f => { f.entry.sourceReviewer.taskId = f.entry.sourceReader.taskId; }],
    ["source review order at 100ns", f => { f.entry.sourceReader.reviewedAt = "2026-10-06T11:01:00.0000001Z"; }],
    ["false person certification", f => { (f.bridge.limitations as unknown as Record<string, unknown>).statutoryPersonIdentityVerified = true; }],
    ["missing address difference statement", f => { f.bridge.limitations.literalDifferences = []; }],
    ["unreviewed input pin missing", f => { f.bridge.sourceInputSha256 = ""; }],
    ["unreviewed decision pin missing", f => { f.bridge.independentDecisionSha256 = ""; }],
    ["bridge in legacy anchor", f => { f.entry.anchor = { mode: "company_email_domain" }; }],
    ["mixed name bridge", f => { (f.entry as unknown as Record<string, unknown>).nameBridge = {}; }],
    ["missing bridge", f => { delete f.entry.registeredAgentOperatorBridge; }],
    ["unknown catalog ID", f => { f.memory.entries = []; }],
    ["duplicate catalog ID", f => { f.memory.entries.push(structuredClone(f.entry)); }],
  ];
  for (const [name, change] of negatives) it(`rejects ${name} even with newly bound test-only final witnesses`, () => { const f = setup(); change(f); assert.throws(() => f.check()); });
  it("rejects stale final witnesses after a detail edit", () => { const f = setup(), p = f.proof(); f.row.detail += " altered"; assert.throws(() => f.check(p)); });
  it("rejects unapproved source actor reattribution under the old catalog pin", () => { const f = setup(), p = f.proof(); f.entry.originalReviews.primary.taskId = "/test-only/reattributed"; assert.throws(() => f.check(p)); });
  it("rejects caller-authored catalog evidence", () => { const f = setup(); assert.throws(() => verifyRegistryOfficialApi(f.row, { ...f.proof(), entry: f.entry }, f.company, f.context, now)); });
  it("requires actual distinct fresh ordered final witnesses", () => { for (const mode of ["missing", "same", "early", "future"]) { const f = setup(), p = f.proof(); if (mode === "missing") delete (p as Partial<typeof p>).reviewer; if (mode === "same") p.reviewer.taskId = p.reader.taskId; if (mode === "early") p.reader.reviewedAt = "2026-10-06T09:00:00Z"; if (mode === "future") p.reviewer.reviewedAt = "2026-10-08T00:00:00Z"; assert.throws(() => f.check(p)); } });
});

describe("independent-review regressions: complete names, hidden spans and exact final time", () => {
  it("preserves a literal omitted site suffix without certifying the full legal form", () => {
    const f = setup(), p = f.bridge.pages[0], q = f.bridge.legalQuote;
    f.bridge.siteLegalName = "Northridge Advisors";
    p.text = "These terms are between Northridge Advisors and you."; p.textSha256 = sha(p.text);
    q.pageTextSha256 = p.textSha256; q.text = p.text; q.end = p.text.length;
    q.ordinaryHtml.html = "<p>" + p.text + "</p>"; q.ordinaryHtml.end = q.ordinaryHtml.html.length;
    q.ordinaryHtml.sha256 = sha(q.ordinaryHtml.html);
    f.bridge.limitations.literalDifferences.push("The site company name omits LLC; it does not establish the original official entity's legal form.");
    const result = f.check();
    assert.equal(f.bridge.siteLegalName, "Northridge Advisors");
    assert.equal(f.row.profile.identity.legalName, "Northridge Advisors LLC");
    assert.ok(JSON.stringify(result).includes("The literal site name may omit the official legal suffix"));
  });
  function replacePersonQuote(f: ReturnType<typeof setup>, name: string) {
    const p = f.bridge.pages[1], q = f.bridge.operatorQuote;
    p.text = name + "\nFounder and CEO"; p.textSha256 = sha(p.text);
    q.pageTextSha256 = p.textSha256; q.text = p.text; q.end = p.text.length;
    q.ordinaryHtml.html = "<h3>" + name + "</h3><p>Founder and CEO</p>";
    q.ordinaryHtml.end = q.ordinaryHtml.html.length; q.ordinaryHtml.sha256 = sha(q.ordinaryHtml.html);
  }
  for (const name of ["Morgan Laneville", "Morgan Lane-Smith", "Morgan Lane\u0301"]) it("rejects non-complete quoted person " + name, () => {
    const f = setup(); replacePersonQuote(f, name); assert.throws(() => f.check(), /legal\/operator literal quote differs/);
  });
  it("rejects boolean hidden ordinary HTML", () => {
    const f = setup(), h = f.bridge.operatorQuote.ordinaryHtml;
    h.html = "<div hidden>" + h.html + "</div>"; h.end = h.html.length; h.sha256 = sha(h.html);
    assert.throws(() => f.check(), /ordinary reviewed HTML span differs/);
  });
  it("rejects a final reader 100ns before the source reviewer", () => {
    const f = setup(); f.entry.sourceReviewer.reviewedAt = "2026-10-06T11:30:00.0000001Z";
    assert.throws(() => f.check(), /exact final chronology differs/);
  });
  it("rejects an independent final 100ns before its primary", () => {
    const f = setup(), p = f.proof(); p.reader.reviewedAt = "2026-10-06T11:30:00.0000001Z";
    p.reviewer.reviewedAt = "2026-10-06T11:30:00.0000000Z";
    assert.throws(() => f.check(p), /exact final chronology differs/);
  });
  it("accepts exact ordered 100ns instants with equivalent timezone offsets", () => {
    const f = setup(), p = f.proof(); p.reader.reviewedAt = "2026-10-06T07:30:00.0000001-04:00";
    p.reviewer.reviewedAt = "2026-10-06T11:30:00.0000001Z"; assert.doesNotThrow(() => f.check(p));
  });
});
