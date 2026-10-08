/* eslint-disable @typescript-eslint/no-explicit-any */
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const dbRef=vi.hoisted(()=>({db:null as any,trace:[] as any[]}));
vi.mock('@/lib/supabase/server',()=>({serviceClient:()=>({from:(table:string)=>{
 let columns='*', filters: Array<[string,unknown,string]>=[],single=false,limit=1000,insert:any,update:any;
 const q:any={select:(v:string)=>{columns=v;return q;},eq:(k:string,v:unknown)=>{filters.push([k,v,'=']);return q;},gt:(k:string,v:unknown)=>{filters.push([k,v,'>']);return q;},insert:(v:any)=>{insert=v;return q;},update:(v:any)=>{update=v;return q;},limit:(v:number)=>{limit=v;return q;},maybeSingle:()=>{single=true;return q;},then:async(resolve:any,reject:any)=>{
 try{let sql:string,values:any[]=[];
 if(insert){const keys=Object.keys(insert);values=keys.map(k=>typeof insert[k]==='object'&&insert[k]!==null?JSON.stringify(insert[k]):insert[k]);sql=`insert into ${table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`;}
 else {
 if(update){const keys=Object.keys(update);values=keys.map(k=>typeof update[k]==='object'&&update[k]!==null?JSON.stringify(update[k]):update[k]);sql=`update ${table} set ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')}`;}
 else if(table==='company_government_matches')sql='select government_entity_id from company_government_matches';else sql=`select ${columns} from ${table}`;
 const offset=values.length;sql+=' where '+filters.map(([k,,op],i)=>`"${k}"${op}$${offset+i+1}`).join(' and ');values.push(...filters.map(([,v])=>v));sql+=update?` returning ${columns}`:` limit ${limit}`;
 }
 const result=await dbRef.db.query(sql,values);dbRef.trace.push({table,columns,insert:Boolean(insert),update:Boolean(update),rowCount:result.rows.length});
 const rows=JSON.parse(JSON.stringify(result.rows));return resolve({data:single?rows[0]??null:rows,error:null});
 }catch(e){dbRef.trace.push({table,error:String(e),code:(e as any).code,constraint:(e as any).constraint,column:(e as any).column});return resolve({data:null,error:{message:String(e),code:(e as any).code}});}}};return q;
 },rpc:async(name:string,args:any)=>{dbRef.trace.push({rpc:name});if(name==='company_identity_source_context')return {data:{},error:null};if(['acquire_public_growth_sweep_lease','fail_public_growth_sweep_lease'].includes(name)){const keys=Object.keys(args);const r=await dbRef.db.query(`select ${name}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) value`,Object.values(args));return {data:JSON.parse(JSON.stringify(r.rows[0].value)),error:null};}throw Error('No writes '+name);}}),withServiceDeadline:(_d:number,fn:any)=>fn()}));
vi.mock('./http',async original=>({...await original<any>(),fetchJson:()=>{throw Error('PROVIDER FORBIDDEN');}}));
import {reconcileFederalPendingSource,continueFederalPendingSources,federalPendingRecoverySchema,federalPendingSourceSchema} from './federalDiscoveryPending';
import {parseFederalDiscoveryContinuation} from './federalDiscoveryState';
import {federalSourceOnlyHash} from './federalDiscoverySourceOnly';
import {captureFederalPendingSource} from './federalDiscoverySourceOnly';
// Exact public capture fixture; private CRM enrichment is deliberately omitted.
const fixture = {
  "source": {
    "observations": [
      {
        "id": "dfffb638-5c44-472f-b0b6-cac340530ef0",
        "title": "USAspending search evidence for Optimize Now Technologies",
        "metadata": {
          "sourceOnly": true,
          "operationId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
          "sourceStage": "search",
          "requestSha256": "c1243ac35ad4efcfe72083cca6217383da08724da4624b517b1d315532b1a030",
          "sourceRequest": {
            "url": "https://api.usaspending.gov/api/v2/search/spending_by_award/",
            "body": {
              "page": 1,
              "sort": "Start Date",
              "limit": 100,
              "order": "desc",
              "fields": [
                "Award ID",
                "Recipient Name",
                "Recipient UEI",
                "Start Date"
              ],
              "filters": {
                "time_period": [
                  {
                    "end_date": "2026-09-29",
                    "start_date": "2007-10-01"
                  }
                ],
                "award_type_codes": [
                  "IDV_A",
                  "IDV_B",
                  "IDV_B_A",
                  "IDV_B_B",
                  "IDV_B_C",
                  "IDV_C",
                  "IDV_D",
                  "IDV_E"
                ],
                "recipient_search_text": [
                  "Optimize Now Technologies"
                ]
              }
            },
            "method": "POST"
          },
          "continuationBefore": {
            "page": 1,
            "targets": [
              {
                "query": "Optimize Now Technologies",
                "identity": null
              }
            ],
            "version": 1,
            "candidate": null,
            "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
            "collection": "idvs",
            "searchAfter": null,
            "targetIndex": 0,
            "lastPageHash": null,
            "searchEndDate": "2026-09-29",
            "companyIdentity": "af44c3c4861e415ad643f38ad895588bdfddd9d0d19b20111632c868eb3c85dc"
          },
          "retainedJsonSha256": "fc757405485bafe627208795a5010df673f1db91aef27d86e0699fc9879b142a",
          "fullResponseCaptured": true,
          "governmentJsonCaptureVersion": 1
        },
        "sections": [
          {
            "id": "s1",
            "end": 482,
            "text": "{\"spending_level\":\"awards\",\"limit\":100,\"results\":[],\"page_metadata\":{\"page\":1,\"hasNext\":false,\"last_record_unique_id\":null,\"last_record_sort_value\":\"None\"},\"messages\":[\"For searches, time period start and end dates are currently limited to an earliest date of 2007-10-01.  For data going back to 2000-10-01, use either the Custom Award Download feature on the website or one of our download or bulk_download API endpoints as listed on https://api.usaspending.gov/docs/endpoints. \"]}",
            "start": 0
          }
        ],
        "company_id": "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "event_date": null,
        "is_current": true,
        "source_key": "66b77c52cbe91eec136e963894ead8a2d016b18646349cb00ef126c02265ee49",
        "source_url": "https://api.usaspending.gov/api/v2/search/spending_by_award/",
        "observed_at": "2026-10-08T06:03:27.955+00:00",
        "source_kind": "government",
        "content_hash": "398fcd33733c8ef1d3d0c027c119fe6919a47810f619270565907f38253803ae",
        "last_seen_at": "2026-10-08T06:03:28.005976+00:00",
        "evidence_text": "{\"spending_level\":\"awards\",\"limit\":100,\"results\":[],\"page_metadata\":{\"page\":1,\"hasNext\":false,\"last_record_unique_id\":null,\"last_record_sort_value\":\"None\"},\"messages\":[\"For searches, time period start and end dates are currently limited to an earliest date of 2007-10-01.  For data going back to 2000-10-01, use either the Custom Award Download feature on the website or one of our download or bulk_download API endpoints as listed on https://api.usaspending.gov/docs/endpoints. \"]}",
        "feedback_excluded": false
      }
    ],
    "jobs": [
      {
        "id": "db64a7e3-2607-4cc2-a0ae-8119fab094b7",
        "kind": "interpret",
        "due_at": "2026-10-08T06:03:28.005976+00:00",
        "status": "queued",
        "attempts": 0,
        "created_at": "2026-10-08T06:03:28.005976+00:00",
        "last_error": null,
        "finished_at": null,
        "lease_until": null,
        "operation_key": "interpret:dfffb638-5c44-472f-b0b6-cac340530ef0:evidence-v2",
        "observation_id": "dfffb638-5c44-472f-b0b6-cac340530ef0",
        "codex_news_request_id": null
      }
    ]
  },
  "company": {
    "payload": {
      "company": {
        "id": "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "name": "Optimize Now Technologies",
        "domain": "optimizenow.com",
        "website_raw": "http://www.optimizenow.com",
        "city": null,
        "state": "CO",
        "netsuite_internal_id": "201584266",
        "status": "new",
        "lists": [
          "netsuite_tam"
        ],
        "tal_claimed": false
      }
    }
  },
  "request": {
    "operationId": "63ecbfa3-d967-4936-acf6-31549a80eb01",
    "originalRequest": {
      "operationId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
      "holdOperationId": "4a173495-2b1d-41d4-966d-cba64832fcc9",
      "sourceOnly": true,
      "continuations": [
        {
          "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
          "expectedSha256": "70af63a1ffbc568f7ee1869390a01cedef2e8b683d041307bc44e6d32ec7f452"
        },
        {
          "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
          "expectedSha256": "c42a329dd366fcf1f47cf15cb9bbf6bd576fb7b4c5fde801451c3900c1d5cb3d"
        },
        {
          "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
          "expectedSha256": "e5c25473f3391ae43dee4851911ceca7afcf985ed726fb47b6dc57635d67426b"
        },
        {
          "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
          "expectedSha256": "bd4c5d7f902d7f327ba03d7acc89941a939e69eab97f59275be387b6161031e5"
        }
      ]
    },
    "expectedCursorSha256": "6cbf4a3c31022c9ef6fc476300716b3949964bb4bad5bd11f9e482f1035be13b",
    "retainedSource": {
      "observationId": "dfffb638-5c44-472f-b0b6-cac340530ef0",
      "jobId": "db64a7e3-2607-4cc2-a0ae-8119fab094b7",
      "sourceKey": "66b77c52cbe91eec136e963894ead8a2d016b18646349cb00ef126c02265ee49",
      "requestSha256": "c1243ac35ad4efcfe72083cca6217383da08724da4624b517b1d315532b1a030",
      "retainedJsonSha256": "fc757405485bafe627208795a5010df673f1db91aef27d86e0699fc9879b142a"
    },
    "incidentProof": {
      "kind": "first_job_read_missing_company_column_before_serial_checkpoint",
      "deployedCommit": "d4cb26f96eb37ab3c2d5e199629b0974809a88de",
      "readerTaskId": "/root/coverage_audit",
      "reviewerTaskId": "/root",
      "evidenceSha256": "dff987ed4cc2f86d991b527d0df9782a8b07075f27c68eb005f673410aae7146",
      "reviewSha256": "8ad91f74f57c27b1b5e481c374b2e6d8d8886e94a5eb2f27a54f4caf4d322804",
      "historicalSourceRequests": 1,
      "remainingSourceRequests": 0
    }
  },
  "pending": {
    "source": "federal-discovery",
    "readOnly": true,
    "cursorSha256": "6cbf4a3c31022c9ef6fc476300716b3949964bb4bad5bd11f9e482f1035be13b",
    "capacityHold": {
      "heldAt": "2026-10-08T05:46:26.607Z",
      "reason": "reviewed_journal_capacity_recovery_requires_manual_resume",
      "status": "held",
      "version": 1,
      "journalId": "51964458-e1b5-4e9e-a1bc-f4952edfc9b0",
      "companyIds": [
        "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "5cb653c0-93c5-483a-a63d-4266c264a77b",
        "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
        "5cbdb11f-d241-46e8-a3da-92f213378498"
      ],
      "operationId": "4a173495-2b1d-41d4-966d-cba64832fcc9",
      "readerTaskId": "/root/coverage_audit",
      "evidenceSha256": "21cc908b0e48b9cea6ac32ccb895a40cfe3398a3ad9be78b8d2e314b2d12ab0f",
      "reviewerTaskId": "/root"
    },
    "leaseUntil": null,
    "inFlight": [
      "5cb49e88-b779-467a-aa28-cb704eb4b808",
      "5cb653c0-93c5-483a-a63d-4266c264a77b",
      "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
      "5cbdb11f-d241-46e8-a3da-92f213378498"
    ],
    "sourceOnlyOperation": {
      "status": "in_flight",
      "eventId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
      "request": {
        "sourceOnly": true,
        "operationId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
        "continuations": [
          {
            "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
            "expectedSha256": "70af63a1ffbc568f7ee1869390a01cedef2e8b683d041307bc44e6d32ec7f452"
          },
          {
            "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
            "expectedSha256": "c42a329dd366fcf1f47cf15cb9bbf6bd576fb7b4c5fde801451c3900c1d5cb3d"
          },
          {
            "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
            "expectedSha256": "e5c25473f3391ae43dee4851911ceca7afcf985ed726fb47b6dc57635d67426b"
          },
          {
            "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
            "expectedSha256": "bd4c5d7f902d7f327ba03d7acc89941a939e69eab97f59275be387b6161031e5"
          }
        ],
        "holdOperationId": "4a173495-2b1d-41d4-966d-cba64832fcc9"
      },
      "version": 1
    },
    "items": [
      {
        "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "present": true,
        "expectedSha256": "70af63a1ffbc568f7ee1869390a01cedef2e8b683d041307bc44e6d32ec7f452",
        "continuation": {
          "page": 1,
          "targets": [
            {
              "query": "Optimize Now Technologies",
              "identity": null
            }
          ],
          "version": 1,
          "candidate": null,
          "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
          "collection": "idvs",
          "searchAfter": null,
          "targetIndex": 0,
          "lastPageHash": null,
          "searchEndDate": "2026-09-29",
          "companyIdentity": "af44c3c4861e415ad643f38ad895588bdfddd9d0d19b20111632c868eb3c85dc"
        }
      },
      {
        "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
        "present": true,
        "expectedSha256": "c42a329dd366fcf1f47cf15cb9bbf6bd576fb7b4c5fde801451c3900c1d5cb3d",
        "continuation": {
          "page": 1,
          "targets": [
            {
              "query": "LOOK AD ME studio",
              "identity": null
            }
          ],
          "version": 1,
          "candidate": null,
          "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
          "collection": "idvs",
          "searchAfter": null,
          "targetIndex": 0,
          "lastPageHash": null,
          "searchEndDate": "2026-09-29",
          "companyIdentity": "cbda708686f3e0d45e371532745eaa26c399b8d6e6bc9866a14c1c3d1ee4dc4b"
        }
      },
      {
        "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
        "present": true,
        "expectedSha256": "e5c25473f3391ae43dee4851911ceca7afcf985ed726fb47b6dc57635d67426b",
        "continuation": {
          "page": 1,
          "targets": [
            {
              "query": "Wesslake Consulting",
              "identity": null
            }
          ],
          "version": 1,
          "candidate": null,
          "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
          "collection": "idvs",
          "searchAfter": null,
          "targetIndex": 0,
          "lastPageHash": null,
          "searchEndDate": "2026-09-29",
          "companyIdentity": "25180d7846b660a36a511870523a2e5d931faac1ebf8471db1716fb5e13db40a"
        }
      },
      {
        "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
        "present": true,
        "expectedSha256": "bd4c5d7f902d7f327ba03d7acc89941a939e69eab97f59275be387b6161031e5",
        "continuation": {
          "page": 1,
          "targets": [
            {
              "query": "INACTIVE_BarthCalderon LLP",
              "identity": null
            }
          ],
          "version": 1,
          "candidate": null,
          "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
          "collection": "idvs",
          "searchAfter": null,
          "targetIndex": 0,
          "lastPageHash": null,
          "searchEndDate": "2026-09-29",
          "companyIdentity": "040ce11aaa02872597e70a8265fb72cea72805e905a9c705f9fcc6a563ca92ad"
        }
      }
    ],
    "analysisComplete": false,
    "historyComplete": false
  }
};
it('reconciles and captures retained originals end-to-end using real0014,0047,0059/0137 constraints and exact projections',async()=>{
 vi.stubEnv('STANLEY_INTELLIGENCE_ENABLED','true');
 const {PGlite}=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url))('@electric-sql/pglite');dbRef.db=await PGlite.create('memory://');
 const db=dbRef.db, sql=readFileSync(new URL('../../supabase/migrations/0059_intelligence_evidence_and_work.sql',import.meta.url),'utf8');
 try{
 await db.exec('create table companies(id uuid primary key,name text,domain text,website_raw text,city text,state text,netsuite_internal_id text,lists text[],status text,tal_claimed boolean);create table intelligence_views(id uuid primary key);create table company_government_matches(company_id uuid,government_entity_id uuid,match_status text);');
 for(const name of ['intelligence_observations','intelligence_jobs'])await db.exec(sql.match(new RegExp('create table public\\.'+name+' \\([\\s\\S]*?\\n\\);'))![0]);
 await db.exec('alter table intelligence_jobs add column codex_news_request_id uuid');
 const saved=fixture.source, o=saved.observations[0],j=saved.jobs[0];
 const company: Record<string,unknown>=fixture.company.payload.company;
 const req=structuredClone(fixture.request);
 for(const [table,row]of [['companies',Object.fromEntries(['id','name','domain','website_raw','city','state','netsuite_internal_id','lists','status','tal_claimed'].map(k=>[k,company[k]]))],['intelligence_observations',Object.fromEntries(Object.entries(o).filter(([k])=>k!=='feedback_excluded'))],['intelligence_jobs',j]] as any){
 const keys=Object.keys(row);await db.query(`insert into ${table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>typeof row[k]==='object'&&row[k]!==null&&!Array.isArray(row[k])?JSON.stringify(row[k]):Array.isArray(row[k])&&k!=='lists'?JSON.stringify(row[k]):row[k]));
 }
 let outcome:any,err:any;try{outcome=await captureFederalPendingSource(o.company_id,parseFederalDiscoveryContinuation(o.metadata.continuationBefore,o.company_id),req.originalRequest.operationId,Date.now()+60000,req.retainedSource);}catch(e){err={name:(e as Error).name,message:(e as Error).message,stack:(e as Error).stack};}

 expect(err).toBeUndefined();expect(outcome.sourceCaptured).toBe(true);

 const migration=(f:string)=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8');
 await db.exec(migration('0014_app_events.sql').match(/create table if not exists app_events \([\s\S]*?\n\);/)![0]);
 await db.exec(migration('0041_tam_public_growth.sql').match(/create table if not exists public_growth_sweep_state \([\s\S]*?\n\);/)![0]);
 const leases=migration('0047_public_growth_sweep_leases.sql');
 await db.exec(leases.match(/alter table public_growth_sweep_state[\s\S]*?;/)![0]);
 for(const name of ['acquire_public_growth_sweep_lease','fail_public_growth_sweep_lease'])await db.exec(leases.match(new RegExp('create or replace function '+name+'\\([\\s\\S]*?\\$\\$;'))![0]);
 const pending=fixture.pending;
 const cursor={offset:0,afterCompanyId:'00000000-0000-4000-8000-000000009999',discoveryAttemptsTotal:3636,discoveryInFlight:pending.inFlight,discoveryInFlightEventId:pending.sourceOnlyOperation.eventId,
 discoverySourceOnlyOperation:pending.sourceOnlyOperation,discoveryCapacityHold:pending.capacityHold,discoveryContinuations:Object.fromEntries(pending.items.map((x:any)=>[x.companyId,x.continuation])),preservedUnrelated:{testFixture:true},retryQueue:[],deadLetters:[]};
 for(let n=1;n<=997;n++){const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;cursor.discoveryContinuations[id]={...pending.items[0].continuation,companyId:id,unknownPreserved:{n}};}
 await db.query('insert into public_growth_sweep_state(source,cursor) values($1,$2)', ['federal-discovery',JSON.stringify(cursor)]);
 const localRequest=federalPendingRecoverySchema.parse({...req,expectedCursorSha256:federalSourceOnlyHash(cursor)});
 let controller:any,controllerError:any;try{controller=await reconcileFederalPendingSource(localRequest);}catch(e){controllerError={name:(e as Error).name,message:(e as Error).message};}
 const after=(await db.query("select cursor,lease_token,lease_until,last_error from public_growth_sweep_state where source='federal-discovery'")).rows[0];
 const eventCount=(await db.query('select count(*)::int n from app_events')).rows[0].n;
 expect(controllerError).toBeUndefined(); expect(controller).toMatchObject({sourceRequests:0,exactEventVerified:true,exactStateVerified:true});
 expect(eventCount).toBe(1); expect(after.lease_token).toBeNull();
 const recovered=(await db.query('select summary,meta from app_events where id=$1',[localRequest.operationId])).rows[0];
 expect(recovered.summary).toMatch(/Recovered one/); expect(recovered.meta.sourceRequests).toBe(0);
 for(const item of pending.items.slice(1))expect(after.cursor.discoveryContinuations[item.companyId]).toEqual(item.continuation);
 for(const id of Object.keys(cursor.discoveryContinuations).filter(id=>!pending.items.some(item=>item.companyId===id)))expect(after.cursor.discoveryContinuations[id]).toEqual(cursor.discoveryContinuations[id]);
 expect(after.cursor.discoveryContinuations[o.company_id].sourceCapture.status).toBe('held');
 const beforeReplay=dbRef.trace.length;
 expect((await reconcileFederalPendingSource(localRequest)).reusedReceipt).toBe(true);
 expect(dbRef.trace.slice(beforeReplay).some(x=>x.rpc==='acquire_public_growth_sweep_lease'||x.insert||x.update)).toBe(false);
 // Normal finite source-only completion uses the same actual event constraint
 // and exact projection. The retained original prevents all provider writes.
 const normalCursor={...cursor,discoveryInFlight:[],discoveryInFlightEventId:null};delete (normalCursor as any).discoverySourceOnlyOperation;
 await db.query("update public_growth_sweep_state set cursor=$1 where source='federal-discovery'",[JSON.stringify(normalCursor)]);
 const normalRequest=federalPendingSourceSchema.parse({...req.originalRequest,operationId:'00000000-0000-4000-8000-000000000099',continuations:[req.originalRequest.continuations[0]]});
 const normal=await continueFederalPendingSources(normalRequest);
 expect(normal).toMatchObject({sourceRequests:0,reusedCaptures:1,exactEventVerified:true,exactStateVerified:true});
 const captured=(await db.query('select summary from app_events where id=$1',[normalRequest.operationId])).rows[0];
 expect(captured.summary).toMatch(/Captured bounded/);
 expect((await db.query('select count(*)::int n from app_events')).rows[0].n).toBe(2);
 expect((await continueFederalPendingSources(normalRequest)).reusedReceipt).toBe(true);
 }finally{await db.close();vi.unstubAllEnvs();}
},20000);
