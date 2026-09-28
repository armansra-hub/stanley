-- Finish the current operating catalog before repeating completed accounts.
-- The existing account lease remains the sole owner. Caller capacity is driven
-- by observed provider/DB health; there is no fixed two-account database cap.
-- No activation, queue reset, dispatch, semantic change or TAM grading change.
begin;

alter table public.intelligence_catalog_accounts
  add column last_completed_catalog_version text;

-- One finite pass over existing 47-answer account mirrors. A counter alone is
-- not proof: require all 47 native answers for the same version and evidence
-- snapshot. The marker means "previously evaluated", not "currently fresh";
-- exact-current-source validation remains in the unchanged checkpoint RPC.
-- This changes only scheduling metadata, never source/answer/lease state.
update public.intelligence_catalog_accounts a
set last_completed_catalog_version=a.catalog_version
where a.answered_count=47 and a.evidence_key is not null
  and 47=(select count(*) from public.intelligence_catalog_facets f
    where f.company_id=a.company_id and f.catalog_version=a.catalog_version
      and f.evidence_key=a.evidence_key and f.status in ('answered','stale')
      and f.native_result->>'questionId'=f.facet_id and f.decision is not null);

create function public.intelligence_catalog_remember_completion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  -- Keep the completion marker across invalidation/continuation. New catalog
  -- versions earn their own marker only after 47 answers have been persisted.
  if new.answered_count=47 and new.evidence_key is not null
    and new.last_completed_catalog_version is distinct from new.catalog_version
    and 47=(select count(*) from intelligence_catalog_facets f
      where f.company_id=new.company_id and f.catalog_version=new.catalog_version
        and f.evidence_key=new.evidence_key and f.status in ('answered','stale')
        and f.native_result->>'questionId'=f.facet_id and f.decision is not null) then
    new.last_completed_catalog_version:=new.catalog_version;
  end if;
  return new;
end $$;
create trigger intelligence_catalog_completed_version
before insert or update of answered_count,catalog_version,evidence_key,status
on public.intelligence_catalog_accounts for each row
execute function public.intelligence_catalog_remember_completion();

create or replace function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare lane bigint; cfg intelligence_config%rowtype;
begin
  if p_limit is null or p_limit<1 then raise exception 'directed claim limit must be positive'; end if;
  select * into cfg from intelligence_config where id=1 for update;
  if not coalesce(cfg.enabled,false) then return; end if;
  -- Provider/manual holds remain authoritative. This is not a spend allowance;
  -- the existing dispatch ticket still makes the final paid-request decision.
  if cfg.catalog_mode<>'off' and not exists(select 1 from intelligence_jev_budget_policy
    where id='jev-rollout-2026-09-24' and enabled) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  update intelligence_config set directed_claim_turn=(directed_claim_turn+1)%3
    where id=1 returning directed_claim_turn into lane;
  return query with picked as (
    select j.company_id from intelligence_directed_research_jobs j
    join companies c on c.id=j.company_id
    left join intelligence_catalog_accounts a on a.company_id=j.company_id
    where c.status is distinct from 'removed_from_tam' and c.lists @> array['netsuite_tam']::text[]
      and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
      and ((cfg.catalog_mode='off' and j.catalog_requested_version is null)
        or (cfg.catalog_mode='rollout' and j.catalog_requested_version is not null)
        or (cfg.catalog_mode='pilot' and j.company_id=cfg.catalog_pilot_company_id and j.catalog_requested_version is not null))
      and j.due_at<=now() and (j.status in ('queued','complete') or (j.status='running' and j.lease_until<now()))
    order by
      case when j.catalog_requested_version is not null and
        a.last_completed_catalog_version is distinct from j.catalog_requested_version then 0 else 1 end,
      -- Persisted partial first passes finish before untouched accounts. A
      -- previously completed refresh cannot regain first-pass priority simply
      -- because source invalidation made its answer count fall to zero.
      case when j.catalog_requested_version is not null and
        a.last_completed_catalog_version is distinct from j.catalog_requested_version and
        a.catalog_version=j.catalog_requested_version and a.answered_count between 1 and 46 then 0 else 1 end,
      case when j.catalog_requested_version is null and lane=1 and not exists(
        select 1 from intelligence_observations o where o.company_id=j.company_id
          and o.is_current and not o.feedback_excluded and o.attributes is not null) then 0 else 1 end,
      j.due_at,j.requested_at,j.company_id limit p_limit for update of j skip locked
  ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '3 minutes',attempts=j.attempts+1,
    wake_reason=case when j.status='complete' then 'scheduled_discovery' else j.wake_reason end
  from picked where j.company_id=picked.company_id returning j.*;
end $$;

revoke all on function public.intelligence_catalog_remember_completion() from public,anon,authenticated,service_role;
revoke all on function public.intelligence_directed_claim(integer) from public,anon,authenticated;
grant execute on function public.intelligence_directed_claim(integer) to service_role;
notify pgrst,'reload schema';
commit;
