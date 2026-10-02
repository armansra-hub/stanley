import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
import fixture from "@/test/fixtures/registry-irs-techfw.json";
import catalog from "./registryIrsFilings.json";
import { parseRegistryFinding, registryContentHash, stableRegistryJson, sameRegistryLegalName } from "./registryProfiles";
import { registryIrsFilingCanonicalHash, registryIrsFilingEntry, registryIrsFilingEvidenceHash, registryIrsFilingVerifier } from "./registryIrsFiling";

// These are explicitly synthetic test witnesses over retained real source data;
// they are never final-content/source approvals or publisher receipts.
const now = new Date("2026-10-02T16:00:00Z"), id = "202512599349301701";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const mode = "reviewed_bmf_sort_and_filer_dba_v1" as const;
const originalCatalog = structuredClone(catalog);
function sample() { return { input: structuredClone(fixture.finding), company: structuredClone(fixture.company), context: structuredClone(fixture.context) }; }
type Sample = ReturnType<typeof sample>;
function proof(s: Sample, useRoles = true) {
 const row=parseRegistryFinding(s.input,now),body={schema:"irs990_ein_domain_v1" as const,entryId:id,entrySha256:registryIrsFilingEntry(id).sha256,canonicalIdentitySha256:registryIrsFilingCanonicalHash(s.company,s.context),mode:"declared_domain" as const,...(useRoles?{nameComparison:mode}:{})};
 const evidenceSha256=registryIrsFilingEvidenceHash(row,body);
 return {...body,reader:{taskId:"/test/irs-subject-reader",reviewedAt:now.toISOString(),evidenceSha256},reviewer:{taskId:"/test/irs-subject-reviewer",reviewedAt:now.toISOString(),evidenceSha256}};
}
const verify=(s:Sample,p:unknown=proof(s))=>registryIrsFilingVerifier()(parseRegistryFinding(s.input,now),p,s.company,s.context,now);
function compiled() { return catalog.entries.find(e=>e.id===id)! as unknown as {filing:Record<string,unknown>;subjectRoles:Record<string,unknown>}; }
beforeEach(()=>{mocks.fetch.mockReset();catalog.entries.splice(0,catalog.entries.length,...structuredClone(originalCatalog.entries));});
describe("finite reviewed BMF alternate-name and filer DBA roles",()=>{
 it("accepts only explicit roles, preserving every original field and all separate names",async()=>{
  const s=sample(),before=JSON.stringify(s),row=parseRegistryFinding(s.input,now),hash=registryContentHash(row.profile,row.sourceUrl,row.detail),v=await verify(s);
  expect(JSON.stringify(s)).toBe(before);expect(registryContentHash(row.profile,row.sourceUrl,row.detail)).toBe(hash);
  expect(v.irsFiling?.nameRoles).toMatchObject({registryLegalName:"FORTWORTH MEDTECH CENTER INC",registryAlternateName:"TECH FORT WORTH",filingLegalName:"Fort Worth MedTech Center Inc",filingDbaLine:"dba TechFW",filingDbaName:"TechFW",canonicalName:"Tech Fort Worth",ein:"752775052"});
  expect(v.irsFiling?.registryAddress).toEqual(s.input.registryProfile.identity);expect(v.irsFiling?.canonicalAddresses).toEqual([]);expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it("keeps the original strict mode and substantive-name comparator unchanged",async()=>{
  const s=sample();await expect(verify(s,proof(s,false))).rejects.toThrow(/legal operator/);
  expect(sameRegistryLegalName("Fort Worth MedTech Center Inc","FORTWORTH MEDTECH CENTER INC")).toBe(false);
  expect(sameRegistryLegalName("Senior on the Go Inc","SENIORS ON THE GO INC")).toBe(false);
 });
 it.each([undefined,null,"",true,"generic_dba",{},[]])("rejects malformed opt-in %j",async value=>{const s=sample();await expect(verify(s,{...proof(s),nameComparison:value})).rejects.toThrow();});
 it("rejects this name mode combined with redirects",async()=>{const s=sample();await expect(verify(s,{...proof(s),mode:"observed_redirect",redirect:{requestedUrl:"https://www.techfortworth.org/",finalUrl:"https://elsewhere.org/",normalizedVisibleTextSha256:"a".repeat(64),observedAt:now.toISOString()}})).rejects.toThrow();expect(mocks.fetch).not.toHaveBeenCalled();});
 it.each(["companyId","internalId","canonicalName","domain","alias","address"])("rejects freshly stamped conflicting canonical %s",async key=>{
  const s=sample();if(key==="companyId"){s.company.id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";s.input.companyId=s.company.id;}else if(key==="internalId"){s.company.netsuite_internal_id="123";s.input.internalId="123";}else if(key==="canonicalName")s.company.name="TechFW";else if(key==="domain")s.company.domain="unrelated.org";else if(key==="alias")s.context.aliases.push("Different Legal Entity" as never);else s.context.addresses.push({addressLine1:"1120 South Freeway",state:"TX",postalCode:"76104"} as never);
  await expect(verify(s)).rejects.toThrow();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it("requires changed detail to receive new content-bound witnesses",async()=>{
  const s=sample(),p=proof(s);s.input.detail="New test-only independently reviewed detail.";await expect(verify(s,p)).rejects.toThrow(/review/);await expect(verify(s)).resolves.toHaveProperty("method","reviewed_irs_filing_ein_domain");
 });
 it.each(["observedAt","fact","sourceUrl"])("rejects freshly witnessed alteration to original %s",async key=>{
  const s=sample();if(key==="observedAt")s.input.registryProfile.observedAt="2026-09-29T23:13:11Z";else if(key==="sourceUrl")s.input.sourceUrl="https://www.irs.gov/pub/irs-soi/eo2.csv";else{const raw=JSON.parse(s.input.evidence.split("\nOriginal public source row: ")[1]);raw.ASSET_AMT="1";s.input.registryProfile.facts.find(f=>f.field==="total_assets")!.value=1;s.input.registryProfile.provenance.sourceRow.total_assets=1;const rawText=JSON.stringify(raw);s.input.evidence=JSON.stringify(s.input.registryProfile.provenance.sourceRow)+"\nOriginal public source row: "+rawText;s.input.registryProfile.provenance.quote=s.input.evidence;s.input.registryProfile.provenance.rowSha256=sha(rawText);}await expect(verify(s)).rejects.toThrow();
 });
 it("rejects changed BMF SORT_NAME even when original framing and hashes are rebuilt",async()=>{
  const s=sample(),parts=s.input.evidence.split("\nOriginal public source row: "),raw=JSON.parse(parts[1]);raw.SORT_NAME="TECHFW";parts[1]=JSON.stringify(raw);s.input.evidence=parts.join("\nOriginal public source row: ");s.input.registryProfile.provenance.quote=s.input.evidence;s.input.registryProfile.provenance.rowSha256=sha(parts[1]);await expect(verify(s)).rejects.toThrow(/scope|profile/);
 });
 it.each(["filingLegalName","filingDbaLine","filingDbaName","bmfLegalName","bmfSortName","declaredDomain","canonicalIdentitySha256","profileSha256"])("rejects malformed compiled role %s with a newly hashed entry",async field=>{compiled().subjectRoles[field]="changed";await expect(verify(sample())).rejects.toThrow();});
 it.each(["EIN","BusinessNameLine1Txt","BusinessNameLine2Txt"])("rejects mismatching source Filer role %s even after fragment digest is recomputed",async tag=>{
  const r=compiled().subjectRoles;r.filerIdentityXml=String(r.filerIdentityXml).replace(new RegExp("<"+tag+">[^<]*</"+tag+">"),"<"+tag+">changed</"+tag+">");r.filerIdentityXmlSha256=sha(String(r.filerIdentityXml));await expect(verify(sample())).rejects.toThrow(/role/);
 });
 it("rejects dropped DBA and duplicate XML roles",async()=>{
  const c=compiled();delete c.filing.legalNameLine2;await expect(verify(sample())).rejects.toThrow(/role/);
  c.filing.legalNameLine2="dba TechFW";const r=c.subjectRoles;r.filerIdentityXml=String(r.filerIdentityXml).replace("</Filer>","<EIN>752775052</EIN></Filer>");r.filerIdentityXmlSha256=sha(String(r.filerIdentityXml));await expect(verify(sample())).rejects.toThrow(/duplicated/);
 });
 it("rejects role option on an old unconfigured entry",async()=>{const s=sample();await expect(verify(s,{...proof(s),entryId:"202630989349301128",entrySha256:registryIrsFilingEntry("202630989349301128").sha256})).rejects.toThrow();});
 it("retains exact final independent witness, entry and content gates",async()=>{
  const s=sample();const p=proof(s);await expect(verify(s,{...p,reviewer:{...p.reviewer,taskId:p.reader.taskId}})).rejects.toThrow(/independent/);await expect(verify(s,{...p,entrySha256:"a".repeat(64)})).rejects.toThrow(/entry/);await expect(verify(s,{...p,reviewer:{...p.reviewer,evidenceSha256:"a".repeat(64)}})).rejects.toThrow(/review/);
 });
 it("entry copies cannot mutate the trusted source roles",()=>{const a=registryIrsFilingEntry(id);if("subjectRoles" in a.entry && a.entry.subjectRoles)a.entry.subjectRoles.filingDbaLine="changed";const b=registryIrsFilingEntry(id);expect(b.sha256).toBe(sha(stableRegistryJson(b.entry)));if("subjectRoles" in b.entry && b.entry.subjectRoles)expect(b.entry.subjectRoles.filingDbaLine).toBe("dba TechFW");});
});
