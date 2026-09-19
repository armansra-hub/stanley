-- Account-level wakeups only. Per-source ownership remains exclusively in
-- intelligence_research_attempts and its existing claim/finish RPCs.
begin;
create table public.intelligence_directed_research_jobs (
  company_id uuid primary key references public.companies(id),
  desired_hash text not null,
  status text not null default 'queued' check(status in ('queued','running','complete','failed','superseded')),
  requested_at timestamptz not null default now(), due_at timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz, attempts integer not null default 0,
  last_error text, result jsonb, finished_at timestamptz
);
create index intelligence_directed_research_due on public.intelligence_directed_research_jobs(due_at)
  where status in ('queued','running');
alter table public.intelligence_directed_research_jobs enable row level security;
revoke all on public.intelligence_directed_research_jobs from public,anon,authenticated;
grant all on public.intelligence_directed_research_jobs to service_role;

create function public.intelligence_directed_refresh(p_company uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare fingerprint text; promising boolean; topic_count integer; links text;
begin
  perform pg_advisory_xact_lock(hashtextextended('directed-research:'||p_company::text,0));
  if not exists(select 1 from companies where id=p_company and status<>'removed_from_tam') then return false; end if;
  select coalesce(bool_or((attributes->>'requiresResearch')::numeric>=.5 and
      ((attributes->>'concreteEvent')::numeric>=.75 or (attributes->>'operationalComplexity')::numeric>=.33)),false),
    coalesce(string_agg(id::text||':'||content_hash||':'||cached_operating_topics::text||':'||
      coalesce(attributes->>'signalType','none'),',' order by id),'')
    into promising,fingerprint from intelligence_observations
    where company_id=p_company and is_current and not feedback_excluded
      and attributes->>'companyRelationship'='direct' and (attributes->>'companyRelevance')::numeric>=.8;
  select count(distinct topic) into topic_count from intelligence_observations o cross join lateral unnest(o.cached_operating_topics) topic
    where o.company_id=p_company and o.is_current and not o.feedback_excluded;
  promising := promising or topic_count>=2;
  if not promising or topic_count>=8 then
    update intelligence_directed_research_jobs set status='superseded',lease_token=null,lease_until=null,
      finished_at=now(),last_error=case when topic_count>=8 then 'topics_supported' else 'no_promising_gap' end
      where company_id=p_company and status in ('queued','running');
    return false;
  end if;
  select coalesce((cursor->'verifiedUrls')::text,'[]') into links from intelligence_source_state
    where company_id=p_company and source_key='website';
  fingerprint:=md5(fingerprint||coalesce(links,'[]'));
  insert into intelligence_directed_research_jobs(company_id,desired_hash) values(p_company,fingerprint)
  on conflict(company_id) do update set desired_hash=excluded.desired_hash,status='queued',requested_at=now(),due_at=now(),
    lease_token=null,lease_until=null,attempts=0,last_error=null,finished_at=null
    where intelligence_directed_research_jobs.desired_hash<>excluded.desired_hash
      or intelligence_directed_research_jobs.status='superseded';
  return found;
end $$;

create function public.intelligence_directed_observation_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.attributes is not null then perform intelligence_directed_refresh(new.company_id); end if;
  return new;
end $$;
create trigger intelligence_directed_observation after insert or update of attributes,is_current,feedback_excluded on public.intelligence_observations
  for each row execute function public.intelligence_directed_observation_changed();

create function public.intelligence_directed_source_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.source_key='website' then perform intelligence_directed_refresh(new.company_id); end if;
  return new;
end $$;
create trigger intelligence_directed_source after insert or update of cursor on public.intelligence_source_state
  for each row execute function public.intelligence_directed_source_changed();

create function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  return query with picked as (
    select j.company_id from intelligence_directed_research_jobs j join companies c on c.id=j.company_id
    where c.status<>'removed_from_tam' and j.due_at<=now()
      and (j.status='queued' or (j.status='running' and j.lease_until<now()))
    order by j.due_at,j.requested_at limit greatest(1,least(p_limit,3)) for update of j skip locked
  ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
      lease_until=now()+interval '3 minutes',attempts=j.attempts+1
    from picked where j.company_id=picked.company_id returning j.*;
end $$;

create function public.intelligence_directed_finish(p_company uuid,p_lease uuid,p_hash text,p_status text,
  p_retry_seconds integer default 600,p_result jsonb default null,p_error text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_status not in ('queued','complete','failed') then raise exception 'invalid_directed_status'; end if;
  update intelligence_directed_research_jobs set status=p_status,lease_token=null,lease_until=null,
    last_error=left(p_error,200),result=coalesce(p_result,result),
    attempts=case when p_error is null then 0 else attempts end,
    due_at=case when p_status='queued' then now()+make_interval(secs=>greatest(60,least(p_retry_seconds,7*86400))) else due_at end,
    finished_at=case when p_status in ('complete','failed') then now() else null end
    where company_id=p_company and lease_token=p_lease and desired_hash=p_hash and status='running' and lease_until>now();
  return found;
end $$;

do $$ declare account uuid; begin
  for account in select distinct company_id from intelligence_observations where is_current and not feedback_excluded and attributes is not null
  loop perform intelligence_directed_refresh(account); end loop;
end $$;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in (
    'intelligence_directed_refresh','intelligence_directed_observation_changed','intelligence_directed_source_changed',
    'intelligence_directed_claim','intelligence_directed_finish') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
