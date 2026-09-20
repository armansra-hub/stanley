-- External research, account-wide saved questions and semantic event identity.
-- All model work is budgeted through exact-request Jev receipts; no existing
-- native finding is rewritten or sent to a second approval model.
begin;
alter table public.intelligence_research_sources add column if not exists metadata jsonb not null default '{}'::jsonb;
create table public.intelligence_external_research_queries(
  company_id uuid not null references companies(id),query_hash text not null check(query_hash ~ '^[a-f0-9]{64}$'),
  query text not null check(length(query) between 1 and 900),purpose text not null check(purpose in ('operating_gaps','event_followup','identity_company_family')),
  next_attempt_at timestamptz not null default now(),last_attempt_at timestamptz,lease_token uuid,lease_until timestamptz,
  last_outcome text,source_count integer not null default 0,primary key(company_id,query_hash)
);
create function public.intelligence_external_research_claim(p_company uuid,p_queries jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare q jsonb;r intelligence_external_research_queries%rowtype;claimed jsonb:='[]';
begin
 if not coalesce((select enabled from intelligence_config where id=1),false) then return claimed;end if;
 if jsonb_typeof(p_queries)<>'array' or jsonb_array_length(p_queries)>6 then raise exception 'invalid_research_queries';end if;
 perform pg_advisory_xact_lock(hashtextextended('external-research:'||p_company::text,0));
 for q in select value from jsonb_array_elements(p_queries) loop
  if jsonb_array_length(claimed)>=2 then exit;end if;
  insert into intelligence_external_research_queries(company_id,query_hash,query,purpose)
    values(p_company,q->>'queryHash',q->>'query',q->>'purpose') on conflict do nothing;
  update intelligence_external_research_queries set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',last_attempt_at=now()
    where company_id=p_company and query_hash=q->>'queryHash' and query=q->>'query' and purpose=q->>'purpose'
      and next_attempt_at<=now() and (lease_until is null or lease_until<now()) returning * into r;
  if found then claimed:=claimed||jsonb_build_array(jsonb_build_object('query',r.query,'purpose',r.purpose,'queryHash',r.query_hash,'lease_token',r.lease_token));end if;
 end loop;return claimed;
end $$;
create function public.intelligence_external_research_finish(p_company uuid,p_hash text,p_lease uuid,p_outcome text,p_count integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_outcome not in ('success','empty','unavailable') or p_count not between 0 and 6 then raise exception 'invalid_research_receipt';end if;
 update intelligence_external_research_queries set last_outcome=p_outcome,source_count=p_count,lease_token=null,lease_until=null,
   next_attempt_at=now()+case when p_outcome='unavailable' then interval '1 day' when p_outcome='empty' then interval '3 days'
    when purpose='identity_company_family' then interval '14 days' else interval '7 days' end
 where company_id=p_company and query_hash=p_hash and lease_token=p_lease and lease_until>now();return found;
end $$;
alter table public.intelligence_external_research_queries enable row level security;
revoke all on public.intelligence_external_research_queries from anon,authenticated;
grant all on public.intelligence_external_research_queries to service_role;
revoke all on function public.intelligence_external_research_claim(uuid,jsonb),public.intelligence_external_research_finish(uuid,text,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.intelligence_external_research_claim(uuid,jsonb),public.intelligence_external_research_finish(uuid,text,uuid,text,integer) to service_role;
-- Completed profile-topic work can now investigate outside sources/identity;
-- recurring jobs then retain their existing bounded account scheduler.
update intelligence_directed_research_jobs set status='queued',due_at=now(),attempts=0,finished_at=null
 where status='complete';

create or replace function public.intelligence_event_attach(p_observation uuid,p_attributes jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o intelligence_observations%rowtype; a jsonb; e intelligence_events%rowtype;
  tokens text[]; company_tokens text[]; kind text; exact_id uuid;
begin
  select * into o from intelligence_observations where id=p_observation;
  if not found then raise exception 'observation_missing'; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-event:'||o.company_id::text,0));
  select event_id into exact_id from intelligence_event_observations where observation_id=o.id;
  if exact_id is not null then
    perform intelligence_event_refresh(exact_id);
    select * into e from intelligence_events where id=exact_id;
    return to_jsonb(e);
  end if;
  a := coalesce(p_attributes,o.attributes);
  kind := coalesce(a->>'eventRoutingType',a->>'signalType');
  if not o.is_current or o.feedback_excluded or coalesce(o.metadata->>'structuredAward','false')='true' or
     coalesce(a->>'companyRelationship','unknown')<>'direct' or coalesce((a->>'companyRelevance')::numeric,0)<.8 or
     coalesce((a->>'concreteEvent')::numeric,0)<.75 or kind is null or kind in ('none','news') then return null; end if;
  select regexp_split_to_array(lower(name),'[^a-z0-9]+') into company_tokens from companies where id=o.company_id;
  select coalesce(array_agg(distinct token order by token),'{}'::text[]) into tokens
    from regexp_split_to_table(lower(o.title),'[^a-z0-9]+') token
    where length(token)>2 and not token=any(company_tokens)
      and token not in ('the','and','for','with','from','into','its','has','have','that','this','new','announces','announced','inc','llc','ltd','corp','company');
  -- Same URL is a source revision. Cross-URL grouping requires a dated event,
  -- an exact >=3-word signature, or >=4 discriminating headline words and
  -- 80% overlap of the larger headline.
  -- This deliberately keeps differently named events distinct; no model review.
  select c.* into e from intelligence_events c where c.company_id=o.company_id and c.event_type=kind
    and ((c.primary_source_url=o.source_url and (
      (o.event_date is null and c.event_date is null and c.title_tokens=tokens)
      or (o.event_date is not null and c.event_date is not null and abs(extract(epoch from c.event_date-o.event_date))<=3*86400))) or (
      o.event_date is not null and c.event_date is not null and abs(extract(epoch from c.event_date-o.event_date))<=3*86400
      and ((cardinality(tokens)>=3 and c.title_tokens=tokens) or
        (cardinality(tokens)>=4 and cardinality(c.title_tokens)>=4
          and (select count(*) from unnest(tokens) t where t=any(c.title_tokens))::numeric/
            greatest(cardinality(tokens),cardinality(c.title_tokens))>=.8))))
    order by (c.primary_source_url=o.source_url) desc,c.created_at asc limit 1 for update;
  if not found then
    insert into intelligence_events(company_id,event_type,title,title_tokens,event_date,primary_source_url)
      values(o.company_id,kind,o.title,tokens,o.event_date,o.source_url) returning * into e;
  end if;
  insert into intelligence_event_observations(observation_id,event_id) values(o.id,e.id);
  update intelligence_events set revision=revision+1 where id=e.id;
  perform intelligence_event_refresh(e.id);
  select * into e from intelligence_events where id=e.id;
  return to_jsonb(e);
end $$;

-- A short application lease serializes semantic reconciliation without holding
-- a database transaction open during the provider request.
create table public.intelligence_event_reconcile_leases (
 company_id uuid primary key references public.companies(id), lease_token uuid, lease_until timestamptz
);
create table public.intelligence_event_reconciliations (
 observation_id uuid primary key references public.intelligence_observations(id),
 company_id uuid not null references public.companies(id), event_id uuid references public.intelligence_events(id),
 snapshot jsonb not null, native_result jsonb, completed_at timestamptz, created_at timestamptz not null default now()
);
create function public.intelligence_event_reconcile_claim(p_observation uuid,p_attributes jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o intelligence_observations%rowtype; e intelligence_events%rowtype;
 r intelligence_event_reconciliations%rowtype; token uuid; candidates jsonb; payload jsonb;
begin
 select * into o from intelligence_observations where id=p_observation;
 if not found then raise exception 'observation_missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended('intelligence-event:'||o.company_id::text,0));
 select * into r from intelligence_event_reconciliations where observation_id=o.id;
 if found and r.completed_at is not null then
  select * into e from intelligence_events where id=r.event_id;
  return jsonb_build_object('status','complete','event',case when e.id is null then null else to_jsonb(e) end);
 end if;
 insert into intelligence_event_reconcile_leases(company_id) values(o.company_id) on conflict do nothing;
 update intelligence_event_reconcile_leases set lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'
 where company_id=o.company_id and (lease_until is null or lease_until<now()) returning lease_token into token;
 if token is null then return jsonb_build_object('status','busy'); end if;
 if r.observation_id is null then
  payload:=intelligence_event_attach(o.id,p_attributes);
  if payload is null then
   update intelligence_event_reconcile_leases set lease_until=null,lease_token=null where company_id=o.company_id;
   return jsonb_build_object('status','complete','event',null);
  end if;
  select * into e from intelligence_events where id=(payload->>'id')::uuid;
  -- Exact URL/headline grouping already found an established event. The new
  -- semantic question is only useful for a newly attached singleton.
  if e.trigger_id is not null or (select count(*) from intelligence_event_observations where event_id=e.id)>1 then
   insert into intelligence_event_reconciliations(observation_id,company_id,event_id,snapshot,completed_at)
    values(o.id,o.company_id,e.id,'{}',now());
   update intelligence_event_reconcile_leases set lease_until=null,lease_token=null where company_id=o.company_id;
   return jsonb_build_object('status','complete','event',to_jsonb(e));
  end if;
  select coalesce(jsonb_agg(x.payload order by x.updated_at desc),'[]') into candidates from (
   select c.updated_at,jsonb_build_object('id',c.id,'type',c.event_type,'title',left(c.title,350),'date',c.event_date,
    'sources',(select coalesce(jsonb_agg(s.value),'[]') from (
      select jsonb_build_object('url',left(v.source_url,1200),'title',left(v.title,350),'date',v.event_date,
       'passage',left(coalesce(v.attributes->>'evidenceExcerpt',v.evidence_text),1800)) value
      from intelligence_event_observations m join intelligence_observations v on v.id=m.observation_id
      where m.event_id=c.id and v.is_current and not v.feedback_excluded order by v.observed_at desc limit 2) s)) payload
   from intelligence_events c where c.company_id=o.company_id and c.id<>e.id and c.event_type=e.event_type
    and c.event_date is not null and e.event_date is not null and abs(extract(epoch from c.event_date-e.event_date))<=7*86400
    and exists(select 1 from intelligence_event_observations m join intelligence_observations v on v.id=m.observation_id
      where m.event_id=c.id and v.is_current and not v.feedback_excluded)
   order by c.updated_at desc limit 6
  ) x;
  payload:=jsonb_build_object('company',(select name from companies where id=o.company_id),
   'incoming',jsonb_build_object('url',left(o.source_url,1200),'title',left(o.title,350),'date',e.event_date,
    'type',e.event_type,'passage',left(coalesce(p_attributes->>'evidenceExcerpt',o.evidence_text),2400)), 'candidates',candidates);
  insert into intelligence_event_reconciliations(observation_id,company_id,event_id,snapshot)
   values(o.id,o.company_id,e.id,payload) returning * into r;
 end if;
 return jsonb_build_object('status','claimed','lease_token',token,'snapshot',r.snapshot);
end $$;
create function public.intelligence_event_reconcile_finish(p_observation uuid,p_lease uuid,p_target uuid,p_native jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_event_reconciliations%rowtype; e intelligence_events%rowtype; target_id uuid;
begin
 select * into r from intelligence_event_reconciliations where observation_id=p_observation;
 if not found then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('intelligence-event:'||r.company_id::text,0));
 if not exists(select 1 from intelligence_event_reconcile_leases where company_id=r.company_id
   and lease_token=p_lease and lease_until>now()) then return null; end if;
 if r.completed_at is not null then return null; end if;
 target_id:=coalesce(p_target,r.event_id);
 if p_target is not null then
  if not exists(select 1 from jsonb_array_elements(r.snapshot->'candidates') c where c->>'id'=p_target::text)
   or not exists(select 1 from intelligence_events where id=p_target and company_id=r.company_id)
   or exists(select 1 from intelligence_events where id=r.event_id and trigger_id is not null)
   or (select count(*) from intelligence_event_observations where event_id=r.event_id)<>1 then
   raise exception 'invalid_event_merge';
  end if;
  update intelligence_event_observations set event_id=p_target where observation_id=p_observation and event_id=r.event_id;
  if not found then raise exception 'event_membership_changed'; end if;
  update intelligence_events set revision=revision+1 where id=p_target;
 end if;
 update intelligence_event_reconciliations set event_id=target_id,native_result=p_native,completed_at=now() where observation_id=p_observation;
 if p_target is not null then delete from intelligence_events where id=r.event_id; end if;
 perform intelligence_event_refresh(target_id);
 update intelligence_event_reconcile_leases set lease_token=null,lease_until=null where company_id=r.company_id and lease_token=p_lease;
 select * into e from intelligence_events where id=target_id;
 return jsonb_build_object('status','complete','event',to_jsonb(e));
end $$;
alter table public.intelligence_event_reconcile_leases enable row level security;
alter table public.intelligence_event_reconciliations enable row level security;
revoke all on public.intelligence_event_reconcile_leases,public.intelligence_event_reconciliations from anon,authenticated;
grant all on public.intelligence_event_reconcile_leases,public.intelligence_event_reconciliations to service_role;
revoke all on function public.intelligence_event_reconcile_claim(uuid,jsonb),public.intelligence_event_reconcile_finish(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_event_reconcile_claim(uuid,jsonb),public.intelligence_event_reconcile_finish(uuid,uuid,uuid,jsonb) to service_role;

-- Saved questions now combine an account's public sources. Legacy per-source
-- answers remain stored; new jobs are redirected before any generic evaluation.
create table public.intelligence_account_question_jobs (
 view_id uuid not null references public.intelligence_views(id), company_id uuid not null references public.companies(id),
 revision bigint not null default 1, running_revision bigint, status text not null default 'queued',
 due_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 checkpoint jsonb, last_error text, updated_at timestamptz not null default now(), primary key(view_id,company_id),
 check(status in ('queued','running','complete','failed'))
);
create table public.intelligence_account_question_matches (
 view_id uuid not null references public.intelligence_views(id), company_id uuid not null references public.companies(id),
 probability double precision not null check(probability between 0 and 1), result jsonb not null,
 evaluated_at timestamptz not null default now(), primary key(view_id,company_id)
);
create function public.intelligence_account_question_enqueue(p_view uuid,p_company uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into intelligence_account_question_jobs(view_id,company_id) values(p_view,p_company)
 on conflict(view_id,company_id) do update set revision=intelligence_account_question_jobs.revision+1,
  status=case when intelligence_account_question_jobs.status='running' and intelligence_account_question_jobs.lease_until>now() then 'running' else 'queued' end,
  due_at=now(),updated_at=now();
end $$;
create function public.intelligence_account_question_observation_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v record;
begin
 if tg_op='UPDATE' and new.feedback_excluded and not old.feedback_excluded then
  delete from intelligence_account_question_matches where company_id=new.company_id;
 end if;
 for v in select id from intelligence_views where active loop perform intelligence_account_question_enqueue(v.id,new.company_id); end loop;
 return new;
end $$;
create trigger intelligence_account_question_observation_changed after insert or update of is_current,feedback_excluded on public.intelligence_observations
 for each row execute function public.intelligence_account_question_observation_changed();
create function public.intelligence_account_question_redirect()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.kind='view' then
  perform intelligence_account_question_enqueue(new.view_id,(select company_id from intelligence_observations where id=new.observation_id));
  return null;
 end if;
 return new;
end $$;
create trigger intelligence_account_question_redirect before insert on public.intelligence_jobs
 for each row execute function public.intelligence_account_question_redirect();
insert into intelligence_account_question_jobs(view_id,company_id)
 select v.id,o.company_id from intelligence_views v cross join (select distinct company_id from intelligence_observations where is_current and not feedback_excluded) o
 join companies c on c.id=o.company_id and c.status<>'removed_from_tam' where v.active on conflict do nothing;
update intelligence_jobs set status='superseded',last_error='account_question_migration',finished_at=now()
 where kind='view' and status='queued';
create function public.intelligence_account_question_claim()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j intelligence_account_question_jobs%rowtype; payload jsonb;
begin
 if not coalesce((select enabled from intelligence_config where id=1),false) then return null; end if;
 select q.* into j from intelligence_account_question_jobs q join intelligence_views v on v.id=q.view_id
 join companies c on c.id=q.company_id where v.active and c.status<>'removed_from_tam' and q.due_at<=now()
 and (q.status='queued' or (q.status='running' and q.lease_until<now())) order by q.due_at,q.updated_at
 limit 1 for update of q skip locked;
 if not found then return null; end if;
 update intelligence_account_question_jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',
 running_revision=case when checkpoint is null then revision else running_revision end where view_id=j.view_id and company_id=j.company_id returning * into j;
 payload:=to_jsonb(j)||jsonb_build_object('question',(select question from intelligence_views where id=j.view_id),
 'company',(select name from companies where id=j.company_id));
 if j.checkpoint is null then
 payload:=payload||jsonb_build_object('source_ids',(select coalesce(jsonb_agg(id order by id),'[]') from intelligence_observations
   where company_id=j.company_id and is_current and not feedback_excluded));
 end if;
 return payload;
end $$;
create function public.intelligence_account_question_finish(p_view uuid,p_company uuid,p_lease uuid,p_result jsonb default null,p_error text default null,p_retry integer default 30)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j intelligence_account_question_jobs%rowtype;
begin
 select * into j from intelligence_account_question_jobs where view_id=p_view and company_id=p_company for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_result is not null and exists(select 1 from jsonb_array_elements(p_result->'citations') citation
  where not exists(select 1 from intelligence_observations o where o.id=(citation->>'observationId')::uuid
   and o.company_id=p_company and not o.feedback_excluded)) then
  -- Explicit source corrections invalidate a stale in-flight answer atomically.
  update intelligence_account_question_jobs set checkpoint=null,revision=revision+1 where view_id=p_view and company_id=p_company;
  p_result:=null;p_error:='source_excluded';
 end if;
 if p_result is not null then
  insert into intelligence_account_question_matches(view_id,company_id,probability,result)
   values(p_view,p_company,(p_result->>'probability')::double precision,p_result)
   on conflict(view_id,company_id) do update set probability=excluded.probability,result=excluded.result,evaluated_at=now();
 end if;
 update intelligence_account_question_jobs set status=case when p_result is not null and revision=running_revision then 'complete' else 'queued' end,
  checkpoint=case when p_result is not null then null else checkpoint end,
  lease_token=null,lease_until=null,last_error=p_error,due_at=now()+make_interval(secs=>greatest(15,least(p_retry,2678400))),updated_at=now()
 where view_id=p_view and company_id=p_company;
 return true;
end $$;
alter table public.intelligence_account_question_jobs enable row level security;
alter table public.intelligence_account_question_matches enable row level security;
revoke all on public.intelligence_account_question_jobs,public.intelligence_account_question_matches from anon,authenticated;
grant all on public.intelligence_account_question_jobs,public.intelligence_account_question_matches to service_role;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'intelligence_account_question_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
