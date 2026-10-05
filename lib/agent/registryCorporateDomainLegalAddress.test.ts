import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => { throw new Error("Offline tests only"); } }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import fixture from "../../test/fixtures/corporate-domain-legal-address.json";
import { buildCompanyIdentityContext } from "../companyIdentity";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { registryWebsiteText } from "./registryWebsiteText";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier } from "./registryWebsite";
import type { RegistryWebsiteCorroboration } from "./registryWebsite";
const now = new Date("2026-10-05T17:00:00Z"), sha = (x: string) => createHash("sha256").update(x).digest("hex");
type Fixture = typeof fixture.fixtures[number];
const clone = <T,>(x:T):T => JSON.parse(JSON.stringify(x));
function setup(f: Fixture, index = 0) {
  const row = parseRegistryFinding(clone(f.rows[index]), now), company = clone(f.company), context = buildCompanyIdentityContext(company, { record: clone(f.record) });
  const text = registryWebsiteText(f.html), quote = f.quote ?? text;
  const base = { crmDomainReference: context.crmDomainReference!, observedAt:f.observedAt, sourceUrl:f.sourceUrl, subject:f.subject,
    normalizedVisibleTextSha256:sha(text), quote, quoteSha256:sha(quote), address:clone(f.address) as NonNullable<RegistryWebsiteCorroboration["address"]> };
  function sign(extra:Partial<typeof base> = {}) {
    const b = {...base,...extra}, evidenceSha256=registryWebsiteEvidenceHash(row,b);
    return {...b,reader:{taskId:"/test/reader",reviewedAt:now.toISOString(),evidenceSha256},reviewer:{taskId:"/test/reviewer",reviewedAt:now.toISOString(),evidenceSha256}};
  }
  fetch.mockResolvedValue({status:200,finalUrl:f.sourceUrl,contentType:"text/html",body:f.html});
  return {row,company,context,base,sign,verify:(p=sign())=>registryWebsiteVerifier()(row,p,company,context,now)};
}
beforeEach(()=>fetch.mockReset());
describe("ordinary exact legal/full address on server-derived CRM corporate domain",()=>{
  for(const f of fixture.fixtures) for(let i=0;i<f.rows.length;i++) it(`replays complete retained ${f.id}/${f.rows[i].registryProfile.dataset} without DBA or canonical rewrite`,async()=>{
    const s=setup(f,i),before=JSON.stringify([s.row,s.company,s.context]),hash=registryContentHash(s.row.profile,s.row.sourceUrl,s.row.detail);
    const v=await s.verify(); expect(v.website?.binding).toBe("exact_legal_name_address");
    expect(v.website?.crmDomainReferenceVerification).toEqual({...s.context.crmDomainReference,sourceRole:"latest_retained_labelled_provisioning_email_domain_reference",canonicalDomain:f.company.domain,canonicalDomainChanged:false});
    expect(v.sourceIds).toEqual([`website:sha256:${sha(registryWebsiteText(f.html))}`,`netsuite_record:${f.record.id}:header:sha256:${sha(f.record.header)}`]);
    expect(v.website).not.toHaveProperty("mode");expect(v.website).not.toHaveProperty("originalDba");
    expect(JSON.stringify([s.row,s.company,s.context])).toBe(before);expect(registryContentHash(s.row.profile,s.row.sourceUrl,s.row.detail)).toBe(hash);
    if(s.row.profile.dataset==='sba_7a')expect(s.row.profile.identity).not.toHaveProperty('countryCode');
  });
  it.each([
    {legalName:"Harbor LOGISTICS LLC"},{legalName:"Harbor WEST LOGISTICS INC"},{addressLine1:"1047 GREENS PARKWAY"},
    {addressLine2:"SUITE 9"},{city:"DALLAS"},{state:"NY"},{postalCode:"77068"},{countryCode:"CA"}
  ])("rejects re-signed target identity mutation %j",async mutation=>{
    const s=setup(fixture.fixtures[0]);Object.assign(s.row.profile.identity,mutation);await expect(s.verify()).rejects.toThrow();
  });
  it("retains Prairie Suite108 and rejects missing/conflicting full unit",async()=>{
    for(const street of ["6667 W OLD SHAKOPEE RD","6667 W OLD SHAKOPEE RD STE 109"]){const s=setup(fixture.fixtures[1]);s.row.profile.identity.addressLine1=street;await expect(s.verify()).rejects.toThrow('street or unit');}
  });
  it.each(["recordId","headerSha256","domain","capturedAt","companyName"])("rejects re-signed reference %s different from server",async field=>{
    const s=setup(fixture.fixtures[0]),ref={...s.context.crmDomainReference!,[field]:field==='recordId'?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':field==='headerSha256'?'a'.repeat(64):field==='capturedAt'?'2026-07-29T00:00:00Z':'other-company.com'};
    await expect(s.verify(s.sign({crmDomainReference:ref}))).rejects.toThrow('server-derived');
  });
  it.each(["https://harbor-example.com.evil.com/contact","https://other.harbor-example.com/contact","https://www.Harborlogistics.com/contact","https://www.harbor-example.com/contact?x=1"])("rejects unbound source %s",async sourceUrl=>{
    const s=setup(fixture.fixtures[0]);await expect(s.verify(s.sign({sourceUrl}))).rejects.toThrow();
  });
  it("rejects absent reference and mismatched canonical exact record identity",async()=>{
    const s=setup(fixture.fixtures[0]),proof=s.sign();delete s.context.crmDomainReference;await expect(s.verify(proof)).rejects.toThrow('server-derived');
    const x=setup(fixture.fixtures[0]);x.company.netsuite_internal_id='999';await expect(x.verify()).rejects.toThrow('server-derived');
  });
  it("binds the whole publication content as well as the exact row id/hash",()=>{
    for(const change of ['detail','evidence','identity'] as const){const s=setup(fixture.fixtures[0]),proof=s.sign();if(change==='identity')s.row.profile.identity.city='Elsewhere';else s.row[change]+=' changed';expect(()=>parseRegistryWebsiteCorroboration(proof,s.row,now)).toThrow('bind exact');}
  });
  it("rejects independent, chronological and freshness defects on direct verification",async()=>{
    for(const mutate of [(p:RegistryWebsiteCorroboration)=>{p.reviewer.taskId=p.reader.taskId;},(p:RegistryWebsiteCorroboration)=>{p.reader.reviewedAt='2026-10-05T15:00:00Z';},(p:RegistryWebsiteCorroboration)=>{p.reviewer.reviewedAt='2026-10-05T16:00:00Z';},(p:RegistryWebsiteCorroboration)=>{p.reader.reviewedAt='2026-09-01T00:00:00Z';}]){const s=setup(fixture.fixtures[0]),proof=s.sign();mutate(proof);await expect(s.verify(proof)).rejects.toThrow();}
  });
  it("retains whole-page content and same-path redirect gates",async()=>{
    for(const page of [{status:200,finalUrl:fixture.fixtures[0].sourceUrl,contentType:'text/html',body:fixture.fixtures[0].html+' changed'}, {status:200,finalUrl:'https://www.harbor-example.com/elsewhere',contentType:'text/html',body:fixture.fixtures[0].html}]){const s=setup(fixture.fixtures[0]);fetch.mockResolvedValue(page);await expect(s.verify()).rejects.toThrow();}
  });
  it("does not enable identifier or two-page CRM combinations",()=>{
    const s=setup(fixture.fixtures[0]);for(const mode of ['registry_identifier','site_operator_address'])expect(()=>parseRegistryWebsiteCorroboration({...s.sign(),mode},s.row,now)).toThrow('CRM domain reference');
  });
  it("ordinary CRM does not accept a different explicit canonical legal form",async()=>{
    const f=clone(fixture.fixtures[0]);f.company.name='Harbor Logistics LLC';f.record.header=f.record.header.replace(/(Company Name\s+)Harbor Logistics/, '$1Harbor Logistics LLC').slice(0,6000);const s=setup(f);expect(s.context.crmDomainReference).toBeDefined();await expect(s.verify()).rejects.toThrow('canonical legal entity');
  });
});
