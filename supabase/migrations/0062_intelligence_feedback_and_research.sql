-- Reversible public-evidence corrections and bounded feedback priorities.
-- No qualifications, membership, contacts or private CRM fields are written.
begin;

alter table public.intelligence_observations
  add column feedback_excluded boolean not null default false,
  add column public_priority_weight numeric not null default 1 check(public_priority_weight between .9 and 1.1);

create function public.intelligence_sync_feedback() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_company uuid; v_observation uuid;
begin
  if tg_op='UPDATE' and (new.company_id<>old.company_id or new.observation_id<>old.observation_id) then
    raise exception 'Feedback identity cannot change';
  end if;
  if tg_op='DELETE' then v_company:=old.company_id; v_observation:=old.observation_id;
  else v_company:=new.company_id; v_observation:=new.observation_id; end if;
  if not exists(select 1 from intelligence_observations where id=v_observation and company_id=v_company) then
    raise exception 'Feedback must refer to the exact observation company';
  end if;
  -- Match the finisher's job-before-observation lock order. Cancel unfinished
  -- work atomically with exclusion so a later Undo cannot lose a skip/finish race.
  perform id from intelligence_jobs where observation_id=v_observation order by id for update;
  update intelligence_observations set
    feedback_excluded=case when tg_op='DELETE' then false else new.reason in ('wrong_company','irrelevant') end,
    public_priority_weight=case when tg_op='DELETE' then 1 when new.reason='useful' then 1.1
      when new.reason in ('not_now','old_event') then .9 else 1 end
    where id=v_observation and company_id=v_company;
  if tg_op<>'DELETE' and new.reason in ('wrong_company','irrelevant') then
    update intelligence_jobs set status='superseded',lease_token=null,lease_until=null,finished_at=now(),last_error='feedback_excluded'
      where observation_id=v_observation and status in ('queued','running');
  else
    update intelligence_jobs j set status='queued',due_at=now(),attempts=0,lease_token=null,lease_until=null,finished_at=null,last_error=null
      where j.observation_id=v_observation and j.status='superseded' and j.last_error='feedback_excluded'
        and exists(select 1 from intelligence_observations o where o.id=v_observation and o.is_current)
        and (j.kind='interpret' or exists(select 1 from intelligence_views v where v.id=j.view_id and v.active));
  end if;
  -- Only this exact Jev observation is affected; quarantine and all other
  -- provenance remain intact, including independently collected triggers.
  update triggers set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('intelligenceFeedbackExcluded',
    case when tg_op='DELETE' then false else new.reason in ('wrong_company','irrelevant') end)
    where company_id=v_company and (metadata#>>'{intelligenceEvidence,observationId}'=v_observation::text
      or metadata#>>'{jevFinding,observationId}'=v_observation::text);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger intelligence_feedback_sync after insert or update or delete on public.intelligence_feedback
  for each row execute function public.intelligence_sync_feedback();
update public.intelligence_feedback set updated_at=updated_at;

create function public.intelligence_bind_trigger_feedback() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row record; v_excluded boolean:=false; v_ids text[];
begin
  v_ids:=array[new.metadata#>>'{intelligenceEvidence,observationId}',new.metadata#>>'{jevFinding,observationId}'];
  if v_ids[1] is null and v_ids[2] is null then return new; end if;
  -- A shared observation lock serializes a new/upserted publication with an
  -- observation correction. The feedback updater subsequently sees the insert.
  for v_row in select id,feedback_excluded from intelligence_observations
    where company_id=new.company_id and id::text=any(v_ids) order by id for share
  loop v_excluded:=v_excluded or v_row.feedback_excluded; end loop;
  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('intelligenceFeedbackExcluded',v_excluded);
  return new;
end $$;
create trigger intelligence_trigger_feedback before insert on public.triggers
  for each row execute function public.intelligence_bind_trigger_feedback();

create function public.intelligence_public_feedback_weight(p_company uuid) returns numeric
language sql stable security definer set search_path=public,pg_temp as $$
  select case when coalesce((select enabled from intelligence_config where id=1),false)
    then 1+coalesce(sum(o.public_priority_weight-1),0)/(count(*)+4) else 1 end
  from intelligence_feedback f join intelligence_observations o on o.id=f.observation_id and o.company_id=f.company_id
  where f.company_id=p_company and o.is_current and not o.feedback_excluded
    and f.updated_at>now()-interval '90 days' and f.reason in ('useful','not_now','old_event');
$$;

create function public.intelligence_source_feedback_weights() returns table(source_id text,weight numeric)
language sql stable security definer set search_path=public,pg_temp as $$
  select o.metadata->>'sharedSourceId',
    1+sum(case when f.reason='useful' then .1 when f.reason in ('wrong_company','irrelevant','old_event','not_now') then -.1 else 0 end)/(count(*)+4)
  from intelligence_feedback f join intelligence_observations o on o.id=f.observation_id and o.company_id=f.company_id
  where coalesce((select enabled from intelligence_config where id=1),false)
    and o.is_current and f.updated_at>now()-interval '90 days' and o.metadata->>'sharedSourceId' is not null
  group by o.metadata->>'sharedSourceId';
$$;

create table public.intelligence_research_attempts (
  company_id uuid not null references public.companies(id), source_url text not null check(length(source_url)<=2048),
  last_attempt_at timestamptz, last_success_at timestamptz, next_attempt_at timestamptz not null default now(),
  outcome text check(outcome in ('queued','unchanged','source_failed','source_empty')),
  lease_token uuid, lease_until timestamptz, primary key(company_id,source_url)
);
alter table public.intelligence_research_attempts enable row level security;
revoke all on public.intelligence_research_attempts from public,anon,authenticated;
grant all on public.intelligence_research_attempts to service_role;

create function public.intelligence_research_claim(p_company uuid,p_urls text[]) returns jsonb
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
    update intelligence_research_attempts a set last_attempt_at=now(),lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    from chosen c where a.company_id=c.company_id and a.source_url=c.source_url
    returning a.source_url,a.lease_token
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into v_result from claimed;
  return v_result;
end $$;

create function public.intelligence_research_finish(p_company uuid,p_url text,p_lease uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_outcome not in ('queued','unchanged','source_failed','source_empty') or p_outcome is null then
    raise exception 'Invalid research outcome'; end if;
  update intelligence_research_attempts set outcome=p_outcome,lease_token=null,lease_until=null,
    last_success_at=case when p_outcome in ('queued','unchanged') then now() else last_success_at end,
    next_attempt_at=now()+case when p_outcome in ('queued','unchanged') then interval '7 days' else interval '1 day' end
    where company_id=p_company and source_url=p_url and lease_token=p_lease and lease_until>now();
  return found;
end $$;

revoke all on function public.intelligence_sync_feedback() from public,anon,authenticated;
revoke all on function public.intelligence_bind_trigger_feedback() from public,anon,authenticated;
revoke all on function public.intelligence_public_feedback_weight(uuid) from public,anon,authenticated;
revoke all on function public.intelligence_source_feedback_weights() from public,anon,authenticated;
revoke all on function public.intelligence_research_claim(uuid,text[]) from public,anon,authenticated;
revoke all on function public.intelligence_research_finish(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.intelligence_public_feedback_weight(uuid) to service_role;
grant execute on function public.intelligence_source_feedback_weights() to service_role;
grant execute on function public.intelligence_research_claim(uuid,text[]) to service_role;
grant execute on function public.intelligence_research_finish(uuid,text,uuid,text) to service_role;

-- Topic-search replacement follows: exclusion is applied before matching, count
-- and pagination, rather than dropping cards after a falsely complete result.
create or replace function public.intelligence_topic_search(p_topics text[],p_after uuid default null,p_limit integer default 8)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer; v_topics text[];
begin
  if p_topics is null or cardinality(p_topics)<1 or cardinality(p_topics)>8
    or array_position(p_topics,null) is not null
    or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work']::text[]
    or p_limit is null or p_limit<1 or p_limit>12 then raise exception 'Invalid operating topic query'; end if;
  select array_agg(distinct topic order by topic) into v_topics from unnest(p_topics) topic;
  v_limit:=p_limit;
  if not coalesce((select enabled from intelligence_config where id=1),false) then
    return jsonb_build_object('enabled',false,'topics',v_topics,'accounts','[]'::jsonb,'hasMore',false,'nextCursor',null);
  end if;
  return (
    with eligible as materialized (
      select id,name,domain,subindustry,netsuite_internal_id from companies
      where lists @> array['netsuite_tam']::text[] and status<>'removed_from_tam'
        and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
        and netsuite_internal_id ~ '^[0-9]+$'
    ), observations as not materialized (
      select o.* from intelligence_observations o join eligible c on c.id=o.company_id where o.is_current and not o.feedback_excluded
    ), matched as (
      select o.company_id from observations o cross join lateral unnest(o.cached_operating_topics) topic
      where o.cached_operating_topics && v_topics and topic=any(v_topics)
      group by o.company_id having count(distinct topic)=cardinality(v_topics)
    ), page as materialized (
      select c.* from eligible c join matched m on m.company_id=c.id
      where p_after is null or c.id>p_after order by c.id limit v_limit+1
    ), shown as materialized (
      select * from page order by id limit v_limit
    ), account_rows as (
      select c.id,jsonb_build_object(
        'companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,'internalId',c.netsuite_internal_id,
        'coverage',(select jsonb_build_object('observations',count(*),'interpreted',count(*) filter(where attributes is not null))
          from observations where company_id=c.id),
        -- Return one most recently captured supporting source per selected topic.
        -- A source supporting multiple topics is sent once. The page is bounded
        -- to 12 accounts x 8 sources, not an unbounded evidence dump.
        'observations',coalesce((select jsonb_agg(jsonb_build_object(
          'id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
          'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'attributes',o.attributes)
          order by o.observed_at desc,o.id)
          from observations o where o.id in (
            select distinct on (topic) supporting.id
            from observations supporting cross join lateral unnest(v_topics) topic
            where supporting.company_id=c.id and topic=any(supporting.cached_operating_topics)
            order by topic,supporting.observed_at desc,supporting.id desc
          )), '[]'::jsonb)
      ) value from shown c
    ) select jsonb_build_object(
      'enabled',true,'topics',v_topics,'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
      'hasMore',(select count(*)>v_limit from page),
      'nextCursor',case when (select count(*)>v_limit from page) then (select id from shown order by id desc limit 1) else null end,
      'coverage',jsonb_build_object(
        'tamAccounts',(select count(*) from eligible),
        'accountsWithTopicEvidence',(select count(distinct company_id) from observations where cardinality(cached_operating_topics)>0),
        'currentObservations',(select count(*) from observations),
        'interpretedObservations',(select count(*) from observations where attributes is not null),
        'matchingAccounts',(select count(*) from matched),
        'asOf',now(),'cacheOnly',true)
    )
  );
end $$;


notify pgrst,'reload schema';
commit;
