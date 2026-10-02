import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: vi.fn(), identity: vi.fn(), trigger: vi.fn(), priority: vi.fn(), log: vi.fn(), website: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: mocks.auth, callerAgent: () => "codex", unauthorized: () => new Response("denied", { status: 401 }) }));
vi.mock("@/lib/companyIdentity", () => ({ loadCompanyIdentityContext: mocks.identity }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.log }));
vi.mock("@/lib/db/triggers", () => ({ recordTrigger: mocks.trigger, recomputePriority: mocks.priority }));
vi.mock("@/lib/agent/registryWebsite", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agent/registryWebsite")>(), registryWebsiteVerifier: () => mocks.website }));
import { parseRegistryFinding, registryContentHash } from "@/lib/agent/registryProfiles";
import { registryWebsiteEvidenceHash } from "@/lib/agent/registryWebsite";
import { registryOfficialHistoryBundle, registryOfficialHistoryCanonicalHash, registryOfficialHistoryEvidenceHash } from "@/lib/agent/registryOfficialHistory";
import historyFixture from "../../../../test/fixtures/registry-official-history.json";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { POST, GET } from "./route";
import { registryIrsFilingEntry, registryIrsFilingEvidenceHash, registryIrsFilingCanonicalHash } from "@/lib/agent/registryIrsFiling";

type Row = Record<string, any>; // DB fixture rows deliberately model the external boundary.
let tables: Record<string, Row[]>;
let eventReadError = false;
const writes = vi.fn();
const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function finding() {
  const identity = { legalName: "Acme Inc", addressLine1: "123 Main St", state: "TX", postalCode: "78701" };
  const sourceRow = { ...identity, drivers: 20 }, evidence = JSON.stringify(sourceRow);
  return { internalId: "123", companyId, source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "777", sourceAsOf: null, observedAt: "2026-09-01T00:00:00Z", facts: [{ field: "drivers", value: 20 }], identity,
      provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } };
}
const post = (body: unknown) => POST(new Request("https://example.test/api/agent/insights", { method: "POST", body: JSON.stringify(body) }));
function websiteFinding(sourceUrl = "https://acme.test/") {
  const input = finding(), quote = "Acme Inc Headquarters 123 Main St Austin TX 78701", hash = createHash("sha256").update(quote).digest("hex");
  const proof = { sourceUrl, normalizedVisibleTextSha256: hash, quoteSha256: hash, quote, subject: "Acme Inc", address: { addressLine1: "123 Main St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const } };
  const evidenceSha256 = registryWebsiteEvidenceHash(parseRegistryFinding(input), proof);
  return { ...input, officialWebsiteCorroboration: { ...proof, reader: { taskId: "/root/reader", reviewedAt: new Date().toISOString(), evidenceSha256 }, reviewer: { taskId: "/root/reviewer", reviewedAt: new Date().toISOString(), evidenceSha256 } } };
}
beforeEach(() => {
  vi.clearAllMocks(); eventReadError = false; mocks.auth.mockReturnValue(true);
  tables = { companies: [{ id: companyId, netsuite_internal_id: "123", name: "Acme Inc", domain: "acme.test", lists: ["netsuite_tam"] }], lead_insights: [], app_events: [] };
  mocks.identity.mockResolvedValue({ aliases: ["Acme Inc"], addresses: [{ addressLine1: "123 Main St", state: "TX", postalCode: "78701", sourceKind: "netsuite_record", sourceId: "source-1", capturedAt: "2026-09-01T00:00:00Z" }], context: "PRIVATE CRM HEADER MUST NEVER BE RETURNED" });
  mocks.from.mockImplementation((table: string) => {
    let rows = [...(tables[table] ?? [])];
    const query: Record<string, any> = {
      select: () => query,
      in: (field: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[field])); return query; },
      eq: (field: string, value: unknown) => { rows = rows.filter(row => row[field] === value); return query; },
      order: () => query,
      upsert: (payload: Row[]) => { writes(table, payload); tables[table].push(...payload); return query; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: table === "app_events" && eventReadError ? { code: "57014" } : null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: table === "app_events" && eventReadError ? { code: "57014" } : null }),
    };
    return query;
  });
  mocks.rpc.mockImplementation(async (_name: string, { p_rows }: { p_rows: Row[] }) => {
    const rows: Row[] = p_rows.map((row, i) => ({ ...row, id: `insight-${i}`, registry_profile: { ...row.registry_profile, publication: { contentHash: row.content_hash, eventId: "event-1", publishedAt: "2026-09-29T00:00:00Z" } } }));
    tables.lead_insights = rows;
    tables.app_events = [{ id: "event-1", kind: "registry.profiles_recorded", meta: { changed: rows.length, receipts: rows.map(row => ({ id: row.id, companyId: row.company_id, internalId: row.netsuite_internal_id, profileKey: row.label, contentHash: row.content_hash })) } }];
    return { data: { rows, changed: rows.length, eventId: "event-1" }, error: null };
  });
});
describe("registry insight publication", () => {
  it("publishes reviewed official history through the existing RPC and exact event readback", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T04:00:00Z"));
    try {
      tables.companies = [{ ...historyFixture.company, lists: ["netsuite_tam"] }];
      const context = historyFixture.context as CompanyIdentityContext;
      mocks.identity.mockResolvedValue(context);
      const input = structuredClone(historyFixture.findings[0]), row = parseRegistryFinding(input), bundle = registryOfficialHistoryBundle();
      const p = { schema: "colorado_sos_history_v1" as const, bundleId: bundle.id, bundleSha256: bundle.sha256,
        canonicalIdentitySha256: registryOfficialHistoryCanonicalHash(historyFixture.company, context), addressEntryKey: "university_mailing_2006" as const };
      const evidenceSha256 = registryOfficialHistoryEvidenceHash(row, p), reviewedAt = new Date().toISOString();
      const proof = { ...p, reader: { taskId: "/unit-test/reader", reviewedAt, evidenceSha256 }, reviewer: { taskId: "/unit-test/reviewer", reviewedAt, evidenceSha256 } };
      const finding = { ...input, officialRegistrationHistoryCorroboration: proof };
      expect((await post({ findings: [finding], dryRun: true })).status).toBe(200);
      expect(mocks.rpc).not.toHaveBeenCalled();
      const response = await post({ findings: [finding] });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "published", receipts: [{ eventVerified: true }] });
      expect(tables.lead_insights[0].registry_profile.verification.method).toBe("reviewed_official_registration_history");
      expect(tables.lead_insights[0].evidence).toBe(input.evidence);
      expect(tables.lead_insights[0].registry_profile.identity).toEqual(input.registryProfile.identity);
      expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.website).not.toHaveBeenCalled();
      expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.priority).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("rejects mixed history/SAM/website proofs and invalid history before any write", async () => {
    for (const extra of [{ samCorroboration: {} }, { officialWebsiteCorroboration: {} }, { samCorroboration: {}, officialWebsiteCorroboration: {} }]) {
      const response = await post({ findings: [{ ...finding(), officialRegistrationHistoryCorroboration: {}, ...extra }] });
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: "registry corroboration methods cannot be mixed on one finding" });
    }
    // A passing direct identity never overrides an invalid supplied history proof.
    expect((await post({ findings: [{ ...finding(), officialRegistrationHistoryCorroboration: {} }] })).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(mocks.website).not.toHaveBeenCalled();
  });
  it("uses fresh website verification for held identities through the same exact publisher and readback", async () => {
    mocks.identity.mockResolvedValue({ aliases: [], addresses: [], context: "" });
    mocks.website.mockResolvedValue({ method: "official_website_corroboration", verifiedAt: new Date().toISOString(), sourceIds: ["website:sha256:proof"], website: { quote: "exact reviewed passage" } });
    const input = websiteFinding();
    const dryRun = await post({ findings: [input], dryRun: true });
    expect(dryRun.status).toBe(200); expect(mocks.rpc).not.toHaveBeenCalled();
    const published = await post({ findings: [input] });
    expect(published.status).toBe(200); expect(mocks.website).toHaveBeenCalledTimes(2);
    expect(tables.lead_insights[0].registry_profile.verification.method).toBe("official_website_corroboration");
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.priority).not.toHaveBeenCalled();
  });
  it("fails a forged or unavailable website proof before any write, and caps distinct reviewed pages", async () => {
    const input = websiteFinding();
    input.officialWebsiteCorroboration.reviewer.evidenceSha256 = "f".repeat(64);
    expect((await post({ findings: [input] })).status).toBe(422); expect(mocks.website).not.toHaveBeenCalled();
    mocks.website.mockRejectedValue(new Error("registry website changed or exact reviewed quote missing"));
    expect((await post({ findings: [websiteFinding()] })).status).toBe(422);
    const four = Array.from({ length: 4 }, (_, i) => {
      const item = websiteFinding(`https://acme.test/page-${i}`);
      item.registryProfile.recordId = String(i);
      const { reader, reviewer, ...proof } = item.officialWebsiteCorroboration;
      const evidenceSha256 = registryWebsiteEvidenceHash(parseRegistryFinding(item), proof);
      return { ...item, officialWebsiteCorroboration: { ...proof, reader: { ...reader, evidenceSha256 }, reviewer: { ...reviewer, evidenceSha256 } } };
    });
    expect((await post({ findings: four })).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
  it("dry run verifies canonical source identity with no write or trigger/priority path", async () => {
    tables.companies.push({ ...tables.companies[0], id: "historical", lists: ["tam_duplicate"] });
    const result = await post({ findings: [finding()], dryRun: true });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ wouldWriteInsights: 1, wouldWriteTriggers: 0 });
    expect(mocks.identity).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.priority).not.toHaveBeenCalled();
  });
  it("rejects ambiguous canonical rows, wrong UUID and insufficient independently sourced address", async () => {
    tables.companies.push({ ...tables.companies[0], id: "other-canonical" });
    expect((await post({ findings: [finding()] })).status).toBe(422);
    tables.companies.pop();
    expect((await post({ findings: [{ ...finding(), companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] })).status).toBe(422);
    mocks.identity.mockResolvedValue({ aliases: [], addresses: [], context: "" });
    expect((await post({ findings: [finding()] })).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns exact saved row and atomic event receipt, without emitting a growth signal", async () => {
    const response = await post({ findings: [finding()] }), body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ state: "published", insightsWritten: 1, triggersWritten: 0, eventId: "event-1", receipts: [{ companyId, internalId: "123", profileKey: "registry:fmcsa:777", eventId: "event-1" }] });
    expect(mocks.rpc).toHaveBeenCalledWith("registry_profiles_publish", expect.objectContaining({ p_agent: "codex" }));
    expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.priority).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
  it("marks uncertain write or failed exact event readback pending and never repeats RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014" } });
    const first = await post({ findings: [finding()] });
    expect(first.status).toBe(502); expect(await first.json()).toMatchObject({ state: "verification_pending" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    eventReadError = true;
    const second = await post({ findings: [finding()] });
    expect(second.status).toBe(502); expect(await second.json()).toMatchObject({ state: "verification_pending", eventId: "event-1" });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("rejects mixed and duplicate/oversized registry batches atomically before writes", async () => {
    expect((await post({ findings: [finding(), { internalId: "123", kind: "ops_profile", label: "Legacy", evidence: "A sufficiently long quote" }] })).status).toBe(422);
    expect((await post({ findings: [finding(), finding()] })).status).toBe(422);
    expect((await post({ findings: Array.from({ length: 51 }, finding) })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not trust an unrelated same-kind event or a corrupted saved row", async () => {
    const publish = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementationOnce(async (...args) => {
      const result = await publish(...args);
      tables.app_events[0].meta.receipts[0].contentHash = "unrelated";
      return result;
    });
    expect((await post({ findings: [finding()] })).status).toBe(502);
    mocks.rpc.mockImplementationOnce(async (...args) => {
      const result = await publish(...args);
      tables.lead_insights[0].evidence = "different evidence";
      return result;
    });
    expect((await post({ findings: [finding()] })).status).toBe(502);
  });
  it("unchanged publication reuses the exact prior row and verifies its prior event", async () => {
    await post({ findings: [finding()] });
    mocks.rpc.mockResolvedValueOnce({ data: { changed: 0, eventId: null, rows: tables.lead_insights }, error: null });
    const response = await post({ findings: [finding()] });
    expect(await response.json()).toMatchObject({ state: "unchanged", insightsWritten: 0, triggersWritten: 0, receipts: [{ id: "insight-0", eventId: "event-1", eventVerified: true }] });
    expect(tables.lead_insights).toHaveLength(1);
  });
  it("GET returns bounded public identity fields and current registry profiles, never private context", async () => {
    await post({ findings: [finding()] });
    const response = await GET(new Request("https://example.test/api/agent/insights?internalIds=123,456")), body = await response.json();
    expect(body).toMatchObject({ identities: [{ companyId, internalId: "123", name: "Acme Inc", profiles: [{ source: "registry" }] }], missingInternalIds: ["456"], ambiguousInternalIds: [] });
    expect(JSON.stringify(body)).not.toContain("PRIVATE CRM");
    expect((await GET(new Request("https://example.test/api/agent/insights?internalIds=" + Array.from({ length: 51 }, (_, i) => i + 1).join(",")))).status).toBe(400);
  });
  it("preserves legacy no-source LinkedIn insight requests and excludes immutable duplicate history", async () => {
    tables.companies.push({ ...tables.companies[0], id: "historical", lists: ["tam_duplicate"] });
    const response = await post({ findings: [{ internalId: "123", kind: "ops_profile", label: "Project work", evidence: "We provide project-based services." }] });
    expect(response.status).toBe(200);
    expect(writes).toHaveBeenCalledWith("lead_insights", [expect.objectContaining({ company_id: companyId, source: "linkedin" })]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("IRS filing existing registry route", () => {
  function irsInput(entryId="202630989349301128") {
    const {entry,sha256}=registryIrsFilingEntry(entryId), f=entry.filing;
    const raw={EIN:f.ein,NAME:f.legalName,STREET:"123 Test St",CITY:"Austin",STATE:"TX",ZIP:"78701"};
    const identity={legalName:raw.NAME,addressLine1:raw.STREET,city:raw.CITY,state:raw.STATE,postalCode:raw.ZIP},sourceRow={...identity,ein:raw.EIN};
    const evidence=JSON.stringify(sourceRow)+"\nOriginal public source row: "+JSON.stringify(raw),sha=(s:string)=>createHash("sha256").update(s).digest("hex");
    const company={id:companyId,netsuite_internal_id:"123",name:f.legalName,domain:entryId==="202630989349301128"?"tlsc.org":"vcmedia.org",lists:["netsuite_tam"]},context={aliases:[],addresses:[],context:""};
    const input={companyId,internalId:"123",source:"registry",kind:"ops_profile",sourceUrl:"https://www.irs.gov/pub/irs-soi/eo3.csv",evidence,detail:"Dated original BMF observation.",registryProfile:{version:1,dataset:"irs_exempt",recordId:f.ein,sourceAsOf:"2026-09-08",observedAt:"2026-09-29T00:00:00Z",identity,facts:[{field:"ein",value:f.ein}],provenance:{sourceRow,quote:evidence,rowSha256:sha(JSON.stringify(raw))}}};
    const p={schema:"irs990_ein_domain_v1" as const,entryId,entrySha256:sha256,canonicalIdentitySha256:registryIrsFilingCanonicalHash(company,context),...(entryId==="202630989349301128"?{mode:"declared_domain" as const}:{mode:"observed_redirect" as const,redirect:{requestedUrl:"https://www.vconline.org/",finalUrl:"https://vcmedia.org/",normalizedVisibleTextSha256:"a".repeat(64),observedAt:"2026-10-01T06:45:00Z"}})};
    const evidenceSha256=registryIrsFilingEvidenceHash(parseRegistryFinding(input),p),reviewedAt=new Date().toISOString();
    return {company,context,input:{...input,officialIrsFilingCorroboration:{...p,reader:{taskId:"/unit-test/reader",reviewedAt,evidenceSha256},reviewer:{taskId:"/unit-test/reviewer",reviewedAt,evidenceSha256}}}};
  }
  it("uses the same dry run, RPC and exact row/event readback without changing original source",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-01T07:00:00Z"));try{
      const {company,context,input}=irsInput();tables.companies=[company];mocks.identity.mockResolvedValue(context);
      expect((await post({findings:[input],dryRun:true})).status).toBe(200);expect(mocks.rpc).not.toHaveBeenCalled();
      const response=await post({findings:[input]});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:"published",receipts:[{eventVerified:true}]});
      expect(tables.lead_insights[0].registry_profile.verification.method).toBe("reviewed_irs_filing_ein_domain");expect(tables.lead_insights[0].evidence).toBe(input.evidence);expect(tables.lead_insights[0].registry_profile.identity).toEqual(input.registryProfile.identity);expect(mocks.website).not.toHaveBeenCalled();expect(mocks.trigger).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it("rejects mixed proofs and invalid IRS admission before all writes",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-01T07:00:00Z"));try{
      const {input}=irsInput();for(const extra of [{officialWebsiteCorroboration:{}},{samCorroboration:{}},{officialRegistrationHistoryCorroboration:{}}])expect((await post({findings:[{...input,...extra}]})).status).toBe(422);
      input.officialIrsFilingCorroboration.entrySha256="0".repeat(64);expect((await post({findings:[input]})).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it("sums website and IRS request caches before any lookup or fetch",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-01T07:00:00Z"));try{
      const {input}=irsInput("202620159349300242");
      const websites=Array.from({length:3},(_,i)=>{const item=websiteFinding(`https://acme.test/page-${i}`);item.registryProfile.recordId=String(i);const {reader,reviewer,...p}=item.officialWebsiteCorroboration;const evidenceSha256=registryWebsiteEvidenceHash(parseRegistryFinding(item),p);return {...item,officialWebsiteCorroboration:{...p,reader:{...reader,evidenceSha256},reviewer:{...reviewer,evidenceSha256}}};});
      const response=await post({findings:[input,...websites]});expect(response.status).toBe(422);expect(await response.json()).toMatchObject({error:"registry website requests capped at three distinct pages"});expect(mocks.from).not.toHaveBeenCalled();expect(mocks.website).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
});

describe("server published-profile anchors",()=>{
  function seedAnchor() {
    const f=parseRegistryFinding(finding()), publication={eventId:"prior-event",contentHash:registryContentHash(f.profile,f.sourceUrl,f.detail),publishedAt:"2026-09-29T00:00:00Z"};
    const row={id:"prior-row",company_id:companyId,netsuite_internal_id:"123",source:"registry",kind:"ops_profile",label:f.label,detail:f.detail,evidence:f.evidence,evidence_url:f.sourceUrl,registry_profile:{...f.profile,verification:{method:"reviewed_official_registration_history",verifiedAt:"2026-09-29T00:00:00Z",sourceIds:["official:retained-source"]},publication}};
    // This synthetic anchor must have a complete city, as must the target.
    const withCity=(input:ReturnType<typeof finding>)=>{input.registryProfile.identity={...input.registryProfile.identity,city:"Austin"} as any;input.registryProfile.provenance.sourceRow={...input.registryProfile.provenance.sourceRow,city:"Austin"} as any;input.evidence=JSON.stringify(input.registryProfile.provenance.sourceRow);input.registryProfile.provenance.quote=input.evidence;return input;};
    const source=parseRegistryFinding(withCity(finding()));row.registry_profile={...source.profile,verification:row.registry_profile.verification,publication} as any;row.evidence=source.evidence;publication.contentHash=registryContentHash(source.profile,source.sourceUrl,source.detail);
    tables.lead_insights=[row];tables.app_events=[{id:"prior-event",kind:"registry.profiles_recorded",meta:{receipts:[{id:row.id,companyId,internalId:"123",profileKey:row.label,contentHash:publication.contentHash}]}}];
    mocks.identity.mockResolvedValue({aliases:[],addresses:[],context:""});
    const target=withCity(finding());target.registryProfile.recordId="888";return {row,target};
  }
  it("uses saved row/event once for a dry-run batch, without new client proof fields",async()=>{
    const {target}=seedAnchor(),second=structuredClone(target);second.registryProfile.recordId="999";
    const res=await post({findings:[target,second],dryRun:true});expect(res.status).toBe(200);
    const body=await res.json();expect(body.profiles).toHaveLength(2);expect(body.profiles[0].verification).toMatchObject({method:"verified_published_profile_identity",publishedAnchor:{rowId:"prior-row",profileKey:"registry:fmcsa:777",eventId:"prior-event"}});
    expect(mocks.from.mock.calls.filter(x=>x[0]==="app_events")).toHaveLength(1);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.website).not.toHaveBeenCalled();
  });
  it.each(["missing event","wrong event company","wrong event kind","changed source","chain","event read failure"])("holds %s before RPC",async reason=>{
    const {row,target}=seedAnchor();
    if(reason==="missing event")tables.app_events=[];
    if(reason==="wrong event company")tables.app_events[0].meta.receipts[0].companyId="wrong";
    if(reason==="wrong event kind")tables.app_events[0].kind="other.event";
    if(reason==="changed source")row.registry_profile.sourceAsOf="2025-01-01";
    if(reason==="chain")row.registry_profile.verification.method="prior_registry_binding";
    if(reason==="event read failure")eventReadError=true;
    expect((await post({findings:[target]})).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not use anchors replaced in the same request or newly admitted target rows",async()=>{
    const {target}=seedAnchor(),replacement=structuredClone(target);replacement.registryProfile.recordId="777";
    expect((await post({findings:[target,replacement]})).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
    tables.lead_insights=[];tables.app_events=[];const second=structuredClone(target);second.registryProfile.recordId="999";
    expect((await post({findings:[target,second]})).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("publishes through the unchanged RPC with exact event readback and no signal or grade writes",async()=>{
    const {target}=seedAnchor(),before=JSON.stringify(target);const res=await post({findings:[target]});expect(res.status).toBe(200);
    const body=await res.json();expect(body.receipts[0].eventVerified).toBe(true);expect(body.triggersWritten).toBe(0);
    expect(tables.lead_insights[0].registry_profile.verification.publishedAnchor.rowId).toBe("prior-row");expect(JSON.stringify(target)).toBe(before);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);expect(mocks.trigger).not.toHaveBeenCalled();expect(mocks.priority).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();
  });
  it("rejects client-owned verification even when it names a real saved anchor",async()=>{
    const {target}=seedAnchor();(target.registryProfile as any).verification={method:"verified_published_profile_identity",publishedAnchor:{rowId:"prior-row"}};
    expect((await post({findings:[target]})).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
