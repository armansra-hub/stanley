-- User authorization 2026-09-25: remove artificial spending/time-window pauses.
-- Installation preserves the old mode; activation is a separate exact update.
-- Provider 402/auth circuits, attribution, one-use tickets and receipts remain.
begin;
alter table public.intelligence_jev_budget_policy add column enforcement text not null
  default 'budget_caps' check(enforcement in ('budget_caps','provider_balance'));
alter table public.intelligence_spend drop constraint intelligence_spend_jev_phase_check;
alter table public.intelligence_spend add constraint intelligence_spend_jev_phase_check
  check(jev_phase in ('initial','maintenance','ongoing'));

alter function public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text)
  rename to intelligence_jev_reserve_fixed_allowance;
revoke all on function public.intelligence_jev_reserve_fixed_allowance(uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;

create function public.intelligence_jev_reserve_policy(p_id uuid,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p intelligence_jev_budget_policy%rowtype; v_now timestamptz; v_enabled boolean;
begin
  if p_id is null or p_purpose is null or p_purpose not in
    ('operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector')
    or p_workload is null or p_workload not in ('initial_coverage','monitoring','manual','unattributed')
    or p_source_kind is null or length(p_source_kind) not between 1 and 80
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Jev policy attribution';
  end if;
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' for update;
  if not found then raise exception 'Jev policy unavailable'; end if;
  if p.enforcement='budget_caps' then
    return intelligence_jev_reserve_fixed_allowance(p_id,p_purpose,p_company,p_observation,p_source_kind,p_fingerprint,p_workload);
  end if;
  select enabled into v_enabled from intelligence_config where id=1 for update;
  if not p.enabled or not coalesce(v_enabled,false) then
    return jsonb_build_object('status','budget_deferred','reason',coalesce(p.halt_reason,'policy_disabled'),'retryAt',null,'policyId',p.id);
  end if;
  if exists(select 1 from intelligence_spend where id=p_id) then
    return jsonb_build_object('status','budget_deferred','reason','reservation_already_exists','retryAt',null,'policyId',p.id);
  end if;
  v_now:=clock_timestamp();
  -- Reservations are accounting only here. Neither a guessed provider balance,
  -- unresolved historic usage, calendar date nor local allowance stops dispatch.
  insert into intelligence_spend(id,month,category,reserved_usd,purpose,company_id,observation_id,source_kind,request_fingerprint,workload,
    jev_policy_id,jev_phase,jev_budget_day,jev_model,jev_max_input_tokens,jev_usd_per_million,dispatch_expires_at)
  values(p_id,date_trunc('month',v_now at time zone 'UTC')::date,'jev',p.reservation_usd,p_purpose,p_company,p_observation,p_source_kind,p_fingerprint,p_workload,
    p.id,'ongoing',(v_now at time zone p.timezone)::date,p.model,p.max_input_tokens,p.usd_per_million,v_now+interval '30 seconds');
  return jsonb_build_object('status','reserved','reservationId',p_id,'policyId',p.id);
end $$;

create or replace function public.intelligence_settle(p_id uuid,p_actual numeric,p_tokens bigint default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare s intelligence_spend%rowtype; v_policy text; v_actual numeric; v_enforcement text;
begin
  select jev_policy_id into v_policy from intelligence_spend where id=p_id;
  if v_policy is null then return intelligence_settle_before_global_jev_budget(p_id,p_actual,p_tokens); end if;
  select enforcement into v_enforcement from intelligence_jev_budget_policy where id=v_policy for update;
  select * into s from intelligence_spend where id=p_id for update;
  if not found or s.state<>'reserved' then return false; end if;
  if p_tokens is not null and p_tokens<0 then raise exception 'Invalid usage'; end if;
  v_actual:=case when p_tokens is null then s.reserved_usd else ceil(p_tokens*s.jev_usd_per_million)/1000000 end;
  if p_actual is not null and p_actual is distinct from v_actual then raise exception 'Cost does not match priced usage'; end if;
  update intelligence_spend set charged_usd=v_actual,input_tokens=p_tokens,state='settled',settled_at=clock_timestamp() where id=p_id;
  if v_enforcement='budget_caps' and (v_actual>s.reserved_usd or p_tokens>s.jev_max_input_tokens) then
    update intelligence_jev_budget_policy set enabled=false,halt_reason='provider_cost_ceiling_breached',updated_at=clock_timestamp() where id=v_policy;
  end if;
  return true;
end $$;

alter function public.intelligence_jev_budget_status() rename to intelligence_jev_fixed_allowance_status;
revoke all on function public.intelligence_jev_fixed_allowance_status() from public,anon,authenticated,service_role;
create function public.intelligence_jev_budget_status()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p intelligence_jev_budget_policy%rowtype; result jsonb; v_enabled boolean; v_reason text;
begin
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24';
  if not found then return null; end if;
  result:=intelligence_jev_fixed_allowance_status();
  if p.enforcement='budget_caps' then return result||jsonb_build_object('enforcement','budget_caps'); end if;
  select enabled into v_enabled from intelligence_config where id=1;
  v_reason:=case when not p.enabled then coalesce(p.halt_reason,'policy_disabled')
    when not coalesce(v_enabled,false) then 'policy_disabled' else null end;
  return result||jsonb_build_object('enforcement','provider_balance','phase','ongoing','enabled',v_reason is null,
    'policyEnabled',p.enabled,'processingEnabled',coalesce(v_enabled,false),'blockedReason',v_reason,
    'initialMaxUsd',null,'dailyCapUsd',null,'maintenanceLimitUsd',null,
    'totalRemainingUsd',null,'dailyRemainingUsd',null,'initialRemainingUsd',null,'maintenanceRemainingUsd',null,
    'nextResetAt',null,'initialExpiresAt',null,'maintenanceExpiresAt',null,
    'providerBalanceUsd',null,'providerBalanceAsOf',null);
end $$;

revoke all on function public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text) to service_role;
revoke all on function public.intelligence_jev_budget_status() from public,anon,authenticated;
grant execute on function public.intelligence_jev_budget_status() to service_role;
notify pgrst,'reload schema';
commit;
