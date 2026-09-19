-- Keep one oldest due slot for progress, then prefer ordinary/new evidence over
-- the saved-answer routing replay. This changes scheduling only: native answers,
-- retry accounting, operation identity and lease fencing remain unchanged.
begin;
create or replace function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  update intelligence_jobs set status='failed',last_error='attempts_exhausted',lease_token=null,lease_until=null
    where attempts>=5 and (status='queued' or (status='running' and lease_until<now()));
  return query
    with oldest as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and (status='queued' or (status='running' and lease_until<now()))
      order by due_at,priority desc,created_at,id
      for update skip locked limit 1
    ), fresh as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now() and id not in(select id from oldest)
        and (status='queued' or (status='running' and lease_until<now()))
      order by case when result->>'routingBackfill'='business-services-v1' then 1 else 0 end,
        priority desc,due_at,created_at,id
      for update skip locked limit greatest(0,least(p_limit,12)-1)
    ), ready as (
      select id from oldest union all select id from fresh
    ) update intelligence_jobs j set status='running',attempts=j.attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
      from ready where j.id=ready.id returning j.*;
end $$;
revoke all on function public.intelligence_claim(integer) from public,anon,authenticated;
grant execute on function public.intelligence_claim(integer) to service_role;
commit;
