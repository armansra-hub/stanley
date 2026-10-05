import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/registry-se2-authored-report.json";
import { parseRegistryFinding, registryContentHash, stableRegistryJson } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const now=new Date("2026-10-05T21:00:00Z"),reviewedAt="2026-10-05T20:59:00Z";
async function setup(index=0) {
  const all=structuredClone(fixture.cases),f=all[index],e=f.entry;
  vi.resetModules();vi.doMock("./registryOfficialDocumentEntries.json",()=>({default:{schema:"reviewed_official_document_entries_v1",entries:all.map(v=>v.entry)}}));
  const m=await import("./registryOfficialDocuments"),route=await import("./registryOfficialHistory");
  const row=parseRegistryFinding(f.finding,now),context=f.context as CompanyIdentityContext;
  const proof=()=>{const bare={schema:"official_document_roles_v1" as const,entryId:e.id,entrySha256:m.registryOfficialDocumentEntry(e.id).sha256,canonicalIdentitySha256:e.canonicalIdentitySha256};const evidenceSha256=m.registryOfficialDocumentEvidenceHash(row,bare);return {...bare,reader:{taskId:"/test/primary-only-not-a-real-review",reviewedAt,evidenceSha256},reviewer:{taskId:"/test/independent-only-not-a-real-review",reviewedAt,evidenceSha256}};};
  const check=(p=proof())=>route.verifyRegistryOfficialHistory(row,p,f.company,context,now);
  const rebindTarget=()=>{e.target.profileSha256=sha(stableRegistryJson(row.profile));e.target.evidenceSha256=sha(row.evidence);e.target.rowSha256=row.profile.provenance.rowSha256;};
  return {...f,e,m,row,context,proof,check,rebindTarget};
}
describe("compiled dated author letterhead + canonical telephone role",()=>{
  it.each([0,1])("accepts exact retained original %i with synthetic final witnesses only",async i=>{
    const f=await setup(i),before=JSON.stringify(f.row),context=JSON.stringify(f.context),hash=registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail),v=f.check();
    expect(v.method).toBe("reviewed_official_registration_history");
    expect(v.officialHistory?.targetAddress).toEqual({role:"debtor_business",...f.row.profile.identity});
    expect(Object.hasOwn(f.row.profile.identity,"countryCode")).toBe(false);expect(Object.hasOwn(f.row.profile.identity,"addressLine2")).toBe(false);
    expect(JSON.stringify(f.row)).toBe(before);expect(JSON.stringify(f.context)).toBe(context);expect(registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail)).toBe(hash);
    const {reader,reviewer,...bare}=f.proof();expect(f.m.registryOfficialDocumentEvidenceHash(f.row,bare)).toBe(reader.evidenceSha256);
    expect(f.e.report.pages[0].text).not.toContain("770 Sherman Street");expect(f.e.report.letterhead.observations).toHaveLength(2);
    expect(f.e.sources[0].text).not.toContain("770 Sherman Street");expect(f.e.canonicalAliasRole).toBe("retained_context_only");
    expect(JSON.parse(f.row.evidence.split("\n")[0]).actiontype).toBe(i?"delete only":"add");
    expect(JSON.parse(f.row.evidence.split("\n")[1]).masterdocumentid).toBe("2003F037484");
  });
  it.each(["source_url","source_kind","source_status","source_text","source_body_pin","source_receipt","page_missing","page_order","page_text","page_visual","extraction_pin","own_host","own_hop","own_phone","own_subject"])("rejects source corruption %s",async k=>{
    const f=await setup(),e=f.e,p=e.report;
    if(k==="source_url")e.sources[0].url="https://other.test/report.pdf";
    if(k==="source_kind")e.sources[0].kind="municipal_pdf";
    if(k==="source_status")e.sources[0].status=403;
    if(k==="source_text")e.sources[0].text+=" changed";
    if(k==="source_body_pin")e.sources[0].bodySha256="missing";
    if(k==="source_receipt")e.sources[0].receiptSha256="missing";
    if(k==="page_missing")p.pages.pop();if(k==="page_order")p.pages.reverse();if(k==="page_text")p.pages[0].text+=" changed";
    if(k==="page_visual")p.pages[0].visualSha256="missing";if(k==="extraction_pin")p.extractionReceiptSha256="0".repeat(64);
    if(k==="own_host")e.sources[1].url="https://other.test/";if(k==="own_hop")e.sources[1].hops[0].url="http://other.test/";
    if(k==="own_phone")p.ownSitePhoneQuote="303.892.9101 | Privacy & Terms";if(k==="own_subject")p.ownSiteSubjectQuote="SE2";
    expect(()=>f.check()).toThrow();
  });
  it.each(["recipient_as_author","missing_author","wrong_identity_page","visual_claimed_extracted","graphic_subject","graphic_street","graphic_city","graphic_zip","phone","missing_visual_reader","visual_actor","visual_receipt","visual_page","visual_image","visual_phone","date","effective_date","occupancy","alias_equivalence","current_debt"])("rejects identity/role change %s",async k=>{
    const f=await setup(),p=f.e.report,l=p.letterhead;
    if(k==="recipient_as_author")p.authorQuote=p.recipientQuote;if(k==="missing_author")p.authorQuote="FROM: Nobody, SE2";
    if(k==="wrong_identity_page")p.identityPage=2;if(k==="visual_claimed_extracted")Object.assign(l,{inExtractedText:true});
    if(k==="graphic_subject")l.subject="E-Squared Communications Group, Inc.";if(k==="graphic_street")l.addressLineLiteral="771 Sherman Street";
    if(k==="graphic_city")l.localityLiteral="Boulder, CO 80203";if(k==="graphic_zip")l.localityLiteral="Denver, CO 80209";
    if(k==="phone")f.e.phone="3038929101";if(k==="missing_visual_reader")l.observations.pop();
    if(k==="visual_actor")l.observations[1].taskId=l.observations[0].taskId;if(k==="visual_receipt")l.observations[1].receiptSha256="0".repeat(64);
    if(k==="visual_page")l.observations[0].page=2;if(k==="visual_image")l.observations[0].visualSha256="0".repeat(64);
    if(k==="visual_phone")l.observations[1].text=l.observations[1].text.replace("TEL: 303.892.9100","TEL: 303.892.9101");
    if(k==="date")p.documentDate="2018-01-08";if(k==="effective_date")Object.assign(p,{addressEffectiveDate:"2014-01-28"});
    if(k==="occupancy")Object.assign(p,{continuousOccupancyClaim:true});if(k==="alias_equivalence")Object.assign(p,{legalAliasEquivalenceClaim:true});
    if(k==="current_debt")Object.assign(p,{currentDebtClaim:true});expect(()=>f.check()).toThrow();
  });
  it.each(["added_country","added_unit","changed_name","changed_filing","changed_master"])("rejects original identity/fact edits even with recomputed test pins: %s",async k=>{
    const f=await setup();if(k==="added_country")f.row.profile.identity.countryCode="US";if(k==="added_unit")f.row.profile.identity.addressLine2="Suite 100";
    if(k==="changed_name")f.row.profile.identity.legalName="SE2 INC";
    if(k==="changed_filing"||k==="changed_master"){const [a,b]=f.row.evidence.split("\n"),v=JSON.parse(b);if(k==="changed_master")v.masterdocumentid="other";else v.transactiontype="Initial Filing";f.row.evidence=a+"\n"+JSON.stringify(v);f.row.profile.provenance.quote=f.row.evidence;}
    f.rebindTarget();expect(()=>f.check()).toThrow();
  });
  it.each(["canonical_alias","canonical_address","canonical_id","domain","source_actors","source_time","source_actor_field","original_actor","final_actors","final_hash","stale_final","caller_source"])("retains ordinary canonical/provenance/final gate %s",async k=>{
    const f=await setup();const p=f.proof();
    if(k==="canonical_alias")f.context.aliases.push("Another LLC");if(k==="canonical_address")f.context.addresses[0].addressLine1="770 Sherman Street";
    if(k==="canonical_id")f.company.id="other";if(k==="domain")f.company.domain="publicpersuasion.com";
    if(k==="source_actors")f.e.sourceReviewer.taskId=f.e.sourceReader.taskId;if(k==="source_time")f.e.sourceReviewer.reviewedAt="2026-09-29T00:00:00Z";
    if(k==="source_actor_field")f.e.sourceReader.receiptActorField="fake";if(k==="original_actor")f.e.originalReviews.independent.taskId=f.e.originalReviews.primary.taskId;
    if(k==="final_actors")p.reviewer.taskId=p.reader.taskId;if(k==="final_hash")p.reviewer.evidenceSha256="0".repeat(64);
    if(k==="stale_final")p.reviewer.reviewedAt="2026-09-01T00:00:00Z";if(k==="caller_source")Object.assign(p,{sources:f.e.sources});
    expect(()=>f.check(k.startsWith('final')||k==='stale_final'||k==='caller_source'?p:undefined)).toThrow();
  });
});
