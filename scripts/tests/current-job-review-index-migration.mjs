/** Isolated query parity and index-use check; no provider or production access. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../work/intelligence-sql-test/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create('memory://');
const migration = await readFile(new URL('../../supabase/migrations/0154_current_job_review_index.sql', import.meta.url), 'utf8');
const queries = [
  "select id,company_id,observed_at from intelligence_observations where is_current and source_kind='job' and observed_at<='2026-10-15' order by observed_at desc,id asc limit 257",
  "select id,company_id,observed_at from intelligence_observations where is_current and source_kind='job' and observed_at<='2026-10-15' and (observed_at<'2026-10-01 00:01:00Z' or (observed_at='2026-10-01 00:01:00Z' and id>'80000000-0000-0000-0000-000000000000')) order by observed_at desc,id asc limit 257",
  "select id,company_id,observed_at from intelligence_observations where is_current and source_kind='job' and observed_at<='2026-09-01' order by observed_at desc,id asc limit 257",
];
try {
  await db.exec(`create table intelligence_observations(id uuid primary key, company_id uuid not null, observed_at timestamptz not null, is_current boolean not null, source_kind text not null, evidence_text text not null);
    create index intelligence_observations_current on intelligence_observations(observed_at desc) where is_current;
    insert into intelligence_observations
      select md5('news-'||n)::uuid,md5('company-'||n)::uuid,'2026-10-14'::timestamptz+make_interval(secs=>n),true,'news',repeat('Retained original. ',20) from generate_series(1,6000) n;
    insert into intelligence_observations
      select md5('job-'||n)::uuid,md5('company-'||n)::uuid,'2026-10-01'::timestamptz+make_interval(secs=>n/3),n%7<>0,'job',repeat('Original job evidence. ',20) from generate_series(1,900) n;
    analyze intelligence_observations;`);
  const originals = (await db.query('select md5(string_agg(to_jsonb(o)::text, chr(10) order by id)) as digest from intelligence_observations o')).rows;
  const before = await Promise.all(queries.map(async q => (await db.query(q)).rows));
  // PGlite executes scripts inside a transaction; production runs the exact
  // concurrent statement on its own. Only that execution modifier differs here.
  assert.match(migration, /create index concurrently intelligence_current_job_review/);
  await db.exec(migration.replace('create index concurrently', 'create index'));
  await db.exec('vacuum analyze intelligence_observations');
  for (let i=0; i<queries.length; i++) assert.deepEqual((await db.query(queries[i])).rows, before[i]);
  assert.deepEqual((await db.query('select md5(string_agg(to_jsonb(o)::text, chr(10) order by id)) as digest from intelligence_observations o')).rows, originals);
  const plan = (await db.query('explain (analyze,format json) '+queries[0])).rows[0]['QUERY PLAN'];
  const nodes = [];
  const walk = v => { if (v && typeof v==='object') { if(v['Node Type']) nodes.push(v); Object.values(v).forEach(walk); } };
  walk(plan);
  assert.ok(nodes.some(n => n['Index Name']==='intelligence_current_job_review' && n['Actual Rows']===257));
  assert.ok(!nodes.some(n => n['Rows Removed by Filter']>0 || n['Node Type'].includes('Sort')));
  console.log(JSON.stringify({passed:true,queryParityChecks:queries.length,originalRowsUnchanged:true,returned:before[0].length,index:'intelligence_current_job_review',unrelatedRowsFiltered:0}));
} finally { await db.close(); }
