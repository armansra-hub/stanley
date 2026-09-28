-- The provider-balance policy reports phase=ongoing. Admit it through the
-- existing interpretation and saved-question queues, just like maintenance.
-- No policy activation, hold clearing, paid dispatch or queue data changes.
begin;

create or replace function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype; policy jsonb; slots integer; batch integer; legacy boolean;
begin
 if p_limit is null or p_limit<1 then raise exception 'intelligence claim limit must be positive'; end if;
 select * into cfg from intelligence_config where id=1 for update;
 if not coalesce(cfg.enabled,false) then return; end if;
 if cfg.catalog_mode='off' then return query select * from intelligence_claim_pre_catalog(p_limit); return; end if;
 policy:=intelligence_jev_budget_status();
 if cfg.catalog_mode='pilot' or policy->>'phase' not in ('maintenance','ongoing') or not coalesce((policy->>'enabled')::boolean,false) then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
 select greatest(0,12-count(*)::integer) into slots from intelligence_jobs where status='running' and lease_until>now();
 if slots=0 then return; end if; batch:=least(p_limit,6,slots);
 update intelligence_config set catalog_legacy_claim_turn=catalog_legacy_claim_turn+1 where id=1
   returning catalog_legacy_claim_turn%10=0 into legacy;
 return query with candidates as materialized (
 select j.id,j.created_at,j.priority,j.due_at from intelligence_jobs j
 join intelligence_observations o on o.id=j.observation_id join companies c on c.id=o.company_id
 where j.attempts<5 and j.due_at<=now() and (j.status='queued' or (j.status='running' and j.lease_until<now()))
   and o.is_current and not o.feedback_excluded and c.lists @> array['netsuite_tam']::text[]
   and c.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
   and c.netsuite_internal_id ~ '^[0-9]+$'
 ), old_slot as materialized (
 select j.id from intelligence_jobs j join candidates c on c.id=j.id
 where legacy and c.created_at<cfg.catalog_legacy_cutoff_at order by c.due_at,c.created_at,j.id limit 1 for update of j skip locked
 ), fresh as materialized (
 select j.id from intelligence_jobs j join candidates c on c.id=j.id
 where c.created_at>=cfg.catalog_legacy_cutoff_at order by c.priority desc,c.due_at,c.created_at,j.id
 limit greatest(0,batch-(select count(*)::integer from old_slot)) for update of j skip locked
 ), ready as (select id from old_slot union all select id from fresh)
 update intelligence_jobs j set status='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
 from ready where j.id=ready.id returning j.*;
end $$;

create or replace function public.intelligence_account_question_claim()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype; policy jsonb; legacy boolean; j intelligence_account_question_jobs%rowtype;
begin
 select * into cfg from intelligence_config where id=1 for update;
 if not coalesce(cfg.enabled,false) then return null; end if;
 if cfg.catalog_mode='off' then return intelligence_account_question_claim_pre_catalog(); end if;
 policy:=intelligence_jev_budget_status();
 if cfg.catalog_mode='pilot' or policy->>'phase' not in ('maintenance','ongoing') or not coalesce((policy->>'enabled')::boolean,false) then return null; end if;
 update intelligence_config set catalog_legacy_claim_turn=catalog_legacy_claim_turn+1 where id=1
   returning catalog_legacy_claim_turn%10=0 into legacy;
 select q.* into j from intelligence_account_question_jobs q join intelligence_views v on v.id=q.view_id
 join companies c on c.id=q.company_id where v.active and q.due_at<=now()
   and (q.status='queued' or (q.status='running' and q.lease_until<now()))
   and (q.updated_at>=cfg.catalog_legacy_cutoff_at or legacy)
   and c.lists @> array['netsuite_tam']::text[] and c.status is distinct from 'removed_from_tam'
   and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
 order by case when legacy and q.updated_at<cfg.catalog_legacy_cutoff_at then 0 else 1 end,q.due_at,q.updated_at
 limit 1 for update of q skip locked;
 if not found then return null; end if;
 update intelligence_account_question_jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',
   running_revision=case when checkpoint is null then revision else running_revision end
 where view_id=j.view_id and company_id=j.company_id returning * into j;
 return to_jsonb(j)||jsonb_build_object('question',(select question from intelligence_views where id=j.view_id),
   'company',(select name from companies where id=j.company_id),'source_ids',case when j.checkpoint is null then
     (select coalesce(jsonb_agg(id order by id),'[]') from intelligence_observations where company_id=j.company_id and is_current and not feedback_excluded) end);
end $$;

revoke all on function public.intelligence_claim(integer),public.intelligence_account_question_claim() from public,anon,authenticated;
grant execute on function public.intelligence_claim(integer),public.intelligence_account_question_claim() to service_role;
notify pgrst,'reload schema';
commit;
