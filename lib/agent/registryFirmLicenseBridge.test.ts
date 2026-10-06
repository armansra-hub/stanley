import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import catalog from "./registryOfficialApiEntries.json";
import { registryOfficialApiCanonicalHash, registryOfficialApiEntry, registryOfficialApiEvidenceHash, verifyRegistryOfficialApi, type RegistryOfficialApiEntry } from "./registryOfficialApi";
import { stableRegistryJson, type RegistryFinding } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { FirmLicenseBridge } from "./registryFirmLicenseBridge";

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
  const mkRow = (raw: Record<string, unknown>, requestedUrl: string) => { const rawRow=JSON.stringify(raw); return {requestedUrl,finalUrl:requestedUrl,status:200,contentType:"application/json;charset=utf-8",observedAt:date,responseSha256:sha("["+rawRow+"]"),receiptSha256:sha(requestedUrl),rawRow,rawRowSha256:sha(rawRow),arrayIndex:0,byteOffset:1,byteLength:Buffer.byteLength(rawRow),matchedRows:1}; };
  const license = mkRow({entityname:"Northridge Advisors, LLC",city:"Niwot",state:"CO",mailzipcode:"80503",licensetype:"FRM",licensenumber:"5000999",licensestatusdescription:"Active",linktoverifylicense:{url:"https://www.colorado.gov/dora/licensing/Lookup/PrintLicenseDetails.aspx?cred=123&contact=456"}},"https://data.colorado.gov/resource/7s5z-vewr.json?$where="+encodeURIComponent("licensetype='FRM' AND licensenumber='5000999'")+"&$limit=10");
  const trade = mkRow({mastertradenameid:"20201111112",tradenamedescription:company.name,tradenameform:"Entity Type",registrantorganization:original.entityname,entityid:original.entityid,city:"Niwot",state:"CO",zipcode:"80503",country:"US"},"https://data.colorado.gov/resource/u7sb-g482.json?$select=mastertradenameid,tradenamedescription,tradenameform,registrantorganization,entityid,city,state,zipcode,country&$where="+encodeURIComponent("entityid in('"+original.entityid+"')")+"&$order=entityid,mastertradenameid&$limit=10000");
  const companyText=company.name+" is here with you every step of the way.", licenseText="Colorado Public Accounting Firm License Number\nFRM.5000999";
  const fullText=companyText+"\n\n"+licenseText;
  const companyHtml="<p><strong>"+companyText+"</strong></p>",licenseHtml='<p style="font-weight: 400;"><strong>Colorado</strong><strong> Public Accounting Firm License Number</strong></p><p style="font-weight: 400;"><strong>FRM.5000999</strong></p>';
  const ownSite={requestedUrl:"https://northridge-advisors.com/about",finalUrl:"https://northridge-advisors.com/about",status:200,contentType:"text/html; charset=utf-8",observedAt:date,hops:[{url:"https://northridge-advisors.com/about",status:200}],htmlSha256:sha(companyHtml+licenseHtml),textSha256:sha(fullText),receiptSha256:sha("test-only-site-receipt"),text:fullText,representation:"complete_retained_static_text_v1" as const};
  const quote=(text:string,start:number,html:string,htmlStart:number)=>({start,end:start+text.length,text,ordinaryHtml:{start:htmlStart,end:htmlStart+html.length,html,sha256:sha(html)}});
  const bridge:FirmLicenseBridge={schema:"reviewed_colorado_firm_license_v1",canonicalName:company.name,licenseToken:"FRM.5000999",sourceInputSha256:sha("test-only-input"),primaryDecisionSha256:sha("source-primary"),independentDecisionSha256:sha("source-independent"),license,trade,ownSite,companyQuote:quote(companyText,0,companyHtml,0),licenseQuote:quote(licenseText,companyText.length+2,licenseHtml,companyHtml.length),limitations:{association:"independently_reviewed_company_inference",addressEquivalenceClaimed:false,canonicalIdentityChanged:false,currentLicenseClaimed:false,individualOwnershipClaimed:false,financialOrDisciplinaryInference:false,literalDifferences:["Historical Suite1 and canonical Suite2 remain distinct; licensing locality does not prove a street."]}};
  const entry: RegistryOfficialApiEntry = { id: "test-only-operator", companyId: company.id, internalId: company.netsuite_internal_id, canonicalDomain: company.domain, canonicalIdentitySha256: registryOfficialApiCanonicalHash(company, context), sourceKind: "colorado_business_entity",
    source: { requestedUrl: sourceUrl, finalUrl: sourceUrl, status: 200, contentType: "application/json", observedAt: date, responseSha256: sha(`[${sourceRaw}]`), receiptSha256: sha("test-only-official-receipt"), rawRow: sourceRaw, rawRowSha256: sha(sourceRaw), arrayIndex: 0, byteOffset: 1, byteLength: Buffer.byteLength(sourceRaw) },
    sourceReader: review("source-primary"), sourceReviewer: review("source-independent", "2026-10-06T11:01:00Z"), originalReviews: { primary: review("historical-primary", "2026-09-30T00:00:00Z"), independent: review("historical-independent", "2026-09-30T01:00:00Z"), packetSha256: sha("test-only-original-packet") },
    target: { dataset: "co_sos", recordId: original.entityid, sourceUrl: row.sourceUrl, rowSha256: sha(raw), evidenceSha256: sha(raw), identitySha256: objectHash(identity), sourceRowSha256: objectHash(row.profile.provenance.sourceRow), factsSha256: objectHash(row.profile.facts.map(({ field, value }) => ({ field, value }))), sourceAsOf: row.profile.sourceAsOf!, observedAt: row.profile.observedAt },
    anchor: { mode: "reviewed_colorado_firm_license" }, firmLicenseBridge: bridge };
  const memory = catalog as unknown as { version: number; entries: RegistryOfficialApiEntry[] }; memory.entries = [entry];
  const proof = () => { const bare = { schema: "official_api_roles_v1" as const, entryId: entry.id, entrySha256: registryOfficialApiEntry(entry.id).sha256, canonicalIdentitySha256: entry.canonicalIdentitySha256 }; const evidenceSha256 = registryOfficialApiEvidenceHash(row, bare); return { ...bare, reader: { taskId: "/test-only/final-primary", reviewedAt: "2026-10-06T11:30:00Z", evidenceSha256 }, reviewer: { taskId: "/test-only/final-independent", reviewedAt: "2026-10-06T11:31:00Z", evidenceSha256 } }; };
  const check = (p = proof()) => verifyRegistryOfficialApi(row, p, company, context, now);
  const rawChange = (delta: Record<string, string>) => { entry.source.rawRow = JSON.stringify({ ...JSON.parse(entry.source.rawRow), ...delta }); entry.source.rawRowSha256 = sha(entry.source.rawRow); entry.source.byteLength = Buffer.byteLength(entry.source.rawRow); };
  const bridgeRow=(which:"license"|"trade",delta:Record<string,unknown>)=>{const r=bridge[which];r.rawRow=JSON.stringify({...JSON.parse(r.rawRow),...delta});r.rawRowSha256=sha(r.rawRow);r.byteLength=Buffer.byteLength(r.rawRow);};
  const html=(value:string)=>{const q=bridge.licenseQuote.ordinaryHtml;q.html=value;q.end=q.start+value.length;q.sha256=sha(value);bridge.ownSite.htmlSha256=sha(value);};
  return { company, context, row, entry, bridge, memory, proof, check, rawChange, bridgeRow, html };
}
type Fixture = ReturnType<typeof setup>;
describe("reviewed Colorado firm license, synthetic catalog only", () => {
  it("binds exact license and owner without changing distinct addresses or original facts", () => {
    const f=setup(), before=JSON.stringify([f.row,f.context]), result=f.check();
    assert.equal(result.method,"reviewed_official_registration_history");
    assert.equal(JSON.stringify([f.row,f.context]),before);
    const history=result.officialHistory as Record<string,unknown>;
    assert.equal(history.canonicalAnchor,null); assert.equal(history.roleAddress,null);
    assert.ok(JSON.stringify(history).includes("No street/unit equivalence"));
  });
  const negatives:[string,(f:Fixture)=>void][]=[
    ["wrong company UUID",f=>{f.company.id="22222222-2222-4222-8222-222222222222";}],
    ["wrong original entity ID",f=>{f.row.profile.recordId="20209999999";}],
    ["changed original unit",f=>{f.row.profile.identity.addressLine2="Suite 9";}],
    ["changed original country",f=>{f.row.profile.identity.countryCode="CA";}],
    ["changed original facts",f=>{f.row.profile.facts[0].value="20209999999";}],
    ["changed original observed date",f=>{f.row.profile.observedAt="2026-09-28T12:00:00Z";}],
    ["wrong company domain",f=>{f.company.domain="wrong-company.com";}],
    ["caller adds alias",f=>{f.context.aliases.push("Another Firm LLC");}],
    ["license individual type",f=>f.bridgeRow("license",{licensetype:"CPA"})],
    ["wrong license number",f=>f.bridgeRow("license",{licensenumber:"5000998"})],
    ["partial license token",f=>{f.bridge.licenseToken="FRM.500099";}],
    ["wrong full license firm",f=>f.bridgeRow("license",{entityname:"Other Advisors LLC"})],
    ["conflicting legal form",f=>f.bridgeRow("license",{entityname:"Northridge Advisors Corp"})],
    ["omitted license form",f=>f.bridgeRow("license",{entityname:"Northridge Advisors"})],
    ["wrong license city",f=>f.bridgeRow("license",{city:"Denver"})],
    ["wrong license ZIP",f=>f.bridgeRow("license",{mailzipcode:"80202"})],
    ["wrong license state",f=>f.bridgeRow("license",{state:"CA"})],
    ["wrong owner entity",f=>f.bridgeRow("trade",{entityid:"20209999999"})],
    ["wrong owner legal name",f=>f.bridgeRow("trade",{registrantorganization:"Other Advisors LLC"})],
    ["wrong exact trade brand",f=>f.bridgeRow("trade",{tradenamedescription:"Northridge Advisors Other"})],
    ["individual trade owner",f=>f.bridgeRow("trade",{tradenameform:"Individual"})],
    ["wrong trade city",f=>f.bridgeRow("trade",{city:"Denver"})],
    ["wrong trade ZIP",f=>f.bridgeRow("trade",{zipcode:"80202"})],
    ["missing trade country",f=>f.bridgeRow("trade",{country:""})],
    ["ambiguous license response",f=>{f.bridge.license.matchedRows=2;}],
    ["ambiguous trade response",f=>{f.bridge.trade.matchedRows=2;}],
    ["wrong license source hash",f=>{f.bridge.license.rawRowSha256=sha("wrong");}],
    ["wrong source byte length",f=>{f.bridge.license.byteLength++;}],
    ["wrong official host",f=>{f.bridge.license.requestedUrl=f.bridge.license.finalUrl=f.bridge.license.requestedUrl.replace("data.colorado.gov","data.colorado.gov.example.com");}],
    ["wrong official dataset",f=>{f.bridge.license.requestedUrl=f.bridge.license.finalUrl=f.bridge.license.requestedUrl.replace("7s5z-vewr","4ykn-tg5h");}],
    ["redirected license source",f=>{f.bridge.license.finalUrl+="&x=1";}],
    ["failed official request",f=>{f.bridge.license.status=403;}],
    ["duplicate license query",f=>{f.bridge.license.requestedUrl+="&$limit=10";f.bridge.license.finalUrl=f.bridge.license.requestedUrl;}],
    ["wrong license query type",f=>{f.bridge.license.requestedUrl=f.bridge.license.finalUrl=f.bridge.license.requestedUrl.replace("FRM","CPA");}],
    ["wrong trade owner query",f=>{f.bridge.trade.requestedUrl=f.bridge.trade.finalUrl=f.bridge.trade.requestedUrl.replace("20201111111","20209999999");}],
    ["changed complete text",f=>{f.bridge.ownSite.text+=" More";}],
    ["wrong literal quote offset",f=>{f.bridge.licenseQuote.start++;}],
    ["wrong exact HTML hash",f=>{f.bridge.licenseQuote.ordinaryHtml.sha256=sha("wrong");}],
    ["off-domain page",f=>{f.bridge.ownSite.requestedUrl=f.bridge.ownSite.finalUrl="https://example.com/about";f.bridge.ownSite.hops[0].url=f.bridge.ownSite.finalUrl;}],
    ["off-domain intermediate hop",f=>{f.bridge.ownSite.hops.unshift({url:"https://example.com/",status:302});}],
    ["wrong actual primary receipt",f=>{f.bridge.primaryDecisionSha256=sha("other");}],
    ["missing independent receipt",f=>{f.bridge.independentDecisionSha256="";}],
    ["missing input",f=>{f.bridge.sourceInputSha256="";}],
    ["same source actor",f=>{f.entry.sourceReviewer.taskId=f.entry.sourceReader.taskId;}],
    ["late license observation",f=>{f.bridge.license.observedAt="2026-10-06T11:00:00.0000001Z";}],
    ["late trade observation",f=>{f.bridge.trade.observedAt="2026-10-06T11:00:00.0000001Z";}],
    ["late page observation",f=>{f.bridge.ownSite.observedAt="2026-10-06T11:00:00.0000001Z";}],
    ["source actor reversed at submillisecond",f=>{f.entry.sourceReader.reviewedAt="2026-10-06T11:01:00.0000001Z";}],
    ["false address equivalence",f=>{(f.bridge.limitations as unknown as Record<string,unknown>).addressEquivalenceClaimed=true;}],
    ["missing differences",f=>{f.bridge.limitations.literalDifferences=[];}],
    ["bridge injected into old mode",f=>{f.entry.anchor={mode:"company_email_domain"};}],
    ["unreviewed operator mixed with license",f=>{(f.entry as unknown as Record<string,unknown>).registeredAgentOperatorBridge={};}],
    ["mode without bridge",f=>{delete f.entry.firmLicenseBridge;}],
  ];
  for(const [label,mutate]of negatives)it("rejects "+label,()=>{const f=setup();mutate(f);assert.throws(()=>f.check());});
  for(const attr of ['hidden','inert','aria-hidden="true"','onclick="x()"','style="display:none"','style="font-weight:400;visibility:hidden"','style="font-weight:0"','style="font-weight:400" style="font-weight:normal"','style=font-weight:400'])
    it("rejects hidden, active or ambiguous attribute "+attr,()=>{const f=setup();f.html('<p '+attr+'>'+f.bridge.licenseQuote.text+'</p>');assert.throws(()=>f.check());});
  for(const tag of ['script','style','template','noscript','svg','math','textarea','title','iframe','xmp','plaintext'])
    it("rejects nonordinary container "+tag,()=>{const f=setup();f.html('<'+tag+'>'+f.bridge.licenseQuote.text+'</'+tag+'>');assert.throws(()=>f.check());});
  it("rejects a second different whole-page FRM token",()=>{const f=setup();f.bridge.ownSite.text+='\nFRM.5000998';f.bridge.ownSite.textSha256=sha(f.bridge.ownSite.text);assert.throws(()=>f.check());});
  it("rejects token prefix followed by extra digits",()=>{const f=setup();f.bridge.ownSite.text+='\nFRM.50009990';f.bridge.ownSite.textSha256=sha(f.bridge.ownSite.text);assert.throws(()=>f.check());});
  it("rejects same final actor",()=>{const f=setup(),proof=f.proof();proof.reviewer.taskId=proof.reader.taskId;assert.throws(()=>f.check(proof));});
  it("rejects final ordering loss below millisecond",()=>{const f=setup(),proof=f.proof();proof.reader.reviewedAt="2026-10-06T11:31:00.0000001Z";assert.throws(()=>f.check(proof));});
  it("retains exact final hash binding after bridge changes",()=>{const f=setup(),proof=f.proof();f.bridge.limitations.literalDifferences.push("Extra limit");assert.throws(()=>f.check(proof));});
});
