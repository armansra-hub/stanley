-- Increase useful work per worker while bounding overlapping cloud invocations.
-- Existing job rows are the capacity ledger: no extra queue, scheduler, claim
-- reset, provider retry, question change, or TAM grading coordination change.
begin;

create index intelligence_jobs_running_capacity
  on public.intelligence_jobs(lease_until) where status='running';
create index intelligence_directed_running_capacity
  on public.intelligence_directed_research_jobs(lease_until) where status='running';

create or replace function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare
  batch_limit integer;
  available_slots integer;
  oldest_slots integer := 1;
  coverage_slots integer;
  claim_turn bigint;
  engine_enabled boolean;
begin
  if p_limit is null or p_limit<1 then raise exception 'intelligence claim limit must be positive'; end if;
  -- Both claim RPCs use this same lock order: config -> shared capacity lock
  -- -> selected job rows. Budget reservations and rotation counters already use
  -- the config row; no claim waits for it while holding a capacity/job lock.
  select enabled into engine_enabled from intelligence_config where id=1 for update;
  if not coalesce(engine_enabled,false) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  select greatest(0,12-count(*)::integer) into available_slots
    from intelligence_jobs where status='running' and lease_until>now();
  if available_slots=0 then return; end if;
  batch_limit := least(p_limit,6,available_slots);

  -- Preserve the oldest / first-reading / fresh-evidence lanes from 0108.
  -- A partially available pool uses the same small-batch fairness rotation.
  coverage_slots := (batch_limit-1)/2;
  if batch_limit<3 then
    update intelligence_config set coverage_claim_turns=jsonb_set(
      coverage_claim_turns,array[batch_limit::text],
      to_jsonb(coalesce((coverage_claim_turns->>batch_limit::text)::bigint,0)+1),true)
      where id=1 returning (coverage_claim_turns->>batch_limit::text)::bigint into claim_turn;
    if batch_limit=1 then
      oldest_slots := case when (claim_turn-1)%3=0 then 1 else 0 end;
      coverage_slots := case when (claim_turn-1)%3=1 then 1 else 0 end;
    else
      coverage_slots := case when claim_turn%2=1 then 1 else 0 end;
    end if;
  end if;
  update intelligence_jobs set status='failed',last_error='attempts_exhausted',lease_token=null,lease_until=null
    where attempts>=5 and (status='queued' or (status='running' and lease_until<now()));
  return query
    with oldest as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and (status='queued' or (status='running' and lease_until<now()))
      order by due_at,priority desc,created_at,id
      for update skip locked limit oldest_slots
    ), uncovered as materialized (
      select j.id from intelligence_jobs j
      join intelligence_observations o on o.id=j.observation_id
      where j.kind='interpret' and o.is_current and not o.feedback_excluded and j.attempts<5 and j.due_at<=now()
        and (j.status='queued' or (j.status='running' and j.lease_until<now()))
        and j.id not in(select id from oldest)
        and not exists(select 1 from intelligence_observations known
          where known.company_id=o.company_id and known.is_current and not known.feedback_excluded and known.attributes is not null)
        and not exists(select 1 from oldest selected
          join intelligence_jobs sj on sj.id=selected.id
          join intelligence_observations so on so.id=sj.observation_id
          where sj.kind='interpret' and so.company_id=o.company_id)
      order by case when j.result->>'routingBackfill'='business-services-v1' then 1 else 0 end,
        j.priority desc,j.due_at,j.created_at,j.id
      for update of j skip locked limit coverage_slots
    ), fresh as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and id not in(select id from oldest union all select id from uncovered)
        and (status='queued' or (status='running' and lease_until<now()))
      order by case when result->>'routingBackfill'='business-services-v1' then 1 else 0 end,
        priority desc,due_at,created_at,id
      for update skip locked
      limit greatest(0,batch_limit-(select count(*)::integer from oldest)-(select count(*)::integer from uncovered))
    ), ready as (
      select id from oldest union all select id from uncovered union all select id from fresh
    ) update intelligence_jobs j set status='running',attempts=j.attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
      from ready where j.id=ready.id returning j.*;
end $$;

create or replace function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare
  lane bigint;
  available_slots integer;
  batch_limit integer;
  engine_enabled boolean;
begin
  if p_limit is null or p_limit<1 then raise exception 'directed claim limit must be positive'; end if;
  select enabled into engine_enabled from intelligence_config where id=1 for update;
  if not coalesce(engine_enabled,false) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  select greatest(0,2-count(*)::integer) into available_slots
    from intelligence_directed_research_jobs where status='running' and lease_until>now();
  if available_slots=0 then return; end if;
  batch_limit := least(p_limit,2,available_slots);
  update intelligence_config set directed_claim_turn=(directed_claim_turn+1)%3 where id=1 returning directed_claim_turn into lane;
  return query with picked as (
    select j.company_id from intelligence_directed_research_jobs j join companies c on c.id=j.company_id
    where c.status is distinct from 'removed_from_tam' and c.lists @> array['netsuite_tam']::text[]
      and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
      and j.due_at<=now() and (j.status in ('queued','complete') or (j.status='running' and j.lease_until<now()))
    order by case when lane=1 and not exists(select 1 from intelligence_observations o
      where o.company_id=j.company_id and o.is_current and not o.feedback_excluded and o.attributes is not null) then 0 else 1 end,
      j.due_at,j.requested_at,j.company_id limit batch_limit for update of j skip locked
  ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '3 minutes',attempts=j.attempts+1,
    wake_reason=case when j.status='complete' then 'scheduled_discovery' else j.wake_reason end
    from picked where j.company_id=picked.company_id returning j.*;
end $$;

revoke all on function public.intelligence_claim(integer),public.intelligence_directed_claim(integer) from public,anon,authenticated;
grant execute on function public.intelligence_claim(integer),public.intelligence_directed_claim(integer) to service_role;
notify pgrst,'reload schema';
commit;
