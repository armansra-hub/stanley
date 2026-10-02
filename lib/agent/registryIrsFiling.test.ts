import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
import { parseRegistryFinding, registryContentHash, type RegistryFinding } from "./registryProfiles";
import { registryIrsFilingEntry, registryIrsFilingCanonicalHash, registryIrsFilingEvidenceHash, registryIrsFilingVerifier, parseRegistryIrsFilingCorroboration, type RegistryIrsFilingCorroboration } from "./registryIrsFiling";

const now = new Date("2026-10-01T07:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ids = { visual: "202620159349300242", direct: "202630989349301128" };
// Fictional company IDs, BMF addresses and test-only witnesses. Entry data is the
// reviewed public source manifest; these tests are not actual company approvals.
function sample(id = ids.direct) {
  const { entry } = registryIrsFilingEntry(id), f = entry.filing;
  const raw = { EIN: f.ein, NAME: f.legalName, STREET: "123 TEST STREET STE 1", CITY: "TEST CITY", STATE: "CA", ZIP: "90012" };
  const identity = { legalName: raw.NAME, addressLine1: raw.STREET, city: raw.CITY, state: raw.STATE, postalCode: raw.ZIP };
  const sourceRow = { ...identity, ein: raw.EIN }, evidence = JSON.stringify(sourceRow) + "\nOriginal public source row: " + JSON.stringify(raw);
  const company = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", netsuite_internal_id: "123", name: f.legalName, domain: id === ids.direct ? "tlsc.org" : "vcmedia.org" };
  const context = { aliases: [] as string[], addresses: [], context: "private context not proof data" };
  const input = { companyId: company.id, internalId: company.netsuite_internal_id, source: "registry", kind: "ops_profile", sourceUrl: "https://www.irs.gov/pub/irs-soi/eo3.csv", detail: "Dated original BMF observation.", evidence,
    registryProfile: { version: 1, dataset: "irs_exempt", recordId: raw.EIN, sourceAsOf: "2026-09-08", observedAt: "2026-09-29T00:00:00Z", identity, facts: [{ field: "ein", value: raw.EIN }], provenance: { sourceRow, quote: evidence, rowSha256: sha(JSON.stringify(raw)) } } };
  return { id, input, row: parseRegistryFinding(input, now), company, context };
}
function proof(s: ReturnType<typeof sample>, change: Partial<Omit<RegistryIrsFilingCorroboration,"reader"|"reviewer">> = {}) {
  const body = { schema: "irs990_ein_domain_v1" as const, entryId: s.id, entrySha256: registryIrsFilingEntry(s.id).sha256,
    canonicalIdentitySha256: registryIrsFilingCanonicalHash(s.company, s.context), mode: s.id === ids.direct ? "declared_domain" as const : "observed_redirect" as const,
    ...(s.id === ids.visual ? { redirect: { requestedUrl: "https://www.vconline.org/", finalUrl: "https://vcmedia.org/", normalizedVisibleTextSha256: sha("Test-only complete visible page"), observedAt: "2026-10-01T06:45:00Z" } } : {}), ...change };
  const evidenceSha256 = registryIrsFilingEvidenceHash(s.row, body);
  return { ...body, reader: { taskId: "/unit-test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/unit-test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const verify = (s: ReturnType<typeof sample>, p: unknown = proof(s)) => registryIrsFilingVerifier()(s.row, p, s.company, s.context, now);
beforeEach(() => { mocks.fetch.mockReset(); mocks.fetch.mockResolvedValue({ status: 200, finalUrl: "https://vcmedia.org/", contentType: "text/html", body: "<p>Test-only complete visible page</p>" }); });
describe("reviewed IRS filing EIN/domain identity", () => {
  it("admits declared canonical domain without any fetch and preserves original addresses, facts and hash", async () => {
    const s = sample(), before = JSON.stringify(s.row), content = registryContentHash(s.row.profile, s.row.sourceUrl, s.row.detail);
    const result = await verify(s);
    expect(result.method).toBe("reviewed_irs_filing_ein_domain"); expect(mocks.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(s.row)).toBe(before); expect(registryContentHash(s.row.profile,s.row.sourceUrl,s.row.detail)).toBe(content);
    expect(result.irsFiling?.registryAddress).toEqual(s.row.profile.identity); expect(JSON.stringify(result)).not.toContain("private context");
  });
  it("verifies exact filing-root redirect and full live text, caching only the bounded fetch", async () => {
    const s = sample(ids.visual), p = proof(s), fn = registryIrsFilingVerifier();
    expect((await fn(s.row,p,s.company,s.context,now)).irsFiling?.observedRedirect).toMatchObject({ status: 200, requestedUrl: "https://www.vconline.org/", finalUrl: "https://vcmedia.org/" });
    await fn(s.row,p,s.company,s.context,now); expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith("https://www.vconline.org/",expect.objectContaining({ maxRedirects: 2,maxBytes: 2_000_000,timeoutMs: 8000 }));
    s.row.detail += " changed"; await expect(fn(s.row,p,s.company,s.context,now)).rejects.toThrow(/review/);
  });
  it.each(["entryId","entrySha256","schema"])("rejects caller changed trusted entry selector %s",async key => {
    const s=sample();await expect(verify(s,{...proof(s),[key]:"forged"})).rejects.toThrow();
  });
  it.each(["rawXml","filing","ein","sourceUrl","archiveSha256"])("rejects client transcription field %s",async key=>{const s=sample();await expect(verify(s,{...proof(s),[key]:"forged"})).rejects.toThrow();});
  it.each(["detail","sourceUrl","evidence","observedAt","rowSha256"])("rejects stale witness after %s changes",async key=>{
    const s=sample(),p=proof(s);if(key==="observedAt")s.row.profile.observedAt="2026-09-30T00:00:00Z";else if(key==="rowSha256")s.row.profile.provenance.rowSha256="f".repeat(64);else(s.row as unknown as Record<string,string>)[key]+=" changed";
    await expect(verify(s,p)).rejects.toThrow(/review/);
  });
  it("rejects canonical address/provenance changes with old witness, and contradictory legal aliases with new witness",async()=>{
    const s=sample(),p=proof(s);s.context.aliases.push("Different Operator LLC");await expect(verify(s,p)).rejects.toThrow(/canonical/);await expect(verify(s)).rejects.toThrow(/operator/);
  });
  it.each(["unrelated.org","tlsc.org.evil.test","https://tlsc.org/path","http://user@tlsc.org/","127.0.0.1"])("rejects wrong/unsafe canonical %s",async d=>{const s=sample();s.company.domain=d;await expect(verify(s)).rejects.toThrow();expect(mocks.fetch).not.toHaveBeenCalled();});
  it("does not use an IRS preparer/related EIN or an altered raw BMF identity",async()=>{
    for(const mutation of [(r:RegistryFinding)=>{r.profile.recordId="954806079";},(r:RegistryFinding)=>{r.profile.provenance.sourceRow.ein="954806079";},(r:RegistryFinding)=>{r.profile.identity.legalName="OTHER NAME";}]){const s=sample();mutation(s.row);await expect(verify(s)).rejects.toThrow();}
  });
  it("does not clip legal suffixes or allow same EIN against a different company name",async()=>{const s=sample();s.company.name="Texas Legal Services Center LLC";await expect(verify(s)).rejects.toThrow(/operator/);});
  it("rejects same-task, stale, future and pre-source-review witnesses",async()=>{
    const s=sample();for(const a of [{taskId:"/unit-test/reader"},{reviewedAt:"2026-09-01T00:00:00Z"},{reviewedAt:"2026-10-02T00:00:00Z"},{reviewedAt:"2026-10-01T06:00:00Z"}]){const p=proof(s);Object.assign(p.reviewer,a);await expect(verify(s,p)).rejects.toThrow();}
  });
  it("does not allow redirect data in direct mode or direct mode to bypass a different filing domain",async()=>{
    const s=sample(),v=sample(ids.visual);await expect(verify(s,{...proof(s),redirect:proof(v).redirect})).rejects.toThrow();
    const p=proof(v,{mode:"declared_domain"});delete p.redirect;const h=registryIrsFilingEvidenceHash(v.row,(({reader,reviewer,...x})=>x)(p));p.reader.evidenceSha256=h;p.reviewer.evidenceSha256=h;await expect(verify(v,p)).rejects.toThrow(/declared domain/);
  });
  it.each(["https://vconline.org/","https://www.vconline.org/about","https://www.vconline.org/?q=x","https://127.0.0.1/","https://user@www.vconline.org/"])("rejects guessed/unsafe filing request %s",async url=>{
    const s=sample(ids.visual),p=proof(s);p.redirect!.requestedUrl=url;await expect(verify(s,p)).rejects.toThrow();expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([{finalUrl:"https://elsewhere.org/"},{status:403},{contentType:"application/json"},{body:"<p>changed</p>"}])("rejects changed actual live response %j",async delta=>{const s=sample(ids.visual);mocks.fetch.mockResolvedValue({status:200,finalUrl:"https://vcmedia.org/",contentType:"text/html",body:"<p>Test-only complete visible page</p>",...delta});await expect(verify(s)).rejects.toThrow(/changed/);});
  it("returns immutable entry copies and rejects caller proof edits after an earlier parse",async()=>{
    const e=registryIrsFilingEntry(ids.direct);e.entry.filing.ein="000000000";expect(registryIrsFilingEntry(ids.direct).entry.filing.ein).toBe("742220750");
    const s=sample(ids.visual),p=parseRegistryIrsFilingCorroboration(proof(s),s.row,now);p.redirect!.normalizedVisibleTextSha256="0".repeat(64);await expect(verify(s,p)).rejects.toThrow(/review/);
  });
});
