import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import catalog from "./registryOfficialApiEntries.json";
import { registryOfficialApiCanonicalHash, registryOfficialApiEntry, registryOfficialApiEvidenceHash, verifyRegistryOfficialApi, type RegistryOfficialApiEntry } from "./registryOfficialApi";
import { stableRegistryJson, type RegistryFinding } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { RegisteredTradeSiteBridge } from "./registryRegisteredTradeSite";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex"), hash=(x:unknown)=>sha(stableRegistryJson(x));
const now=new Date("2026-10-06T12:00:00Z");
const review=(name:string,at="2026-10-06T11:00:00Z")=>({taskId:`/test-only/${name}`,reviewedAt:at,receiptSha256:sha(name)});
// Synthetic company and actors only. The compiled catalog is changed in memory,
// never saved. No fixture is an actual source/content approval.
function setup(copyright=false){
  const company={id:"11111111-1111-4111-8111-111111111111",netsuite_internal_id:"12345",name:"Northridge Advisors LLC",domain:"northridge-advisors.com"};
  const context:CompanyIdentityContext={aliases:[],context:"",addresses:[{addressLine1:"200 Current Street",addressLine2:"Suite 2803K",city:"Denver",state:"CO",postalCode:"80202",countryCode:"US",sourceKind:"netsuite_record",sourceId:"test-only-current",capturedAt:"2026-09-01T00:00:00Z"}]};
  const original={entityid:"20201111111",entityname:company.name,principaladdress1:"100 Historical Street",principaladdress2:"Suite 2800 South",principalcity:"Denver",principalstate:"CO",principalzipcode:"80202",principalcountry:"US",entitystatus:"Good Standing",entitytype:"DLLC",entityformdate:"2020-01-01T00:00:00.000"};
  const raw=JSON.stringify(original),identity={legalName:original.entityname,addressLine1:original.principaladdress1,addressLine2:original.principaladdress2,city:original.principalcity,state:"CO",postalCode:"80202",countryCode:"US" as const};
  const finding:RegistryFinding={label:"registry:co_sos:20201111111",companyId:company.id,internalId:company.netsuite_internal_id,sourceUrl:"https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=20201111111",evidence:raw,detail:"TEST ONLY; different addresses remain distinct.",profile:{version:1,dataset:"co_sos",recordId:original.entityid,sourceAsOf:"2026-09-29",observedAt:"2026-09-29T12:00:00Z",identity,facts:[{field:"registration_number",label:"Registration number",value:original.entityid}],provenance:{rowSha256:sha(raw),quote:raw,sourceRow:{...identity,registration_number:original.entityid}}}};
  const sourceRaw=JSON.stringify({...original,agentfirstname:"MORGAN",agentmiddlename:"ALEXANDRA",agentlastname:"LANE"});
  const officialUrl="https://data.colorado.gov/resource/4ykn-tg5h.json?$select=entityid,entityname&$where=entityid+in+(20201111111)&$order=entityid&$limit=1";
  const brand="Northridge Planning";
  const tradeRaw={mastertradenameid:"20251111112",tradenamedescription:brand,tradenameform:"Entity Type",registrantorganization:company.name,entityid:original.entityid,firstname:"",middlename:"",lastname:"",suffix:"",address1:original.principaladdress1,address2:original.principaladdress2,city:original.principalcity,state:"CO",zipcode:"80202",country:"US",effectivedate:"2025-04-29T00:00:00.000",entitystatus:"GOOD",entityformdate:original.entityformdate};
  const tradeUrl="https://data.colorado.gov/resource/u7sb-g482.json?$select="+Object.keys(tradeRaw).join(",")+"&$where="+encodeURIComponent("entityid in('20201111111')")+"&$order=entityid,mastertradenameid&$limit=10000",tradeText=JSON.stringify(tradeRaw);
  const text=copyright?`© 2026 • ${brand} • All Rights Reserved • Developed by Studio Design`:`Founder of ${brand}`;
  const html=copyright?`<p>${text}</p>`:`<div class="team-single-designation text-center">${text}</div>`;
  const pageUrl="https://www.northridge-advisors.com/about";
  const bridge:RegisteredTradeSiteBridge={schema:"reviewed_registered_trade_site_v1",canonicalName:company.name,tradeName:brand,sourceInputSha256:sha("test-only-input"),primaryDecisionSha256:sha("source-primary"),independentDecisionSha256:sha("source-independent"),trade:{requestedUrl:tradeUrl,finalUrl:tradeUrl,status:200,contentType:"application/json",observedAt:"2026-10-02T10:00:00Z",responseSha256:sha("["+tradeText+"]"),receiptSha256:sha("trade-receipt"),rawRow:tradeText,rawRowSha256:sha(tradeText),arrayIndex:0,byteOffset:1,byteLength:Buffer.byteLength(tradeText),matchedRows:1},ownSite:{requestedUrl:pageUrl,finalUrl:pageUrl,status:200,contentType:"text/html; charset=utf-8",observedAt:"2026-10-06T10:00:00Z",hops:[{url:pageUrl,status:200}],htmlSha256:sha(html),textSha256:sha(text),receiptSha256:sha("page-receipt"),text,representation:"complete_retained_static_text_v1"},brandQuote:{role:copyright?"copyright_owner":"founder_brand",text,start:0,end:text.length,ordinaryHtml:{start:0,end:html.length,html,sha256:sha(html)}},limitations:{association:"independently_reviewed_company_inference",addressEquivalenceClaimed:false,canonicalIdentityChanged:false,currentTradeControlClaimed:false,statutoryPersonIdentityVerified:false,currentOccupancyClaimed:false,literalDifferences:["Official Suite2800South and canonical Suite2803K remain literal; no CEO claim."]}};
  const entry:RegistryOfficialApiEntry={id:"test-only-owner-trade",companyId:company.id,internalId:company.netsuite_internal_id,canonicalDomain:company.domain,canonicalIdentitySha256:registryOfficialApiCanonicalHash(company,context),sourceKind:"colorado_business_entity",source:{requestedUrl:officialUrl,finalUrl:officialUrl,status:200,contentType:"application/json",observedAt:"2026-10-01T10:00:00Z",responseSha256:sha("["+sourceRaw+"]"),receiptSha256:sha("main-receipt"),rawRow:sourceRaw,rawRowSha256:sha(sourceRaw),arrayIndex:0,byteOffset:1,byteLength:Buffer.byteLength(sourceRaw)},sourceReader:review("source-primary"),sourceReviewer:review("source-independent","2026-10-06T11:01:00Z"),originalReviews:{primary:review("original-primary","2026-09-30T00:00:00Z"),independent:review("original-independent","2026-09-30T01:00:00Z"),packetSha256:sha("packet")},target:{dataset:"co_sos",recordId:original.entityid,sourceUrl:finding.sourceUrl,rowSha256:sha(raw),evidenceSha256:sha(raw),identitySha256:hash(identity),sourceRowSha256:hash(finding.profile.provenance.sourceRow),factsSha256:hash(finding.profile.facts.map(({field,value})=>({field,value}))),sourceAsOf:finding.profile.sourceAsOf,observedAt:finding.profile.observedAt},anchor:{mode:"reviewed_registered_trade_site"},registeredTradeSiteBridge:bridge};
  const memory=catalog as unknown as {version:number;entries:RegistryOfficialApiEntry[]};memory.entries=[entry];
  const proof=()=>{const bare={schema:"official_api_roles_v1" as const,entryId:entry.id,entrySha256:registryOfficialApiEntry(entry.id).sha256,canonicalIdentitySha256:entry.canonicalIdentitySha256},evidenceSha256=registryOfficialApiEvidenceHash(finding,bare);return{...bare,reader:{taskId:"/test-only/final-primary",reviewedAt:"2026-10-06T11:30:00Z",evidenceSha256},reviewer:{taskId:"/test-only/final-independent",reviewedAt:"2026-10-06T11:31:00Z",evidenceSha256}};};
  const check=(p=proof())=>verifyRegistryOfficialApi(finding,p,company,context,now);
  const changeTrade=(change:Record<string,string>)=>{const b=bridge.trade;b.rawRow=JSON.stringify({...JSON.parse(b.rawRow),...change});b.rawRowSha256=sha(b.rawRow);b.byteLength=Buffer.byteLength(b.rawRow);};
  const changeHtml=(value:string)=>{const h=bridge.brandQuote.ordinaryHtml;h.html=value;h.end=value.length;h.sha256=sha(value);bridge.ownSite.htmlSha256=sha(value);};
  const changeText=(value:string)=>{bridge.ownSite.text=value;bridge.ownSite.textSha256=sha(value);bridge.brandQuote.text=value;bridge.brandQuote.end=value.length;changeHtml(`<p>${value}</p>`);};
  return{company,context,finding,entry,bridge,memory,proof,check,changeTrade,changeHtml,changeText};
}
type Fixture=ReturnType<typeof setup>;
describe("finite reviewed CO entity-owned trade and explicit static brand",()=>{
  it.each([false,true])("accepts a closed explicit brand role and keeps different addresses (%s)",(copyright:boolean)=>{const f=setup(copyright),before=JSON.stringify([f.finding,f.context]);const result=f.check();assert.equal(result.method,"reviewed_official_registration_history");assert.equal(JSON.stringify([f.finding,f.context]),before);assert.equal(result.officialHistory?.canonicalAnchor,null);assert.equal(result.officialHistory?.roleAddress,null);assert.ok(result.sourceIds.includes(`trade-owner:${f.bridge.trade.rawRowSha256}`));});
  const negatives:[string,(f:Fixture)=>void][]=[
    ["wrong company",f=>{f.company.id="22222222-2222-4222-8222-222222222222";}],
    ["wrong exact internal ID",f=>{f.company.netsuite_internal_id="99999";}],
    ["wrong original entity",f=>{f.finding.profile.recordId="20201111110";}],
    ["changed original unit",f=>{f.finding.profile.identity.addressLine2="Suite 2803K";}],
    ["changed original country",f=>{f.finding.profile.identity.countryCode="CA";}],
    ["changed facts",f=>{f.finding.profile.facts[0].value="20201111110";}],
    ["wrong assigned domain",f=>{f.company.domain="other-firm.com";}],
    ["changed canonical address",f=>{f.context.addresses[0].addressLine2="Suite 2800 South";}],
    ["new alias",f=>{f.context.aliases.push("Another Firm");}],
    ["different owner ID",f=>f.changeTrade({entityid:"20201111110"})],
    ["different registrant",f=>f.changeTrade({registrantorganization:"Other Advisors LLC"})],
    ["conflicting legal form",f=>f.changeTrade({registrantorganization:"Northridge Advisors Inc"})],
    ["missing registrant legal form",f=>f.changeTrade({registrantorganization:"Northridge Advisors"})],
    ["partial alias",f=>f.changeTrade({tradenamedescription:"Northridge"})],
    ["different trade ID shape",f=>f.changeTrade({mastertradenameid:"123"})],
    ["individual owner",f=>f.changeTrade({tradenameform:"Individual",firstname:"Morgan",lastname:"Lane"})],
    ["hidden personal owner",f=>f.changeTrade({firstname:"Morgan"})],
    ["trade street changed",f=>f.changeTrade({address1:"200 Current Street"})],
    ["trade unit changed",f=>f.changeTrade({address2:"Suite 2803K"})],
    ["trade city changed",f=>f.changeTrade({city:"Boulder"})],
    ["trade ZIP changed",f=>f.changeTrade({zipcode:"80303"})],
    ["trade country missing",f=>f.changeTrade({country:""})],
    ["trade formation changed",f=>f.changeTrade({entityformdate:"2020-01-02T00:00:00.000"})],
    ["trade not in retained good status",f=>f.changeTrade({entitystatus:"EXPIRED"})],
    ["future trade civil date",f=>f.changeTrade({effectivedate:"2026-10-07T00:00:00.000"})],
    ["invalid civil day",f=>f.changeTrade({effectivedate:"2025-02-30T00:00:00.000"})],
    ["ambiguous selected row",f=>{f.bridge.trade.matchedRows=2;}],
    ["wrong raw row hash",f=>{f.bridge.trade.rawRowSha256=sha("other");}],
    ["wrong byte length",f=>{f.bridge.trade.byteLength++;}],
    ["wrong official source host",f=>{f.bridge.trade.requestedUrl=f.bridge.trade.finalUrl=f.bridge.trade.requestedUrl.replace("data.colorado.gov","example.com");}],
    ["different queried owner",f=>{f.bridge.trade.requestedUrl=f.bridge.trade.finalUrl=f.bridge.trade.requestedUrl.replace("20201111111","20201111110");}],
    ["unretained trade country query field",f=>{f.bridge.trade.requestedUrl=f.bridge.trade.finalUrl=f.bridge.trade.requestedUrl.replace(",country,",",");}],
    ["failed official request",f=>{f.bridge.trade.status=403;}],
    ["redirected official row",f=>{f.bridge.trade.finalUrl+="&x=1";}],
    ["trade after own-page read",f=>{f.bridge.trade.observedAt="2026-10-06T10:00:00.0000001Z";}],
    ["source read before page",f=>{f.entry.sourceReader.reviewedAt="2026-10-06T09:59:59.9999999Z";}],
    ["independent source before primary",f=>{f.entry.sourceReviewer.reviewedAt="2026-10-06T10:59:59.9999999Z";}],
    ["same source actor",f=>{f.entry.sourceReviewer.taskId=f.entry.sourceReader.taskId;}],
    ["wrong actual primary pin",f=>{f.bridge.primaryDecisionSha256=sha("other");}],
    ["missing source input pin",f=>{f.bridge.sourceInputSha256="";}],
    ["changed full page text",f=>{f.bridge.ownSite.text+=" extra";}],
    ["wrong quote offset",f=>{f.bridge.brandQuote.start++;}],
    ["wrong ordinary HTML hash",f=>{f.bridge.brandQuote.ordinaryHtml.sha256=sha("other");}],
    ["off-domain website",f=>{f.bridge.ownSite.requestedUrl=f.bridge.ownSite.finalUrl="https://other-firm.com/about";f.bridge.ownSite.hops[0].url=f.bridge.ownSite.finalUrl;}],
    ["off-domain hop",f=>{f.bridge.ownSite.hops.unshift({url:"https://example.com/",status:302});}],
    ["founder is negated",f=>f.changeText("Not Founder of Northridge Planning")],
    ["former founder",f=>f.changeText("Former Founder of Northridge Planning")],
    ["bare brand only",f=>f.changeText("Northridge Planning")],
    ["different complete brand",f=>f.changeText("Founder of Northridge Planning West")],
    ["clipped containing paragraph",f=>f.changeHtml("<p>Example: Founder of Northridge Planning</p>")],
    ["boolean hidden",f=>f.changeHtml("<p hidden>Founder of Northridge Planning</p>")],
    ["inert",f=>f.changeHtml("<div inert>Founder of Northridge Planning</div>")],
    ["title only",f=>f.changeHtml("<title>Founder of Northridge Planning</title>")],
    ["script only",f=>f.changeHtml("<script>Founder of Northridge Planning</script>")],
    ["hidden styling",f=>f.changeHtml('<p style="display:none">Founder of Northridge Planning</p>')],
    ["address equivalence claim",f=>{(f.bridge.limitations as unknown as Record<string,unknown>).addressEquivalenceClaimed=true;}],
    ["current control claim",f=>{(f.bridge.limitations as unknown as Record<string,unknown>).currentTradeControlClaimed=true;}],
    ["missing limitations",f=>{f.bridge.limitations.literalDifferences=[];}],
    ["unreviewed catalog entry",f=>{f.memory.entries=[];}],
    ["duplicate catalog entry",f=>{f.memory.entries.push(structuredClone(f.entry));}],
  ];
  for(const[name,mutate]of negatives)it(`rejects ${name}`,()=>{const f=setup();mutate(f);assert.throws(()=>f.check());});
  it("rejects stale entry proof and wrong final content hash",()=>{const f=setup(),p=f.proof();f.entry.registeredTradeSiteBridge!.limitations.literalDifferences.push("Changed reviewed data");assert.throws(()=>f.check(p));const fresh=f.proof();fresh.reader.evidenceSha256=sha("wrong");assert.throws(()=>f.check(fresh));});
  it("preserves distinct ordered actual final witnesses with 100ns precision",()=>{const f=setup(),p=f.proof();f.entry.sourceReviewer.reviewedAt="2026-10-06T11:30:00.0000001Z";assert.throws(()=>f.check(f.proof()));f.entry.sourceReviewer.reviewedAt="2026-10-06T11:01:00Z";p.reader.reviewedAt="2026-10-06T11:31:00.0000001Z";p.reviewer.reviewedAt="2026-10-06T11:31:00.0000000Z";assert.throws(()=>f.check(p));});
  it("rejects wrong copyright year, owner and unbounded trailing claims",()=>{for(const text of ["© 2025 • Northridge Planning • All Rights Reserved","© 2026 • Other Advisors • All Rights Reserved","© 2026 • Northridge Planning • All Rights Reserved • Former owner"]){const f=setup(true);f.changeText(text);assert.throws(()=>f.check());}});
});
