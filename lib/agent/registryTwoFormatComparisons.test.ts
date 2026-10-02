import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/triggers/urlSafety', async original => ({ ...await original<typeof import('@/lib/triggers/urlSafety')>(), fetchPublicHttpText: fetch }));
import type { CompanyIdentityContext } from '@/lib/companyIdentity';
import { type RegistryProfile, parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, sameRegistryLegalName, verifyRegistryIdentity } from './registryProfiles';
import { registryWebsiteEvidenceHash, registryWebsiteVerifier, parseRegistryWebsiteCorroboration, type RegistryWebsiteCorroboration } from './registryWebsite';
import { registryWebsiteText } from './registryWebsiteText';
const now=new Date('2026-10-02T21:45:00Z'), sha=(x:string)=>createHash('sha256').update(x).digest('hex');
// Self-contained synthetic records. Retained-source replays live outside the repo.
function testFinding(identity: RegistryProfile['identity'], dataset: 'fmcsa' | 'sba_504') {
 const sourceRow={...identity,...(dataset==='fmcsa'?{usdot_number:'12345'}:{approval_amount:500000})}, evidence=JSON.stringify(sourceRow), rowSha256=sha(evidence);
 return { internalId:'123', companyId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source:'registry', kind:'ops_profile',
  sourceUrl:dataset==='fmcsa'?'https://data.transportation.gov/resource/test.json':'https://data.sba.gov/test.csv', evidence,
  registryProfile:{version:1,dataset,recordId:dataset==='fmcsa'?'12345':'row-'+rowSha256,sourceAsOf:'2026-09-01',observedAt:now.toISOString(),identity,
   facts:dataset==='fmcsa'?[{field:'usdot_number',value:'12345'}]:[{field:'approval_amount',value:500000}],
   provenance:{rowSha256,quote:evidence,sourceRow}}};
}
function testContext(name:string,domain:string,address:CompanyIdentityContext['addresses'][number]) {
 return {name,domain,legalNames:[] as string[],addresses:[address]};
}
const syntheticHtml='<h1>Steins Aircraft Services</h1><p>Contact Details Address: 2651 Aviation Drive Waukesha WI 53188</p><p>Other location: 4222 91st Ave Kenosha WI 53144</p>';
const fixture={
 terra:{finding:testFinding({legalName:'Terra Products Company LLC',addressLine1:'2144 OLD HWY 218 SOUTH',city:'IOWA CITY',state:'IA',postalCode:'52246',countryCode:'US'},'fmcsa'),
  context:testContext('Terra Products Company','example.com',{addressLine1:'2144 Old Hwy 218 S, Iowa City IA United States (US)',city:'Iowa City',state:'IA',postalCode:'52246',countryCode:'US',sourceKind:'netsuite_record',sourceId:'synthetic-crm',capturedAt:'2026-09-01T00:00:00Z'})},
 stein:{finding:testFinding({legalName:"STEIN'S AIRCRAFT SERVICES, LLC",addressLine1:'2651 Aviation Drive.',city:'Waukesha',state:'WI',postalCode:'53188'},'sba_504'),
  context:testContext("Stein's Aircraft Services, LLC",'example.com',{addressLine1:'4222 91st Ave',city:'Kenosha',state:'WI',postalCode:'53144',countryCode:'US',sourceKind:'netsuite_record',sourceId:'synthetic-crm',capturedAt:'2026-09-01T00:00:00Z'}),
  page:{url:'https://example.com/contact/',html:syntheticHtml,text:registryWebsiteText(syntheticHtml)}}
};
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
const terraRow=parseRegistryFinding(fixture.terra.finding,now), terra=fixture.terra.context;
const source=terraRow.profile.identity, crm=terra.addresses[0];
const ctx=(c:typeof terra)=>({context:'',aliases:c.legalNames,addresses:c.addresses});
describe('exact structured US locality repeated in street',()=>{
 it('compares the duplicated locality without rewriting the source or fingerprints',()=>{
  const before=JSON.stringify([fixture.terra.finding,terra]);const street=registryStreet(crm),hash=registryContentHash(terraRow.profile,terraRow.sourceUrl,terraRow.detail);
  expect(sameRegistryStreet(source,crm)).toBe(true);expect(sameRegistryStreet(crm,source)).toBe(true);
  expect(verifyRegistryIdentity(terraRow.profile,{name:terra.name},ctx(terra),[],now)).toMatchObject({method:'exact_legal_name_address',sourceIds:[crm.sourceId]});
  expect(JSON.stringify([fixture.terra.finding,terra])).toBe(before);expect(registryStreet(crm)).toBe(street);expect(registryContentHash(terraRow.profile,terraRow.sourceUrl,terraRow.detail)).toBe(hash);
 });
 it('preserves a complete unit on either address line',()=>{
  expect(sameRegistryStreet({...crm,addressLine1:'2144 Old Hwy 218 S Suite 7, Iowa City IA United States (US)'},{...source,addressLine1:'2144 OLD HWY 218 SOUTH STE 7'})).toBe(true);
  expect(sameRegistryStreet({...crm,addressLine2:'Suite 7'},{...source,addressLine2:'Ste 7'})).toBe(true);
 });
 it.each([
  '2144 Old Hwy 218 S, Iowa City IL United States (US)',
  '2144 Old Hwy 218 S, Cedar Rapids IA United States (US)',
  '2144 Old Hwy 218 S, Iowa City IA Canada (CA)',
  '2144 Old Hwy 218 S, Iowa City IA United States (CA)',
  '2144 Old Hwy 218 S, Iowa City IA United States',
  '2144 Old Hwy 218 S, Iowa City IA US',
  '2144 Old Hwy 218 S Iowa City IA United States (US)',
  '2144 Old Hwy 218 S, Iowa City IA 52246 United States (US)',
  '2144 Old Hwy 218 S, Iowa City IA United States (US) Suite 7',
  '2144 Old Hwy 218 S Suite 7, Iowa City IA United States (US)',
  '2144 Old Hwy 219 S, Iowa City IA United States (US)',
  '2145 Old Hwy 218 S, Iowa City IA United States (US)',
  '2144 Old US Hwy 218 S, Iowa City IA United States (US)',
  '2144 Old Hwy218 S, Iowa City IA United States (US)',
  '2144 Old Hwy 218 S, Iowa City IA United States (US), Iowa City IA United States (US)',
 ])('rejects substantive, incomplete or unstructured terminal data %s',addressLine1=>expect(sameRegistryStreet({...crm,addressLine1},source)).toBe(false));
 it.each(['city','state','countryCode'] as const)('retains structured %s conflicts',field=>{
  expect(sameRegistryStreet({...crm,[field]:field==='countryCode'?'CA':'OTHER'},source)).toBe(false);
  expect(sameRegistryStreet(crm,{...source,[field]:undefined})).toBe(false);
 });
 it('keeps postcode, legal subject, unit and explicit route class checks',()=>{
  for(const change of [{postalCode:'52247'},{addressLine2:'Suite 7'},{countryCode:'CA'}])expect(verifyRegistryIdentity(terraRow.profile,{name:terra.name},{...ctx(terra),addresses:[{...crm,...change}]},[],now)).toBeNull();
  expect(verifyRegistryIdentity(terraRow.profile,{name:'Other Products Company'},ctx(terra),[],now)).toBeNull();
  expect(verifyRegistryIdentity(terraRow.profile,{name:'Terra Products Company Inc'},{...ctx(terra),aliases:[]},[],now)).toBeNull();
  expect(sameRegistryStreet({...source,addressLine1:'16399 W Highway 66'}, {...source,addressLine1:'16399 W US HWY 66'})).toBe(false);
 });
});

const retained=fixture.stein, row=parseRegistryFinding(retained.finding,now), company={name:retained.context.name,domain:retained.context.domain}, context=ctx(retained.context);
const address={addressLine1:'2651 Aviation Drive',city:'Waukesha',state:'WI',postalCode:'53188',countryCode:'US' as const};
const page=(html=retained.page.html)=>({status:200,finalUrl:retained.page.url,contentType:'text/html',body:html});
function proof(html=retained.page.html,subject='Steins Aircraft Services',a=address,target=row):RegistryWebsiteCorroboration{
 const text=registryWebsiteText(html);const bare={sourceUrl:retained.page.url,normalizedVisibleTextSha256:sha(text),quote:text,quoteSha256:sha(text),subject,address:a};
 const evidenceSha256=registryWebsiteEvidenceHash(target,bare);
 // Synthetic test witnesses only, never stored as genuine source/final reads.
 return {...bare,reader:{taskId:'/test/reader',reviewedAt:now.toISOString(),evidenceSha256},reviewer:{taskId:'/test/reviewer',reviewedAt:now.toISOString(),evidenceSha256}};
}
beforeEach(()=>fetch.mockReset());
describe('single possessive apostrophe only under full-address website gates',()=>{
 it('compares a possessive website subject with complete address; no alias or raw field rewrite',async()=>{
  fetch.mockResolvedValueOnce(page()); const before=JSON.stringify([row,context]),hash=registryContentHash(row.profile,row.sourceUrl,row.detail);
  const p=parseRegistryWebsiteCorroboration(proof(),row,now);
  expect(registryWebsiteText(retained.page.html)).toBe(retained.page.text);
  const result=await registryWebsiteVerifier()(row,p,company,context,now);
  expect(result).toMatchObject({method:'official_website_corroboration',website:{subject:'Steins Aircraft Services',registryAddress:row.profile.identity,binding:'exact_legal_name_address'}});
  expect(JSON.stringify([row,context])).toBe(before);expect(registryContentHash(row.profile,row.sourceUrl,row.detail)).toBe(hash);
  expect(verifyRegistryIdentity(row.profile,company,context,[],now)).toBeNull();
 });
 it('does not change the global legal comparator or infer a canonical alias',()=>{
  expect(sameRegistryLegalName("STEIN'S AIRCRAFT SERVICES, LLC",'Steins Aircraft Services')).toBe(false);
  expect(sameRegistryLegalName("John's Services LLC",'Johns Services LLC')).toBe(false);
 });
 it.each(["Stein’s Aircraft Services, LLC","STEIN'S AIRCRAFT SERVICES, LLC"])('supports straight/curly spelling without changing letters: %s',async legalName=>{
  const r=clone(row);r.profile.identity.legalName=legalName;const c={...company,name:legalName}; fetch.mockResolvedValueOnce(page());
  await expect(registryWebsiteVerifier()(r,proof(undefined,undefined,undefined,r),c,{...context,aliases:[]},now)).resolves.toBeTruthy();
 });
 it.each(['Stein Aircraft Services','Steinss Aircraft Services','Steins Aviation Services','Steins Aircraft Service','Steins Aircraft Services Inc'])('rejects a letter, word or legal suffix change: %s',async subject=>{
  const html=retained.page.html.replace(/Steins Aircraft Services/g,subject);fetch.mockResolvedValueOnce(page(html));
  await expect(registryWebsiteVerifier()(row,proof(html,subject),company,context,now)).rejects.toThrow(/subject/);
 });
 it.each(["St'eins Aircraft Services, LLC","Stein''s Aircraft Services, LLC","Stein’s Aircraft’s Services, LLC"])('does not remove arbitrary or multiple apostrophes: %s',async legalName=>{
  const r=clone(row);r.profile.identity.legalName=legalName;fetch.mockResolvedValueOnce(page());
  await expect(registryWebsiteVerifier()(r,proof(undefined,undefined,undefined,r),{...company,name:legalName},{...context,aliases:[]},now)).rejects.toThrow(/subject/);
 });
 it('preserves legacy punctuation equivalence rather than claiming to reject it',()=>{
  expect(sameRegistryLegalName("STEIN'S AIRCRAFT SERVICES, LLC",'STEIN S AIRCRAFT SERVICES')).toBe(true);
  expect(sameRegistryLegalName("Steins' Aircraft Services, LLC",'Steins Aircraft Services')).toBe(true);
 });
 it.each([{addressLine1:'2651 Aviation Road'},{addressLine1:'2641 Aviation Drive'},{addressLine2:'Suite 1'},{city:'Kenosha'},{state:'IL'},{postalCode:'53189'},{countryCode:'CA'}])('rejects source address conflict %j',async change=>{
  const r=clone(row);Object.assign(r.profile.identity,change);fetch.mockResolvedValueOnce(page());
  await expect(registryWebsiteVerifier()(r,proof(undefined,undefined,undefined,r),company,context,now)).rejects.toThrow();
 });
 it('requires canonical and original legal name agreement before the punctuation alternative',async()=>{
  fetch.mockResolvedValueOnce(page());await expect(registryWebsiteVerifier()(row,proof(),{...company,name:'Steins Aircraft Services LLC'},{...context,aliases:[]},now)).rejects.toThrow(/subject/);
 });
 it('keeps same-domain, exact whole-page text and quote/address gates',async()=>{
  await expect(registryWebsiteVerifier()(row,proof(),{...company,domain:'different.example'},context,now)).rejects.toThrow();
  fetch.mockResolvedValueOnce(page(retained.page.html+'<p>Changed</p>'));await expect(registryWebsiteVerifier()(row,proof(),company,context,now)).rejects.toThrow(/changed/);
  const html='<p>Steins Aircraft Services</p>';fetch.mockResolvedValueOnce(page(html));await expect(registryWebsiteVerifier()(row,proof(html),company,context,now)).rejects.toThrow(/address/);
 });
 it('keeps different reviewers mandatory at the existing proof parser',()=>{
  const p=proof();p.reviewer={...p.reader};expect(()=>parseRegistryWebsiteCorroboration(p,row,now)).toThrow();
 });
 it('does not admit the punctuation-only subject through identifier or DBA modes',async()=>{
  const p=proof() as any;p.mode='registry_identifier';p.identifier={kind:'usdot',value:'12345'};
  await expect(registryWebsiteVerifier()(row,p,company,context,now)).rejects.toThrow();
  p.mode='registry_dba_address';delete p.identifier;await expect(registryWebsiteVerifier()(row,p,company,context,now)).rejects.toThrow();
 });
});
