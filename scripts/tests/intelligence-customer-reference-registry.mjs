/** Actual offline PostgreSQL behavior; synthetic records only, no provider IO. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0]??{})[0];
const add = rows => scalar("select intelligence_customer_reference_import($1)",[rows]);
const record = (id,extra={}) => ({id,name:`Company ${id}`,domain:`${id}.example.com`,website:`https://${id}.example.com/`,
 announcementDate:"2026-09-01",announcementType:"new_customer",asOf:"2026-09-28",
 announcements:[{id:`announcement-${id}`,date:"2026-09-01",type:"new_customer",sourceUrl:"https://workspace.slack.com/archives/channel/message"}],
 candidateUrls:[`https://${id}.example.com/`],identityNotes:[],...extra});
let passed=0;
const pass=name=>{passed++;console.log(`PASS ${name}`);};
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table intelligence_customer_references(id text primary key,catalog_version text,evidence_key text,status text,result jsonb,
 checkpoint jsonb,lease_token uuid,lease_until timestamptz,updated_at timestamptz default now());`);
 await db.exec(await readFile(new URL("../../supabase/migrations/0131_private_customer_reference_registry.sql",import.meta.url),"utf8"));
 for(let i=0;i<1003;i+=100) await add(Array.from({length:Math.min(100,1003-i)},(_,j)=>record(`customer-${String(i+j).padStart(4,"0")}`)));
 const seen=[];let after=null;
 for(;;){const page=await scalar("select intelligence_customer_reference_registry_page($1,250)",[after]);if(!page.length)break;
 seen.push(...page.map(row=>row.id));after=page.at(-1).id;}
 assert.equal(seen.length,1003);assert.equal(new Set(seen).size,1003);pass("all1003 reference identities survive keyset paging");
 await add([record("anonymous",{name:"Unresolved customer announcement 123",domain:null,website:null,candidateUrls:[]})]);
 const anonymous=await scalar("select to_jsonb(r) from intelligence_customer_reference_registry r where id='anonymous'");
 assert.equal(anonymous.domain,null);assert.equal(anonymous.source_status,"pending");assert.equal(anonymous.announcements.length,1);
 pass("unresolved identities are retained in accounting without invented websites");
 await add([record("program-a",{domain:"shared.example.com",website:"https://shared.example.com/"}),record("program-b",{domain:"shared.example.com",website:"https://shared.example.com/"})]);
 assert.equal(await scalar("select count(*)::int from intelligence_customer_reference_registry where domain='shared.example.com'"),2);
 pass("distinct businesses sharing a host are not merged");
 const legacy=record("legacy");await add([legacy]);
 const source={id:"source",url:"https://legacy.example.com/services",title:"Services",text:"Complete actual official wording",contentHash:"a".repeat(64),observedAt:"2026-09-28"};
 await db.query("update intelligence_customer_reference_registry set sources=$1,source_status='ready' where id='legacy'",[[source]]);
 const native={id:"legacy",catalogVersion:"catalog",completedAt:"2026-09-28",status:"verified",answers:{facet:{decision:"supported",facetVersion:"v1",sourceUrls:[source.url],
 nativeResult:{questionId:"facet",answer:{type:"choice",choice:"supported"},receiptFingerprint:"exact-paid-receipt"}}}};
 await db.query("insert into intelligence_customer_references values('legacy','catalog','evidence','complete',$1,$2,null,null,now())",[native,{answers:native.answers,lastError:null}]);
 const imported=record("alias",{existingReferenceId:"legacy",name:"Different announcement spelling",domain:"legacy.example.com",website:"https://legacy.example.com/",
 announcementDate:"2026-09-28",announcementType:"renewal",announcements:[{id:"renewal",date:"2026-09-28",type:"renewal",sourceMessageId:"private-message-id"}]});
 const first=await add([imported]);const second=await add([imported]);
 assert.equal(first.records[0].id,"legacy");assert.equal(second.records[0].created,false);
 const retained=await scalar("select to_jsonb(r) from intelligence_customer_reference_registry r where id='legacy'");
 assert.equal(retained.name,"Company legacy");assert.equal(retained.announcement_type,"renewal");assert.equal(retained.announcements.length,2);
 assert.deepEqual(retained.sources,[source]);assert.equal(retained.source_status,"ready");
 assert.deepEqual(await scalar("select result from intelligence_customer_references where id='legacy'"),native);
 pass("explicit audited aliases reuse native results and sources; repeated imports preserve distinct announcements once");
 const page=await scalar("select intelligence_customer_reference_registry_page('legacx',1)");
 assert.equal(page[0].id,"legacy");assert.equal(page[0].sources[0].text,undefined);assert.equal(page[0].sources[0].contentHash,source.contentHash);
 assert.equal(page[0].announcements,undefined);assert.equal(page[0].announcement_count,2);assert.equal(page[0].native_answered,1);
 const compact=await scalar("select intelligence_customer_reference_match_page(null,100)");
 assert.equal(compact.length,1);assert.equal(compact[0].result.answers.facet.nativeResult.receiptFingerprint,undefined);
 assert.deepEqual(compact[0].result.answers.facet.nativeResult.answer,native.answers.facet.nativeResult.answer);
 pass("cohort read contains exact native choice/proof but no source bodies, private provenance or wide receipts");
 await db.exec("begin");
 await assert.rejects(()=>add([record("should-rollback"),record("unknown-alias",{existingReferenceId:"nonexistent"})]),/Unknown existing/);
 await db.exec("rollback");assert.equal(await scalar("select count(*)::int from intelligence_customer_reference_registry where id='should-rollback'"),0);
 await db.exec("begin");await assert.rejects(()=>add([record("legacy",{domain:"different.example.com"})]),/identity conflict/);await db.exec("rollback");
 pass("unknown aliases and changed identities fail atomically instead of overwriting paid evidence");
 for(const role of ["anon","authenticated"]){
 assert.equal(await scalar("select has_table_privilege($1,'intelligence_customer_reference_registry','SELECT')",[role]),false);
 for(const fn of ["intelligence_customer_reference_registry_page(text,integer)","intelligence_customer_reference_match_page(text,integer)","intelligence_customer_reference_import(jsonb)"])
 assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')",[role,fn]),false);}
 assert.equal(await scalar("select relrowsecurity from pg_class where oid='intelligence_customer_reference_registry'::regclass"),true);
 pass("private customer registry and import/read RPCs remain service-role-only");
 console.log(`${passed} private registry PostgreSQL checks passed.`);
} finally {await db.close();}
