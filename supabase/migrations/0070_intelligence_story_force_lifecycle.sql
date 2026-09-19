-- Manual story generation is a pending request, not a permanent account mode.
-- Preserve the exact-lease fences and automatic dirty-hash recovery from 0063.
begin;

create or replace function public.intelligence_story_enqueue(p_company uuid,p_hash text,p_force boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if length(p_hash)<>64 then raise exception 'invalid_evidence_hash'; end if;
  if not exists(select 1 from companies where id=p_company and status<>'removed_from_tam') then return false; end if;
  if exists(select 1 from intelligence_account_stories where company_id=p_company and evidence_hash=p_hash) then
    insert into intelligence_story_jobs(company_id,desired_hash,status,finished_at) values(p_company,p_hash,'complete',now())
    on conflict(company_id) do update set desired_hash=p_hash,status='complete',finished_at=now(),last_error=null,
      lease_token=null,lease_until=null,checkpoint=null,force_requested=false;
    return false;
  end if;
  insert into intelligence_story_jobs(company_id,desired_hash,force_requested) values(p_company,p_hash,p_force)
  on conflict(company_id) do update set desired_hash=excluded.desired_hash,status='queued',due_at=now(),
    requested_at=now(),force_requested=excluded.force_requested or
      (intelligence_story_jobs.force_requested and intelligence_story_jobs.status in ('queued','running')),
    lease_token=null,lease_until=null,attempts=0,last_error=null,checkpoint=null,finished_at=null
  where intelligence_story_jobs.desired_hash<>excluded.desired_hash
     or (excluded.force_requested and (intelligence_story_jobs.status in ('failed','superseded')
       or (intelligence_story_jobs.status in ('queued','running') and not intelligence_story_jobs.force_requested)));
  -- A manual request upgrading an automatic live job atomically replaces its
  -- lease. Its old worker cannot consume the new request with a terminal finish.
  -- Repeated requests for an already-forced live job keep its lease and retries.
  return found;
end $$;

create or replace function public.intelligence_story_finish(p_company uuid,p_lease uuid,p_hash text,p_status text,
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
    force_requested=case when p_status='queued' then force_requested else false end,
    due_at=case when p_status='queued' then now()+make_interval(secs=>greatest(1,p_retry_seconds)) else due_at end,
    finished_at=case when p_status in ('complete','superseded') then now() else null end,
    checkpoint=case when p_status='complete' then null else checkpoint end where company_id=p_company;
  return true;
end $$;

-- Older terminal rows can have inherited the previous sticky force flag.
-- Pending rows remain untouched because they may represent a real manual request.
update public.intelligence_story_jobs set force_requested=false
  where force_requested and status in ('complete','failed','superseded');

-- CREATE OR REPLACE preserves 0063's existing service-role-only privileges.
notify pgrst,'reload schema';
commit;
