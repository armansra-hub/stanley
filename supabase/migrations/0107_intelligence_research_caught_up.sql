-- A completed sweep sleeps until its next existing discovery/revisit deadline.
-- This is not a claim that every business question has a positive answer.
begin;
alter table public.intelligence_directed_research_jobs
  add column caught_up_at timestamptz,
  add column wake_reason text not null default 'existing_work',
  add column context_revision bigint not null default 0;
alter table public.intelligence_research_attempts
  add column refresh_generation integer not null default 0,
  add column claimed_generation integer not null default 0;
alter table public.intelligence_config add column directed_claim_turn bigint not null default 0;
create index intelligence_directed_research_completed_due
  on public.intelligence_directed_research_jobs(due_at) where status='complete';

create function public.intelligence_research_discovery_context(p_metadata jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select coalesce(p_metadata,'{}'::jsonb)-array['discoveredAt','researchPurpose','query','queryHash'];
$$;

create or replace function public.intelligence_directed_refresh(p_company uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare fingerprint text; company_context jsonb; evidence text; links text; discoveries text;
begin
  perform pg_advisory_xact_lock(hashtextextended('directed-research:'||p_company::text,0));
  select jsonb_build_array(name,domain,website_raw,subindustry,ns_industry,city,state,
      coalesce((select context_revision from intelligence_directed_research_jobs where company_id=p_company),0))
    into company_context from companies where id=p_company and status is distinct from 'removed_from_tam'
      and lists @> array['netsuite_tam']::text[] and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$';
  if not found then return false; end if;
  -- No positive-topic or existing-evidence gate: uncovered accounts can discover
  -- outside sources even when their website is unavailable or missing.
  select coalesce(string_agg(source_key||':'||content_hash||':'||cached_operating_topics::text,','
    order by source_key,content_hash),'') into evidence from intelligence_observations
    where company_id=p_company and is_current and not feedback_excluded and attributes is not null;
  -- Cursor order and movement from pending to verified are progress, not new
  -- evidence. Preserve the entire known URL set without those clock changes.
  select coalesce(string_agg(url,',' order by url),'') into links from (
    select distinct value #>> '{}' url from intelligence_source_state s
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.cursor->'knownUrls')='array' then s.cursor->'knownUrls' else '[]'::jsonb end ||
        case when jsonb_typeof(s.cursor->'pendingUrls')='array' then s.cursor->'pendingUrls' else '[]'::jsonb end ||
        case when jsonb_typeof(s.cursor->'verifiedUrls')='array' then s.cursor->'verifiedUrls' else '[]'::jsonb end) item(value)
      where s.company_id=p_company and s.source_key='website' and jsonb_typeof(value)='string'
  ) urls;
  select coalesce(string_agg(source_url||':'||title||':'||intelligence_research_discovery_context(metadata)::text,','
    order by source_url),'') into discoveries from intelligence_research_sources where company_id=p_company;
  fingerprint:=md5('research-caught-up-v1:'||company_context::text||evidence||links||discoveries);
  insert into intelligence_directed_research_jobs(company_id,desired_hash,wake_reason)
    values(p_company,fingerprint,'first_pass')
  on conflict(company_id) do update set desired_hash=excluded.desired_hash,
    status=case when intelligence_directed_research_jobs.status='running' and intelligence_directed_research_jobs.lease_until>now() then 'running' else 'queued' end,
    requested_at=now(),due_at=now(),wake_reason='evidence_or_source_change',
    lease_token=case when intelligence_directed_research_jobs.status='running' and intelligence_directed_research_jobs.lease_until>now() then intelligence_directed_research_jobs.lease_token end,
    lease_until=case when intelligence_directed_research_jobs.status='running' and intelligence_directed_research_jobs.lease_until>now() then intelligence_directed_research_jobs.lease_until end,
    attempts=case when intelligence_directed_research_jobs.status='running' and intelligence_directed_research_jobs.lease_until>now() then intelligence_directed_research_jobs.attempts else 0 end,
    last_error=null,finished_at=null
    where intelligence_directed_research_jobs.desired_hash<>excluded.desired_hash
      or intelligence_directed_research_jobs.status='superseded';
  return found;
end $$;

create or replace function public.intelligence_directed_observation_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.attributes is not null then perform intelligence_directed_refresh(new.company_id); end if;
  elsif new.attributes is distinct from old.attributes or new.is_current is distinct from old.is_current
    or new.feedback_excluded is distinct from old.feedback_excluded then
    perform intelligence_directed_refresh(new.company_id);
  end if;
  return new;
end $$;

create function public.intelligence_directed_discovery_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    perform intelligence_directed_refresh(new.company_id);
  elsif new.source_url is distinct from old.source_url or new.title is distinct from old.title
    or intelligence_research_discovery_context(new.metadata) is distinct from intelligence_research_discovery_context(old.metadata) then
    perform pg_advisory_xact_lock(hashtextextended('directed-research:'||new.company_id::text,0));
    -- A changed discovered headline/identity context makes this URL due again.
    -- The existing URL lease remains authoritative if a worker is reading it.
    update intelligence_research_attempts set next_attempt_at=least(next_attempt_at,now()),refresh_generation=refresh_generation+1
      where company_id=new.company_id and source_url=new.source_url;
    perform intelligence_directed_refresh(new.company_id);
  end if;
  return new;
end $$;
create trigger intelligence_directed_discovery after insert or update of source_url,title,metadata
  on public.intelligence_research_sources for each row execute function public.intelligence_directed_discovery_changed();

create function public.intelligence_directed_company_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare previously_eligible boolean:=false; context_changed boolean:=false;
begin
  if not coalesce(new.status is distinct from 'removed_from_tam' and new.lists @> array['netsuite_tam']::text[]
    and not ('tam_duplicate'=any(coalesce(new.lists,'{}'::text[]))) and new.netsuite_internal_id ~ '^[0-9]+$',false) then
    return new;
  end if;
  if tg_op='UPDATE' then
    previously_eligible:=coalesce(old.status is distinct from 'removed_from_tam' and old.lists @> array['netsuite_tam']::text[]
      and not ('tam_duplicate'=any(coalesce(old.lists,'{}'::text[]))) and old.netsuite_internal_id ~ '^[0-9]+$',false);
    context_changed:=row(new.name,new.domain,new.website_raw,new.subindustry,new.ns_industry,new.city,new.state)
      is distinct from row(old.name,old.domain,old.website_raw,old.subindustry,old.ns_industry,old.city,old.state);
  end if;
  if context_changed then
    -- Establish the same queue row first, then advance only a real identity /
    -- territory-context revision. Capture clocks and no-op writes never do this.
    perform intelligence_directed_refresh(new.id);
    update intelligence_directed_research_jobs set context_revision=context_revision+1 where company_id=new.id;
    update intelligence_research_attempts set next_attempt_at=least(next_attempt_at,now()),refresh_generation=refresh_generation+1
      where company_id=new.id;
    perform intelligence_directed_refresh(new.id);
  elsif not previously_eligible then
    -- New or restored membership enters discovery even without a website.
    perform intelligence_directed_refresh(new.id);
    update intelligence_directed_research_jobs set
      status=case when status='running' and lease_until>now() then 'running' else 'queued' end,
      due_at=now(),finished_at=null,
      lease_token=case when status='running' and lease_until>now() then lease_token end,
      lease_until=case when status='running' and lease_until>now() then lease_until end
      where company_id=new.id;
    if tg_op='UPDATE' then
      update intelligence_research_attempts set next_attempt_at=least(next_attempt_at,now()),refresh_generation=refresh_generation+1
        where company_id=new.id;
    end if;
  end if;
  return new;
end $$;
create trigger intelligence_directed_company after insert or update of name,domain,website_raw,subindustry,ns_industry,city,state,lists,status,netsuite_internal_id
  on public.companies for each row execute function public.intelligence_directed_company_changed();

create or replace function public.intelligence_research_claim(p_company uuid,p_urls text[]) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return '[]'::jsonb; end if;
  if p_urls is null or cardinality(p_urls)>100 or array_position(p_urls,null) is not null
    or exists(select 1 from unnest(p_urls) u where length(u)>2048 or u!~'^https?://') then
    raise exception 'Invalid verified research URLs'; end if;
  insert into intelligence_research_attempts(company_id,source_url)
    select p_company,url from unnest(p_urls) url on conflict do nothing;
  with chosen as (
    select company_id,source_url from intelligence_research_attempts
    where company_id=p_company and source_url=any(p_urls) and next_attempt_at<=now()
      and (lease_until is null or lease_until<now())
    order by array_position(p_urls,source_url) for update skip locked limit 3
  ), claimed as (
    update intelligence_research_attempts a set last_attempt_at=now(),lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',
      claimed_generation=a.refresh_generation
    from chosen c where a.company_id=c.company_id and a.source_url=c.source_url
    returning a.source_url,a.lease_token
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into v_result from claimed;
  return v_result;
end $$;

create or replace function public.intelligence_research_finish(p_company uuid,p_url text,p_lease uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_outcome not in ('queued','unchanged','source_failed','source_empty') or p_outcome is null then
    raise exception 'Invalid research outcome'; end if;
  update intelligence_research_attempts set outcome=p_outcome,lease_token=null,lease_until=null,
    last_success_at=case when p_outcome in ('queued','unchanged') then now() else last_success_at end,
    -- A source/context change arriving after this claim survives the old read's
    -- completion. Its current lease is still the only reader until this point.
    next_attempt_at=case when refresh_generation<>claimed_generation then now()
      else now()+case when p_outcome in ('queued','unchanged') then interval '7 days' else interval '1 day' end end
    where company_id=p_company and source_url=p_url and lease_token=p_lease and lease_until>now();
  return found;
end $$;

create or replace function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare lane bigint;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  update intelligence_config set directed_claim_turn=(directed_claim_turn+1)%3 where id=1 returning directed_claim_turn into lane;
  return query with picked as (
    select j.company_id from intelligence_directed_research_jobs j join companies c on c.id=j.company_id
    where c.status is distinct from 'removed_from_tam' and c.lists @> array['netsuite_tam']::text[]
      and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
      and j.due_at<=now() and (j.status in ('queued','complete') or (j.status='running' and j.lease_until<now()))
    order by case when lane=1 and not exists(select 1 from intelligence_observations o
      where o.company_id=j.company_id and o.is_current and not o.feedback_excluded and o.attributes is not null) then 0 else 1 end,
      j.due_at,j.requested_at,j.company_id limit greatest(1,least(p_limit,3)) for update of j skip locked
  ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '3 minutes',attempts=j.attempts+1,
    wake_reason=case when j.status='complete' then 'scheduled_discovery' else j.wake_reason end
    from picked where j.company_id=picked.company_id returning j.*;
end $$;

create or replace function public.intelligence_directed_finish(p_company uuid,p_lease uuid,p_hash text,p_status text,
  p_retry_seconds integer default 600,p_result jsonb default null,p_error text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare current_job intelligence_directed_research_jobs;
begin
  if p_status is null or p_status not in ('queued','complete','failed') then raise exception 'invalid_directed_status'; end if;
  select * into current_job from intelligence_directed_research_jobs where company_id=p_company
    and lease_token=p_lease and status='running' and lease_until>now() for update;
  if not found then return false; end if;
  if current_job.desired_hash is distinct from p_hash then
    -- A real change during the read must not be lost, or cancel a healthy reader.
    -- Acknowledge only this lease; the new desired work is immediately claimable.
    update intelligence_directed_research_jobs set status='queued',due_at=now(),lease_token=null,lease_until=null,
      attempts=0,last_error=null,finished_at=null where company_id=p_company;
    return false;
  end if;
  if p_status='complete' and coalesce(p_result->>'outcome','')<>'caught_up' then raise exception 'missing_caught_up_receipt'; end if;
  update intelligence_directed_research_jobs set status=p_status,lease_token=null,lease_until=null,
    last_error=left(p_error,200),result=coalesce(p_result,result),attempts=case when p_error is null then 0 else attempts end,
    due_at=case when p_status in ('queued','complete') then now()+make_interval(secs=>greatest(60,least(coalesce(p_retry_seconds,600),14*86400))) else due_at end,
    caught_up_at=case when p_status='complete' then now() else caught_up_at end,
    finished_at=case when p_status in ('complete','failed') then now() else null end where company_id=p_company;
  return true;
end $$;

-- Existing work and active leases remain untouched. Uncovered accounts join the
-- same queue for outside discovery, without creating interpretation backfills.
do $$ declare account uuid; begin
  for account in select c.id from companies c where c.lists @> array['netsuite_tam']::text[]
    and c.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
    and c.netsuite_internal_id ~ '^[0-9]+$' and not exists(select 1 from intelligence_directed_research_jobs j where j.company_id=c.id)
  loop perform intelligence_directed_refresh(account); end loop;
end $$;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in (
    'intelligence_research_discovery_context','intelligence_directed_refresh','intelligence_directed_observation_changed',
    'intelligence_directed_discovery_changed','intelligence_directed_company_changed','intelligence_directed_claim','intelligence_directed_finish',
    'intelligence_research_claim','intelligence_research_finish') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
