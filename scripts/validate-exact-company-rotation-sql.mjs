// Actual PostgreSQL behavior in an isolated PGlite database; no live connection.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const require = createRequire(process.env.STANLEY_PGLITE_PACKAGE ?? new URL('../../stanley-jev-intelligence-20260918/work/intelligence-sql-test/package.json',import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create('memory://');
const scheduled = await readFile(new URL('../supabase/migrations/0108_intelligence_coverage_priority.sql',import.meta.url),'utf8');
const migration = await readFile(new URL('../supabase/migrations/0145_exact_company_source_rotation.sql',import.meta.url),'utf8');
const scalar = async (sql,values=[]) => (await db.query(sql,values)).rows[0]?.value;
const checks=[];
const test=async(name,fn)=>{try{await fn();checks.push(name);}catch(e){e.message=`${name}: ${e.message}`;throw e;}};
const cutoff=async()=>scalar("select (clock_timestamp()-interval '1 day')::text value");
const reserve=async(source,ids,{limit=ids.length,epoch,scope=null}={})=>(await db.query(
  'select * from reserve_company_rotation($1::text,$2::integer,$3::timestamptz,$4::text,$5::uuid[])',
  [source,limit,epoch??await cutoff(),scope,ids])).rows;
const reset=()=>db.exec("truncate companies,intelligence_source_state,intelligence_observations,intelligence_jobs; update intelligence_config set enabled=true");
async function company(overrides={}) {
  const row={id:randomUUID(),name:'Offline fixture',lists:['netsuite_tam'],status:'new',tal_claimed:false,
    domain:'fixture.invalid',website_raw:null,netsuite_internal_id:'123',state:'CO',subindustry:'Trucking',...overrides};
  const keys=Object.keys(row);
  await db.query(`insert into companies(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
  return row.id;
}
async function state(id,source,overrides={}) {
  const row={company_id:id,source_key:source,complete:false,last_error:null,next_attempt_at:null,last_success_at:null,cursor:{},...overrides};
  const keys=Object.keys(row);
  await db.query(`insert into intelligence_source_state(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table intelligence_config(id int primary key,enabled boolean); insert into intelligence_config values(1,true);
    create table companies(id uuid primary key,name text,lists text[],status text,tal_claimed boolean,domain text,website_raw text,netsuite_internal_id text,
      state text,subindustry text,ats_type text,ats_token text,is_base boolean,claimable boolean,last_checked_at timestamptz,ats_checked_at timestamptz,
      site_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,signals_checked_at timestamptz);
    create table intelligence_source_state(company_id uuid,source_key text,next_attempt_at timestamptz,complete boolean,last_error text,last_success_at timestamptz,cursor jsonb,primary key(company_id,source_key));
    create table intelligence_observations(id uuid primary key,company_id uuid,is_current boolean,feedback_excluded boolean,attributes jsonb);
    create table intelligence_jobs(id uuid primary key,observation_id uuid,kind text,status text,priority int,due_at timestamptz,attempts int,lease_token uuid,lease_until timestamptz,last_error text,result jsonb,created_at timestamptz);`);
  await db.exec(scheduled);
  const original=await scalar("select pg_get_functiondef('reserve_company_rotation(text,integer,timestamptz,text)'::regprocedure) value");
  const originalWorker=await scalar("select pg_get_functiondef('intelligence_claim(integer)'::regprocedure) value");
  await test('migration applies twice without changing the scheduled function, paid worker, configuration or tables',async()=>{
    const config=await scalar('select to_jsonb(c) value from intelligence_config c');
    const tables=await scalar("select array_agg(tablename order by tablename) value from pg_tables where schemaname='public'");
    await db.exec(migration); await db.exec(migration);
    assert.equal(await scalar("select pg_get_functiondef('reserve_company_rotation(text,integer,timestamptz,text)'::regprocedure) value"),original);
    assert.equal(await scalar("select pg_get_functiondef('intelligence_claim(integer)'::regprocedure) value"),originalWorker);
    assert.deepEqual(await scalar('select to_jsonb(c) value from intelligence_config c'),config);
    assert.deepEqual(await scalar("select array_agg(tablename order by tablename) value from pg_tables where schemaname='public'"),tables);
  });
  await test('only service_role can execute the security-definer overload',async()=>{
    const sig='reserve_company_rotation(text,integer,timestamptz,text,uuid[])';
    for(const role of ['anon','authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\') value',[role,sig]),false);
    assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\') value',['service_role',sig]),true);
    const p=(await db.query('select prosecdef,proconfig,pronargdefaults from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
    assert.equal(p.prosecdef,true);assert.equal(p.pronargdefaults,0);assert.deepEqual(p.proconfig,['search_path=public, pg_temp']);
    await assert.rejects(db.exec(`set role anon; select * from ${sig.slice(0,sig.indexOf('('))}('trigger',1,now()-interval '1 day',null,array['00000000-0000-0000-0000-000000000001']::uuid[])`),/permission denied/);
    await db.exec('reset role');
  });
  await test('invalid exact scopes fail before any company reservation',async()=>{
    await reset();const id=await company();
    for(const args of [
      ['trigger',null,{limit:1}],['trigger',[],{limit:1}],['trigger',[id,id],{}],['trigger',[null],{}],
      ['trigger',Array.from({length:101},randomUUID),{}],['trigger',[id],{limit:0}],['trigger',[id],{limit:2}],
      ['trigger',[id],{epoch:'infinity'}],['trigger',[id],{epoch:'-infinity'}],['trigger',[id],{epoch:'2999-01-01'}],
      ['signals',[id],{}],['site',[id],{scope:'tail'}],['site',[id],{}],['sos',[id],{}],['trigger',[id],{scope:'CO'}]
    ]) await assert.rejects(reserve(...args));
    await assert.rejects(db.query("select * from reserve_company_rotation('trigger',1,null,null,$1::uuid[])",[[id]]));
    await assert.rejects(db.query("select * from reserve_company_rotation('trigger',1,now()-interval '1 day',null,$1::uuid[])",[[[id]]]));
    assert.equal(await scalar('select last_checked_at value from companies where id=$1',[id]),null);
  });
  await test('exact TAM and retained claimed TAL union excludes duplicates, removed non-TAL and outside IDs',async()=>{
    await reset();const tam=await company(),tal=await company({lists:['tam_removed'],status:'removed_from_tam',tal_claimed:true});
    const duplicate=await company({lists:['netsuite_tam','tam_duplicate'],tal_claimed:true});
    const removed=await company({status:'removed_from_tam'}),outside=await company({lists:[]}),unrequested=await company();
    const rows=await reserve('trigger',[tam,tal,duplicate,removed,outside,randomUUID()]);
    assert.deepEqual(new Set(rows.map(r=>r.id)),new Set([tam,tal]));
    for(const id of [duplicate,removed,outside,unrequested]) assert.equal(await scalar('select last_checked_at value from companies where id=$1',[id]),null);
    assert.equal((await reserve('trigger',[tam,tal])).length,0);
    assert.equal((await reserve('trigger',[randomUUID()])).length,0);
  });
  await test('bounded calls continue only untouched requested rows and do not fall back after exhaustion',async()=>{
    await reset();const ids=await Promise.all([company(),company(),company()]);await company();const epoch=await cutoff();
    const returned=[];for(let i=0;i<4;i++)returned.push(...await reserve('trigger',ids,{limit:1,epoch}));
    assert.equal(returned.length,3);assert.equal(new Set(returned.map(r=>r.id)).size,3);
    assert.equal(await scalar('select count(*)::int value from companies where last_checked_at is null'),1);
  });
  await test('immutable run cutoff and current UTC-hour fence both prevent a repeat attempt',async()=>{
    await reset();const old=await company({last_checked_at:'2000-01-01'});
    const sinceRun=await company({last_checked_at:await scalar("select (clock_timestamp()-interval '12 hours')::text value")});
    assert.deepEqual((await reserve('trigger',[old,sinceRun])).map(r=>r.id),[old]);
    const thisHour=await company({last_checked_at:await scalar("select (date_trunc('hour',clock_timestamp() at time zone 'UTC') at time zone 'UTC')::text value")});
    assert.equal((await reserve('trigger',[thisHour],{epoch:await scalar('select clock_timestamp()::text value')})).length,0);
    await db.exec("set timezone='America/Los_Angeles'");
    assert.equal((await reserve('trigger',[thisHour],{epoch:await scalar('select clock_timestamp()::text value')})).length,0);
    await db.exec("set timezone='UTC'");
  });
  await test('each source stamps only its existing source column without changing membership or status',async()=>{
    for(const [source,col,scope] of [['trigger','last_checked_at',null],['ats','ats_checked_at',null],['site','site_checked_at','claimable'],['fmcsa','fmcsa_checked_at',null],['sos','sos_checked_at','CO']]){
      await reset();const id=await company({tal_claimed:true,lists:['tam_removed'],status:'removed_from_tam'});
      const before=await scalar('select to_jsonb(c) value from companies c where id=$1',[id]);
      const [after]=await reserve(source,[id],{scope});assert.ok(after[col]);
      const persisted=await scalar('select to_jsonb(c) value from companies c where id=$1',[id]);
      assert.deepEqual({...persisted,[col]:null},before);
    }
  });
  await test('website/ATS applicability retains domains and includes canonical TAL lacking TAM Internal IDs',async()=>{
    for(const source of ['ats','site']){
      await reset();const valid=await company({domain:null,website_raw:'https://fixture.invalid'});
      const missing=await company({domain:' ',website_raw:null});
      const badTamId=await company({netsuite_internal_id:'invalid'});
      const tal=await company({lists:[],status:'removed_from_tam',tal_claimed:true,netsuite_internal_id:null});
      const rows=await reserve(source,[valid,missing,badTamId,tal],{scope:source==='site'?'claimable':null});
      assert.deepEqual(new Set(rows.map(r=>r.id)),new Set(source==='site'?[valid,tal]:[valid,badTamId,tal]));
    }
  });
  await test('ATS and website preserve adaptive failure backoff and successful revisit intervals',async()=>{
    for(const source of ['ats','site']){
      await reset();const key=source==='site'?'website':'ats:discovery',scope=source==='site'?'claimable':null;
      const future=await scalar("select (clock_timestamp()+interval '1 day')::text value");
      const recent=await scalar("select (clock_timestamp()-interval '2 hours')::text value");
      const backoff=await company(),revisit=await company(),partial=await company(),error=await company(),malformed=await company();
      await state(backoff,key,{next_attempt_at:future});
      for(const [id,patch] of [[revisit,{}],[partial,{complete:false}],[error,{last_error:'source failure'}],[malformed,{cursor:{revisit:{version:'unknown',intervalHours:24}}}]])
        await state(id,key,{complete:true,last_success_at:recent,cursor:{revisit:{version:1,intervalHours:24}},...patch});
      assert.deepEqual(new Set((await reserve(source,[backoff,revisit,partial,error,malformed],{scope})).map(r=>r.id)),new Set([partial,error,malformed]));
      await db.exec('update intelligence_config set enabled=false');
      assert.deepEqual(new Set((await reserve(source,[backoff,revisit],{scope})).map(r=>r.id)),new Set([backoff,revisit]));
    }
  });
  await test('ATS provider-specific backoff and the ten-minute cross-hour guard remain binding',async()=>{
    await reset();const id=await company({ats_type:'greenhouse',ats_token:'fixture'});
    await state(id,'ats:greenhouse:fixture',{next_attempt_at:await scalar("select (clock_timestamp()+interval '1 day')::text value")});
    assert.equal((await reserve('ats',[id])).length,0);
    for(const source of ['ats','site']){
      const col=source==='ats'?'ats_checked_at':'site_checked_at';
      const justChecked=await company({[col]:await scalar("select (clock_timestamp()-interval '5 minutes')::text value")});
      assert.equal((await reserve(source,[justChecked],{epoch:await scalar('select clock_timestamp()::text value'),scope:source==='site'?'claimable':null})).length,0);
    }
  });
  await test('FMCSA sector and SOS state applicability do not expand to unqualified accounts',async()=>{
    await reset();const trucking=await company(),law=await company({subindustry:'Legal Services'}),ut=await company({state:'UT'});
    assert.deepEqual(new Set((await reserve('fmcsa',[trucking,law,ut])).map(r=>r.id)),new Set([trucking,ut]));
    assert.deepEqual(new Set((await reserve('sos',[trucking,law,ut],{scope:'CO'})).map(r=>r.id)),new Set([trucking,law]));
    assert.equal((await reserve('sos',[ut],{scope:'CO'})).length,0);
  });
  await test('scheduled four-argument behavior remains callable and its counters remain isolated',async()=>{
    await reset();const tam=await company(),tal=await company({lists:[],tal_claimed:true});
    const config=await scalar('select to_jsonb(c) value from intelligence_config c');
    await reserve('trigger',[tal]);
    assert.deepEqual(await scalar('select to_jsonb(c) value from intelligence_config c'),config);
    const rows=(await db.query("select * from reserve_company_rotation('trigger',1,now()-interval '1 day',null)")).rows;
    assert.deepEqual(rows.map(r=>r.id),[tam]);
    assert.equal(await scalar("select pg_get_functiondef('reserve_company_rotation(text,integer,timestamptz,text)'::regprocedure) value"),original);
  });
  await test('actual query plan locks selected company rows; source code retains SKIP LOCKED',async()=>{
    const dynamic=migration.match(/format\(\$query\$([\s\S]*?)\$query\$,checked_column\)/)?.[1];assert.ok(dynamic);
    assert.match(dynamic,/for update of c skip locked/i);
    const sql=dynamic.replaceAll('%1$I','last_checked_at').replaceAll('%%','%');
    const plan=await db.query('explain (format json) '+sql,[[randomUUID()],await cutoff(),1,'trigger',null,true]);
    assert.match(JSON.stringify(plan.rows),/LockRows/);
  });
  console.log(JSON.stringify({ok:true,groups:checks.length,checks,limitation:'PGlite is a single session. Sequential fencing and the actual LockRows query plan are tested; simultaneous live sessions are not simulated.'},null,2));
} finally { await db.close(); }
