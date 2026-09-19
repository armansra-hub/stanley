-- Public event memory and budgeted account writing. No grade or CRM writes.
begin;

create table public.intelligence_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  event_type text not null,
  title text not null,
  title_tokens text[] not null,
  event_date timestamptz,
  primary_source_url text not null,
  trigger_id uuid references public.triggers(id),
  evidence_count integer not null default 0,
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index intelligence_events_account on public.intelligence_events(company_id,updated_at desc);
create table public.intelligence_event_observations (
  observation_id uuid primary key references public.intelligence_observations(id),
  event_id uuid not null references public.intelligence_events(id),
  attached_at timestamptz not null default now()
);
create index intelligence_event_members on public.intelligence_event_observations(event_id);
-- The finding's real source URL stays intact. A concurrent syndicated report
-- cannot publish a second trigger for the same durable account event.
create unique index triggers_jev_event_unique on public.triggers(company_id,((metadata->'jevFinding'->>'eventId')))
  where metadata->'jevFinding'->>'eventId' is not null;

create function public.intelligence_event_sources(p_event uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('observationId',o.id,'url',o.source_url,'title',o.title,
    'eventDate',o.event_date,'observedAt',o.observed_at,'excerpt',left(o.attributes->>'evidenceExcerpt',1200),
    'current',o.is_current,'excluded',o.feedback_excluded) order by o.observed_at), '[]'::jsonb)
  from intelligence_event_observations m join intelligence_observations o on o.id=m.observation_id
  where m.event_id=p_event
$$;

create function public.intelligence_event_refresh(p_event uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e intelligence_events%rowtype; sources jsonb;
begin
  select * into e from intelligence_events where id=p_event for update;
  if not found then return; end if;
  sources := intelligence_event_sources(e.id);
  update intelligence_events set evidence_count=(select count(distinct value->>'url') from jsonb_array_elements(sources)
    where not (value->>'excluded')::boolean),updated_at=now() where id=e.id;
  if e.trigger_id is not null then
    update triggers set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('intelligenceEvent',
      jsonb_build_object('id',e.id,'revision',e.revision,'sources',sources))
      where id=e.trigger_id and company_id=e.company_id;
  end if;
end $$;

create function public.intelligence_event_attach(p_observation uuid,p_attributes jsonb default null)
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
  kind := a->>'signalType';
  if not o.is_current or o.feedback_excluded or o.source_kind='government' or
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

create function public.intelligence_event_bind_trigger(p_event uuid,p_trigger uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e intelligence_events%rowtype;
begin
  select * into e from intelligence_events where id=p_event for update;
  if not found or not exists(select 1 from triggers where id=p_trigger and company_id=e.company_id)
    or (e.trigger_id is not null and e.trigger_id<>p_trigger) then return false; end if;
  update intelligence_events set trigger_id=p_trigger where id=e.id;
  perform intelligence_event_refresh(e.id);
  return true;
end $$;

create function public.intelligence_account_events(p_company uuid,p_limit integer default 30)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('sources',intelligence_event_sources(e.id)) order by e.updated_at desc),'[]'::jsonb)
  from (select * from intelligence_events where company_id=p_company order by updated_at desc limit greatest(1,least(p_limit,50))) e
$$;

create table public.intelligence_story_jobs (
  company_id uuid primary key references public.companies(id),
  desired_hash text not null,
  status text not null default 'queued' check(status in ('queued','running','complete','failed','superseded')),
  requested_at timestamptz not null default now(),
  due_at timestamptz not null default now(),
  force_requested boolean not null default false,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  checkpoint jsonb,
  finished_at timestamptz
);
create index intelligence_story_jobs_due on public.intelligence_story_jobs(due_at) where status in ('queued','running');
create table public.intelligence_account_stories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  evidence_hash text not null,
  writer_version text not null,
  model text not null,
  story jsonb not null,
  observation_ids uuid[] not null,
  coverage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(company_id,evidence_hash,writer_version)
);
create index intelligence_account_story_history on public.intelligence_account_stories(company_id,created_at desc);

create function public.intelligence_story_enqueue(p_company uuid,p_hash text,p_force boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if length(p_hash)<>64 then raise exception 'invalid_evidence_hash'; end if;
  if not exists(select 1 from companies where id=p_company and status<>'removed_from_tam') then return false; end if;
  if exists(select 1 from intelligence_account_stories where company_id=p_company and evidence_hash=p_hash) then
    insert into intelligence_story_jobs(company_id,desired_hash,status,finished_at) values(p_company,p_hash,'complete',now())
    on conflict(company_id) do update set desired_hash=p_hash,status='complete',finished_at=now(),last_error=null,
      lease_token=null,lease_until=null,checkpoint=null;
    return false;
  end if;
  insert into intelligence_story_jobs(company_id,desired_hash,force_requested) values(p_company,p_hash,p_force)
  on conflict(company_id) do update set desired_hash=excluded.desired_hash,status='queued',due_at=now(),
    requested_at=now(),force_requested=intelligence_story_jobs.force_requested or excluded.force_requested,
    lease_token=null,lease_until=null,attempts=0,last_error=null,checkpoint=null,finished_at=null
  where intelligence_story_jobs.desired_hash<>excluded.desired_hash
     or (excluded.force_requested and intelligence_story_jobs.status in ('failed','superseded'));
  return found;
end $$;

create function public.intelligence_story_claim(p_limit integer default 1)
returns setof public.intelligence_story_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  return query with picked as (
    select j.company_id from intelligence_story_jobs j join companies c on c.id=j.company_id
    where c.status<>'removed_from_tam' and j.due_at<=now()
      and (j.status='queued' or (j.status='running' and j.lease_until<now()))
    order by j.force_requested desc,j.due_at,j.requested_at limit greatest(1,least(p_limit,3)) for update of j skip locked
  ) update intelligence_story_jobs j set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',
      attempts=j.attempts+1 from picked where j.company_id=picked.company_id returning j.*;
end $$;

create function public.intelligence_story_finish(p_company uuid,p_lease uuid,p_hash text,p_status text,
  p_error text default null,p_retry_seconds integer default 60,p_story jsonb default null,
  p_observation_ids uuid[] default '{}',p_coverage jsonb default '{}',p_model text default null,p_writer_version text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j intelligence_story_jobs%rowtype;
begin
  select * into j from intelligence_story_jobs where company_id=p_company for update;
  if not found or j.lease_token is distinct from p_lease or j.status<>'running' or j.lease_until<=now() or j.desired_hash<>p_hash then return false; end if;
  if p_status not in ('complete','queued','failed','superseded') then raise exception 'invalid_story_status'; end if;
  if p_status='complete' then
    if p_story is null or p_model is null or p_writer_version is null or cardinality(p_observation_ids)=0 then raise exception 'missing_story'; end if;
    if exists(select 1 from unnest(p_observation_ids) s where not exists(select 1 from intelligence_observations o where o.id=s and o.company_id=p_company and not o.feedback_excluded)) then raise exception 'story_source_mismatch'; end if;
    insert into intelligence_account_stories(company_id,evidence_hash,writer_version,model,story,observation_ids,coverage)
      values(p_company,p_hash,p_writer_version,p_model,p_story,p_observation_ids,p_coverage)
      on conflict(company_id,evidence_hash,writer_version) do nothing;
  end if;
  update intelligence_story_jobs set status=p_status,last_error=left(p_error,200),lease_token=null,lease_until=null,
    due_at=case when p_status='queued' then now()+make_interval(secs=>greatest(1,p_retry_seconds)) else due_at end,
    finished_at=case when p_status in ('complete','superseded') then now() else null end,
    checkpoint=case when p_status='complete' then null else checkpoint end where company_id=p_company;
  return true;
end $$;

-- Feedback stays reversible. Preserve historical versions and Jev's answers;
-- source lists reflect the correction, and the next story request rebuilds.
create function public.intelligence_event_observation_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare event_id uuid;
begin
  select m.event_id into event_id from intelligence_event_observations m where m.observation_id=new.id;
  if event_id is not null then perform intelligence_event_refresh(event_id); end if;
  -- This transactionally dirty queue is the recovery path if the HTTP worker
  -- disappears immediately after saving Jev's result. The writer computes the
  -- material hash before any paid call. A zero hash is only a wakeup marker.
  if new.attributes is not null then
    insert into intelligence_story_jobs(company_id,desired_hash) values(new.company_id,repeat('0',64))
    on conflict(company_id) do update set desired_hash=repeat('0',64),status='queued',due_at=now(),
      requested_at=now(),lease_token=null,lease_until=null,last_error=null,checkpoint=null,attempts=0;
  end if;
  return new;
end $$;
create trigger intelligence_event_source_changed after update of feedback_excluded,is_current,attributes on public.intelligence_observations
  for each row execute function public.intelligence_event_observation_changed();

insert into public.intelligence_story_jobs(company_id,desired_hash)
  select distinct company_id,repeat('0',64) from public.intelligence_observations
  where is_current and not feedback_excluded and attributes is not null
    and attributes->>'companyRelationship'='direct' and (attributes->>'companyRelevance')::numeric>=.8;

create function public.intelligence_event_backfill(p_limit integer default 50)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare observation uuid; processed integer:=0;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return 0; end if;
  for observation in select o.id from intelligence_observations o where o.is_current and not o.feedback_excluded
    and o.source_kind<>'government' and o.attributes->>'companyRelationship'='direct'
    and (o.attributes->>'companyRelevance')::numeric>=.8 and (o.attributes->>'concreteEvent')::numeric>=.75
    and o.attributes->>'signalType' not in ('none','news')
    and not exists(select 1 from intelligence_event_observations m where m.observation_id=o.id)
    order by o.observed_at limit greatest(1,least(p_limit,100))
  loop perform intelligence_event_attach(observation); processed:=processed+1; end loop;
  return processed;
end $$;

do $$ declare t text; f record; begin
  foreach t in array array['intelligence_events','intelligence_event_observations','intelligence_story_jobs','intelligence_account_stories'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in (
    'intelligence_event_sources','intelligence_event_refresh','intelligence_event_attach','intelligence_event_bind_trigger',
    'intelligence_account_events','intelligence_story_enqueue','intelligence_story_claim','intelligence_story_finish','intelligence_event_observation_changed','intelligence_event_backfill') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
