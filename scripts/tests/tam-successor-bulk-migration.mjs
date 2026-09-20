import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const requireLocal=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));
const {PGlite}=requireLocal('@electric-sql/pglite');
const db=await PGlite.create('memory://');
const hash=s=>createHash('sha256').update(s).digest('hex');
const idHash=ids=>hash(ids.map(id=>id+'\n').join(''));
const sql=async file=>readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8');
const scalar=async(q,p=[])=>Object.values((await db.query(q,p)).rows[0])[0];
let passed=0;
try {
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema extensions;
  create function public.digest(bytea,text) returns bytea language sql immutable as $$select sha256($1)$$;
  create table companies(id uuid primary key,netsuite_internal_id text,lists text[],status text,erp_incumbent text,
   qual_note text,last_sql_date date,codex_score numeric,tam_score numeric,oldgold_score numeric,oldgold_class text,
   oldgold_reasons jsonb,revisit_on date,record_dead boolean,record_dead_reason text,record_digest text,score_adjust_note text,tam_provisional boolean);
  create table lead_documents(id uuid primary key default gen_random_uuid(),company_id uuid,netsuite_internal_id text,doc_type text,body text,sha256 text,captured_at timestamptz,created_at timestamptz default now());`);
 await db.exec((await sql('0043_tam_regrade_coordination.sql')).replace('create extension if not exists pgcrypto;',''));
 await db.exec(await sql('0049_tam_checkpoint_seed.sql'));
 await db.exec(await sql('0052_tam_pgcrypto_search_path.sql'));
 await db.exec(await sql('0088_tam_changed_evidence.sql'));
 await db.exec(await sql('0097_tam_successor_bulk_evidence.sql'));
 passed++;
 const snapshot=hash('snapshot'),sourceHashes={evidenceIndex:hash('index'),registrations:hash('registrations')};
 const capture={current:snapshot,allowedPrior:[]};
 const counts={currentTotal:4,removedTotal:0,pdfVerified:4,publishedComplete:2,legacySchemaRecovery:0,lostStagingRecovery:0,activeHold:1,unrepresented:1};
 const hashes={current:idHash(['1','2','3','4']),removed:idHash([]),publishedComplete:idHash(['1','2']),legacySchemaRecovery:idHash([]),lostStagingRecovery:idHash([]),activeHold:idHash(['3']),unrepresented:idHash(['4'])};
 const pred=await scalar("select bootstrap_tam_regrade_run('predecessor','1327786','{}','capturing',4,$1)",[snapshot]);
 const members=[];
 for(const id of ['1','2','3','4']) {
  const company=randomUUID();
  await db.query(`insert into companies values($1,$2,array['netsuite_tam'],'active',null,null,null,38,38,null,'no_revival','[]',null,false,null,'Full validated company chronology','TAM equals raw grade; public signals are Triggered-only',false)`,[company,id]);
  await db.query(`insert into tam_regrade_records(run_id,netsuite_internal_id,company_id,company_name,table_rows,source_coordinates,saved_search_row_count,table_rows_sha256,pdf_status,pdf_object_path,pdf_sha256,pdf_page_count,pdf_verified_at)
   values($1,$2,$3,$4,'[{"source":"saved search"}]','[{"page":1,"row":1}]',1,$5,'verified',$6,$7,2,'2026-09-18T12:00:00Z')`,[pred.id,id,company,'Company '+id,hash('table'+id),'old/'+id+'/print.pdf',hash('pdf'+id)]);
  members.push({netsuiteInternalId:id,membershipOrdinal:Number(id),tableRowsSha256:hash('table'+id),pdfObjectPath:'old/'+id+'/print.pdf',pdfSha256:hash('pdf'+id),pdfPageCount:2,pdfVerifiedAt:'2026-09-18T12:00:00Z',pdfCaptureSnapshotSha256:snapshot});
 }
 const published=(base,run)=>{
  const assessment={exact_id:base.netsuiteInternalId,final_score:38,record_digest:'Full validated company chronology',old_gold_score:0,old_gold_class:'no_revival',old_gold_reasons:[],intro_call_exists:false,opportunity_exists:false,revisit_on:null,dq_reason:'',validation:{status:'passed',validated_by:'validator',validated_at:'2026-09-18T13:00:00Z'}};
  const data={schema:'tam-grade-provenance',version:1,runSlug:run,netsuiteInternalId:base.netsuiteInternalId,method:'full-record-reader-plus-independent-full-record-validator',validatorHashScope:'canonical-record',snapshotSha256:snapshot,pdfSha256:base.pdfSha256,pdfPageCount:2,recordTextSha256:hash('text'+base.netsuiteInternalId),assessment,
   jevCompletion:{status:'complete',recordTextSha256:hash('text'+base.netsuiteInternalId),pdfSha256:base.pdfSha256,nativeAnswers:{retained:'Exact existing native answer'}}};
  const canonicalJson=JSON.stringify(data);
  return {...base,recoveryCohort:'published_complete',finalAssessmentLineSha256:hash(JSON.stringify(assessment)),publishQueueLineSha256:hash('queue'+base.netsuiteInternalId),historicalPublishedAt:'2026-09-18T14:00:00Z',finalScore:38,recordDigest:assessment.record_digest,
   provenance:{data,canonicalJson,sha256:hash(canonicalJson),objectPath:run+'/'+base.netsuiteInternalId+'.json'},validation:{status:'passed',validatedBy:'validator',validatedAt:'2026-09-18T13:00:00Z'}};
 };
 const original=[published(members[0],'predecessor'),published(members[1],'predecessor'),{...members[2],recoveryCohort:'active_hold',holdReason:'Identity review remains unresolved',holdFileSha256:hash('hold')},{...members[3],recoveryCohort:'unrepresented'}];
 const started=await scalar('select begin_tam_regrade_checkpoint_seed($1,$2,$3,$4,$5,$6,$7,$8,$9)',['predecessor','codex',hash('prior manifest'),'prior/manifest.json','a'.repeat(40),counts,hashes,capture,sourceHashes]);
 await scalar('select seed_tam_regrade_checkpoint_batch($1,$2,$3,$4)',['predecessor','codex',started.seedToken,original]);
 await scalar('select finalize_tam_regrade_checkpoint_seed($1,$2,$3)',['predecessor','codex',started.seedToken]);
 await db.query("update tam_regrade_runs set status='paused' where id=$1",[pred.id]);
 const before=(await db.query('select * from tam_regrade_records where run_id=$1 order by membership_ordinal',[pred.id])).rows;
 const companiesBefore=(await db.query('select * from companies order by netsuite_internal_id')).rows;
 const fingerprints=before.map(r=>({internalId:r.netsuite_internal_id,sha256:hash([r.run_id,r.checkpoint_seed_id,r.netsuite_internal_id,r.company_id,String(r.membership_ordinal),r.table_rows_sha256,r.pdf_sha256,r.pdf_object_path,String(r.pdf_page_count),new Date(r.pdf_verified_at).toISOString().replace('.000Z','.000000Z'),r.grade_status,r.grade_provenance_sha256??'',r.hold_reason==null?'':hash(r.hold_reason)].join('\n'))}));
 for(let i=0;i<4;i++) assert.equal(await scalar('select tam_successor_predecessor_binding(r) from tam_regrade_records r where run_id=$1 and netsuite_internal_id=$2',[pred.id,String(i+1)]),fingerprints[i].sha256);
 passed++;
 const freshText='Fresh exact CRM body';
 const document=await scalar("insert into lead_documents(company_id,netsuite_internal_id,doc_type,body,sha256,captured_at) values($1,'1','record_text',$2,$3,'2026-09-20T10:00:00Z') returning id",[before[0].company_id,freshText,hash(freshText)]);
 const receipt=await scalar('select id from tam_evidence_change_receipts where document_id=$1',[document]);
 const nextCounts={...counts,publishedComplete:1,unrepresented:2};
 const nextHashes={...hashes,publishedComplete:idHash(['2']),unrepresented:idHash(['1','4'])};
 const manifest={schema:'tam-successor-checkpoint-manifest',version:1,runSlug:'successor',historicalRunSlug:'predecessor',expectedCounts:nextCounts,cohortHashes:nextHashes,captureSnapshotHashes:capture,sourceHashes,releaseCommit:'a'.repeat(40)};
 const manifestCanonicalJson=JSON.stringify(manifest)+'\n';
 const input={action:'evidence_successor_initialize',predecessorRunSlug:'predecessor',predecessorSeedId:started.seedId,
  bootstrap:{runSlug:'successor',searchId:'1327786',mission:{changedEvidence:{predecessorRunId:pred.id,evidenceIndexSha256:sourceHashes.evidenceIndex,registrationSha256:sourceHashes.registrations}},sourceTotal:4,sourceSnapshotSha256:snapshot},
  seed:{runSlug:'successor',actorKey:'codex',manifestSha256:hash(manifestCanonicalJson),manifestObjectPath:'successor/manifest.json',releaseCommit:manifest.releaseCommit,expectedCounts:nextCounts,cohortHashes:nextHashes,captureSnapshotHashes:capture,sourceHashes},manifestCanonicalJson,
  expectedPredecessorBindings:fingerprints,changes:[{receiptId:receipt,internalId:'1',recordTextSha256:hash(freshText),pdfObjectPath:'fresh/1/print.pdf',pdfSha256:hash('fresh pdf'),pdfPageCount:3,pdfVerifiedAt:'2026-09-20T10:01:00Z',pdfCaptureSnapshotSha256:snapshot}]};
 const call=value=>scalar('select tam_initialize_changed_successor($1)',[value]);
 const reject=async mutate=>{const invalid=structuredClone(input);mutate(invalid);await assert.rejects(call(invalid));assert.equal(await scalar("select count(*)::int from tam_regrade_runs where slug='successor'"),0);passed++;};
 await reject(v=>{v.expectedPredecessorBindings[1].sha256=hash('changed');});
 await reject(v=>{v.expectedPredecessorBindings.pop();});
 await reject(v=>{v.expectedPredecessorBindings[1]=v.expectedPredecessorBindings[0];});
 await reject(v=>{v.predecessorSeedId=randomUUID();});
 await reject(v=>{v.changes[0].recordTextSha256=hash('different text');});
 await reject(v=>{v.changes[0].pdfObjectPath='../escape.pdf';});
 await reject(v=>{v.changes[0].pdfSha256=before[0].pdf_sha256;});
 await reject(v=>{v.changes[0].internalId='3';});
 await reject(v=>{v.manifestCanonicalJson+=' ';});
 await reject(v=>{v.seed.expectedCounts.activeHold=0;});
 // This passes bulk-copy preconditions, then fails inside the existing seed
 // begin. Both the newly created run and all copied rows must roll back.
 await reject(v=>{v.seed.captureSnapshotHashes.allowedPrior=['bad'];const m=JSON.parse(v.manifestCanonicalJson);m.captureSnapshotHashes=v.seed.captureSnapshotHashes;v.manifestCanonicalJson=JSON.stringify(m)+'\n';v.seed.manifestSha256=hash(v.manifestCanonicalJson);});
 await db.query("update tam_regrade_runs set status='grading' where id=$1",[pred.id]);
 await assert.rejects(call(input),/paused or completed/);passed++;
 await db.query("update tam_regrade_runs set status='paused' where id=$1",[pred.id]);
 await db.exec('begin');
 await db.query("update tam_regrade_runs set status='grading' where id=$1",[pred.id]);
 // An actual canonical claim must also block the carry-forward after dispatch
 // is paused. Roll this whole rehearsal back to leave the fixture unchanged.
 await scalar("select claim_tam_regrade_record('predecessor','3','another-reader',true,null,300)");
 await db.query("update tam_regrade_runs set status='paused' where id=$1",[pred.id]);
 await assert.rejects(call(input),/idle boundary/);await db.exec('rollback');passed++;
 const result=await call(input);
 assert.equal(result.copied,4);assert.equal(result.changed,1);assert.equal(result.seed.status,'building');
 const copied=(await db.query('select * from tam_regrade_records where run_id=$1 order by netsuite_internal_id',[result.run.id])).rows;
 for(let i=0;i<4;i++) {assert.equal(copied[i].company_id,before[i].company_id);assert.deepEqual(copied[i].table_rows,before[i].table_rows);assert.equal(copied[i].pdf_sha256,i===0?input.changes[0].pdfSha256:before[i].pdf_sha256);assert.equal(copied[i].grade_status,'pending');assert.equal(copied[i].grade_provenance_sha256,null);}
 assert.deepEqual((await db.query('select * from tam_regrade_records where run_id=$1 order by membership_ordinal',[pred.id])).rows,before);
 assert.deepEqual((await db.query('select * from companies order by netsuite_internal_id')).rows,companiesBefore);passed++;
 const retry=await call(input);assert.equal(retry.seed.seedId,result.seed.seedId);assert.equal(retry.seed.seedToken,result.seed.seedToken);
 assert.equal(await scalar("select count(*)::int from tam_regrade_events where kind='checkpoint.successor_carried_forward'"),1);passed++;
 const drift=structuredClone(input);drift.changes[0].pdfPageCount=4;await assert.rejects(call(drift),/different or unproven/);passed++;
 await assert.rejects(db.query("update tam_regrade_records set pdf_sha256=$1 where run_id=$2",[hash('mutation'),result.run.id]),/immutable/);passed++;
 const next=[{...members[0],...input.changes[0],recoveryCohort:'unrepresented'},published(members[1],'successor'),original[2],original[3]];
 await scalar('select seed_tam_regrade_checkpoint_batch($1,$2,$3,$4)',['successor','codex',result.seed.seedToken,next]);
 const finalized=await scalar('select finalize_tam_regrade_checkpoint_seed($1,$2,$3)',['successor','codex',result.seed.seedToken]);
 assert.equal(finalized.status,'complete');assert.equal(finalized.counts.published,1);assert.equal(finalized.counts.hold,1);assert.equal(finalized.counts.pending,2);passed++;
 assert.deepEqual(await scalar("select grade_provenance->'jevCompletion' from tam_regrade_records where run_id=$1 and netsuite_internal_id='2'",[result.run.id]),before[1].grade_provenance.jevCompletion);passed++;
 assert.equal(await scalar("select has_function_privilege('service_role','tam_initialize_changed_successor(jsonb)','EXECUTE')"),true);
 assert.equal(await scalar("select has_function_privilege('anon','tam_initialize_changed_successor(jsonb)','EXECUTE')"),false);
 assert.equal(await scalar("select has_function_privilege('authenticated','tam_initialize_changed_successor(jsonb)','EXECUTE')"),false);passed++;
 console.log(JSON.stringify({passed,scope:'real canonical seed lifecycle, exact predecessor hashes, changed receipt/PDF identity, atomic rollback, idempotence, frozen evidence, inherited hold/final and service-only grants'}));
} finally {await db.close();}
