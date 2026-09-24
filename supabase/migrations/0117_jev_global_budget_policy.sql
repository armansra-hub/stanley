-- Shared Jev allowance for the 47-category rollout. Installation NEVER enables spending.
-- Legacy 402/outage reservations remain intact; they are not invoices and are not
-- automatically debited against the new funded epoch or erased.
begin;

create table public.intelligence_jev_budget_policy (
  id text primary key default 'jev-rollout-2026-09-24' check(id='jev-rollout-2026-09-24'),
  enabled boolean not null default false,
  generation_enabled boolean not null default false,
  timezone text not null default 'America/Los_Angeles' check(timezone='America/Los_Angeles'),
  initial_starts_at timestamptz not null default '2026-09-24 07:00:00+00',
  initial_expires_at timestamptz not null default '2026-09-25 07:00:00+00',
  -- 60 maintenance Pacific dates: Sep 25 through Nov 23, inclusive.
  maintenance_expires_at timestamptz not null default '2026-11-24 08:00:00+00',
  initial_limit_usd numeric(12,6) not null default 70 check(initial_limit_usd between 0 and 70),
  initial_effective_limit_usd numeric(12,6) not null default 69.81 check(initial_effective_limit_usd between 0 and 69.81),
  daily_limit_usd numeric(12,6) not null default 0.50 check(daily_limit_usd between 0 and 0.50),
  maintenance_limit_usd numeric(12,6) not null default 30 check(maintenance_limit_usd between 0 and 30),
  protected_maintenance_usd numeric(12,6) not null default 30 check(protected_maintenance_usd=30),
  confirmed_available_usd numeric(12,6) not null default 0 check(confirmed_available_usd>=0),
  funding_confirmed_at timestamptz,
  funding_receipt text,
  legacy_reconciliation_status text not null default 'pending' check(legacy_reconciliation_status in ('pending','reconciled')),
  opening_liability_usd numeric(12,6) check(opening_liability_usd>=0),
  reconciliation_receipt text,
  initial_allowed_purposes text[] not null default array['operating_catalog','research_ranking'],
  maintenance_allowed_purposes text[] not null default array['operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector'],
  model text not null default 'jev-1.13.0' check(model='jev-1.13.0'),
  max_input_tokens bigint not null default 65536 check(max_input_tokens=65536),
  usd_per_million numeric(12,6) not null default 0.042 check(usd_per_million=0.042),
  reservation_usd numeric(12,6) not null default 0.002753 check(reservation_usd=0.002753),
  pricing_verified_at timestamptz not null default '2026-09-24 07:00:00+00',
  legacy_snapshot jsonb not null default '{}',
  halt_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(initial_starts_at<initial_expires_at and initial_expires_at<maintenance_expires_at),
  check(initial_allowed_purposes <@ array['operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector']::text[]),
  check(maintenance_allowed_purposes <@ array['operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector']::text[])
);
insert into public.intelligence_jev_budget_policy(id,legacy_snapshot)
select 'jev-rollout-2026-09-24',jsonb_build_object(
  'capturedAt',now(),'source','existing intelligence_spend; not provider invoice',
  'knownUsageRequests',count(*) filter(where input_tokens is not null),
  'knownEstimatedUsd',coalesce(sum(charged_usd) filter(where input_tokens is not null),0),
  'unknownOrInFlightRequests',count(*) filter(where input_tokens is null),
  'unknownOrInFlightReservedUsd',coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where input_tokens is null),0),
  'reconciliationNote','Review billing-rejected HTTP402 receipts separately from genuine uncertain acceptance. Preserve history. Confirm funded balance and opening unbilled liability before activation.',
  'providerBalanceObservedBeforeTopUpUsd',-0.19,
  'hypothetical100TopUpLessProtected30Usd',69.81)
from public.intelligence_spend where category='jev';

-- Exact legacy decisions are separate from spend history. No rows are pre-cleared.
create table public.intelligence_jev_legacy_reconciliation (
  spend_id uuid primary key references public.intelligence_spend(id),
  classification text not null check(classification in ('unreviewed','confirmed_not_billed','already_in_confirmed_balance','possible_unbilled','confirmed_unbilled')),
  possible_unbilled_usd numeric(12,6) check(possible_unbilled_usd>=0),
  evidence_receipt text not null,
  reviewed_at timestamptz not null default now()
);

alter table public.intelligence_spend
  add column jev_policy_id text references public.intelligence_jev_budget_policy(id),
  add column jev_phase text check(jev_phase in ('initial','maintenance')),
  add column jev_budget_day date,
  add column jev_model text,
  add column jev_max_input_tokens bigint,
  add column jev_usd_per_million numeric(12,6),
  add column dispatch_expires_at timestamptz,
  add column dispatched_at timestamptz;
-- Keep new-epoch admission independent of the large historical outage ledger.
create index intelligence_spend_jev_policy_idx on public.intelligence_spend(jev_policy_id)
  where jev_policy_id is not null;
create index intelligence_spend_jev_policy_day on public.intelligence_spend(jev_policy_id,jev_budget_day);
alter table public.intelligence_jev_requests drop constraint intelligence_jev_requests_purpose_check;
-- History may contain private receipts from a previously authorized deployment.
-- Retain that stored enum; the claim/reserve/dispatch gates reject new private work.
alter table public.intelligence_jev_requests add constraint intelligence_jev_requests_purpose_check
  check(purpose in ('operating_catalog','public_interpretation','research_ranking','saved_view','private_tam','federal_identity','event_match','codex_connector'));

-- Preserve the deployed old gate/settler, including any live-only restrictions.
alter function public.intelligence_reserve(uuid,text,numeric) rename to intelligence_reserve_before_global_jev_budget;
alter function public.intelligence_settle(uuid,numeric,bigint) rename to intelligence_settle_before_global_jev_budget;
revoke all on function public.intelligence_reserve_before_global_jev_budget(uuid,text,numeric) from public,anon,authenticated,service_role;
revoke all on function public.intelligence_settle_before_global_jev_budget(uuid,numeric,bigint) from public,anon,authenticated,service_role;

create function public.intelligence_reserve(p_id uuid,p_category text,p_amount numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p intelligence_jev_budget_policy%rowtype;
begin
  -- Jev always needs attributed policy admission. The old unattributed route is closed.
  if p_category is distinct from 'generation' then return false; end if;
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' for update;
  if not found or not p.generation_enabled then return false; end if;
  -- No new generation permission is granted by installing/enabling the Jev policy.
  return intelligence_reserve_before_global_jev_budget(p_id,p_category,p_amount);
end $$;

-- Called after the singleton lock. No paid dispatch occurs in this transaction.
create function public.intelligence_jev_reserve_policy(p_id uuid,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p intelligence_jev_budget_policy%rowtype; v_now timestamptz; v_day date; v_next timestamptz;
  v_phase text; v_initial numeric; v_maintenance numeric; v_daily numeric; v_total numeric; v_enabled boolean;
begin
  if p_id is null or p_purpose is null or p_purpose not in ('operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector')
    or p_workload is null or p_workload not in ('initial_coverage','monitoring','manual','unattributed')
    or p_source_kind is null or length(p_source_kind) not between 1 and 80
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Jev policy attribution';
  end if;
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' for update;
  if not found then raise exception 'Jev policy unavailable'; end if;
  select enabled into v_enabled from intelligence_config where id=1 for update;
  -- Do not use transaction-start now(): a lock waiter may cross Pacific midnight.
  v_now:=clock_timestamp(); v_day:=(v_now at time zone p.timezone)::date;
  v_next:=((v_day+1)::timestamp at time zone p.timezone);
  if not p.enabled or not coalesce(v_enabled,false) then
    return jsonb_build_object('status','budget_deferred','reason','policy_disabled','retryAt',null,'policyId',p.id);
  end if;
  if p.funding_confirmed_at is null or nullif(btrim(p.funding_receipt),'') is null or p.confirmed_available_usd<=0
    or p.legacy_reconciliation_status<>'reconciled' or p.opening_liability_usd is null or nullif(btrim(p.reconciliation_receipt),'') is null then
    return jsonb_build_object('status','budget_deferred','reason','funding_or_reconciliation_required','retryAt',null,'policyId',p.id);
  end if;
  if v_now<p.initial_starts_at or v_now>=p.maintenance_expires_at then
    return jsonb_build_object('status','budget_deferred','reason','policy_term_exhausted','retryAt',null,'policyId',p.id);
  end if;
  v_phase:=case when v_now<p.initial_expires_at then 'initial' else 'maintenance' end;
  if not(p_purpose=any(case when v_phase='initial' then p.initial_allowed_purposes else p.maintenance_allowed_purposes end))
    or (v_phase='initial' and p_purpose='research_ranking' and p_source_kind<>'catalog_research_options') then
    return jsonb_build_object('status','budget_deferred','reason','purpose_not_admitted',
      'retryAt',case when v_phase='initial' and p_purpose=any(p.maintenance_allowed_purposes) then p.initial_expires_at else null end,'policyId',p.id);
  end if;
  if exists(select 1 from intelligence_spend where id=p_id) then
    return jsonb_build_object('status','budget_deferred','reason','reservation_already_exists','retryAt',null,'policyId',p.id);
  end if;
  select coalesce(sum(coalesce(charged_usd,reserved_usd)),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_phase='initial'),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_phase='maintenance'),0),
    -- An unresolved earlier-day acceptance is still possible current exposure.
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_budget_day=v_day
      or (jev_budget_day<v_day and input_tokens is null and dispatched_at is not null)),0)
    into v_total,v_initial,v_maintenance,v_daily
    from intelligence_spend where jev_policy_id=p.id;
  if v_total+p.opening_liability_usd+p.reservation_usd>p.confirmed_available_usd then
    return jsonb_build_object('status','budget_deferred','reason','funded_balance_exhausted','retryAt',null,'policyId',p.id);
  end if;
  if v_phase='initial' then
    if v_initial+p.reservation_usd>least(p.initial_limit_usd,p.initial_effective_limit_usd,
      p.confirmed_available_usd-p.opening_liability_usd-p.protected_maintenance_usd) then
      return jsonb_build_object('status','budget_deferred','reason','initial_allowance_exhausted','retryAt',p.initial_expires_at,'policyId',p.id);
    end if;
  else
    if v_maintenance+p.reservation_usd>p.maintenance_limit_usd then
      return jsonb_build_object('status','budget_deferred','reason','maintenance_allowance_exhausted','retryAt',null,'policyId',p.id);
    end if;
    if v_daily+p.reservation_usd>p.daily_limit_usd then
      return jsonb_build_object('status','budget_deferred','reason','daily_allowance_exhausted',
        'retryAt',case when v_next<p.maintenance_expires_at then v_next else null end,'policyId',p.id);
    end if;
  end if;
  insert into intelligence_spend(id,month,category,reserved_usd,purpose,company_id,observation_id,source_kind,request_fingerprint,workload,
    jev_policy_id,jev_phase,jev_budget_day,jev_model,jev_max_input_tokens,jev_usd_per_million,dispatch_expires_at)
  values(p_id,date_trunc('month',v_now at time zone 'UTC')::date,'jev',p.reservation_usd,p_purpose,p_company,p_observation,p_source_kind,p_fingerprint,p_workload,
    p.id,v_phase,v_day,p.model,p.max_input_tokens,p.usd_per_million,
    least(v_now+interval '30 seconds',v_next,p.maintenance_expires_at,case when v_phase='initial' then p.initial_expires_at else p.maintenance_expires_at end));
  return jsonb_build_object('status','reserved','reservationId',p_id,'policyId',p.id);
end $$;

-- Backward-compatible admission name cannot create an unattributed/underfunded call.
create or replace function public.intelligence_reserve_jev(p_id uuid,p_amount numeric,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_amount is distinct from 0.002753 then return false; end if;
  return (intelligence_jev_reserve_policy(p_id,p_purpose,p_company,p_observation,p_source_kind,p_fingerprint,p_workload)->>'status')='reserved';
end $$;

create function public.intelligence_settle(p_id uuid,p_actual numeric,p_tokens bigint default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare s intelligence_spend%rowtype; v_policy text; v_actual numeric;
begin
  select jev_policy_id into v_policy from intelligence_spend where id=p_id;
  if v_policy is null then return intelligence_settle_before_global_jev_budget(p_id,p_actual,p_tokens); end if;
  perform 1 from intelligence_jev_budget_policy where id=v_policy for update;
  select * into s from intelligence_spend where id=p_id for update;
  if not found or s.state<>'reserved' then return false; end if;
  if p_tokens is not null and p_tokens<0 then raise exception 'Invalid usage'; end if;
  v_actual:=case when p_tokens is null then s.reserved_usd else ceil(p_tokens*s.jev_usd_per_million)/1000000 end;
  if p_actual is not null and p_actual is distinct from v_actual then raise exception 'Cost does not match priced usage'; end if;
  update intelligence_spend set charged_usd=v_actual,input_tokens=p_tokens,state='settled',settled_at=clock_timestamp() where id=p_id;
  if v_actual>s.reserved_usd or p_tokens>s.jev_max_input_tokens then
    update intelligence_jev_budget_policy set enabled=false,halt_reason='provider_cost_ceiling_breached',updated_at=clock_timestamp() where id=v_policy;
  end if;
  return true;
end $$;

create or replace function public.intelligence_jev_claim(p_fingerprint text,p_purpose text,p_company uuid default null,
  p_observation uuid default null,p_source_kind text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; v_reservation uuid:=gen_random_uuid(); v_lease uuid:=gen_random_uuid(); d jsonb; s intelligence_spend%rowtype;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_purpose is null or p_purpose not in ('operating_catalog','public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector') then
    raise exception 'Invalid cache request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('jev:'||p_fingerprint,0));
  select * into r from intelligence_jev_requests where fingerprint=p_fingerprint for update;
  if found then
    if r.company_id is distinct from p_company or r.purpose<>p_purpose then raise exception 'Request scope mismatch'; end if;
    if r.state='complete' or (r.state='failed' and r.settled_at is null) then
      update intelligence_jev_requests set reuse_count=reuse_count+1,last_reused_at=clock_timestamp() where fingerprint=p_fingerprint;
      return jsonb_build_object('status','complete','evaluation',r.evaluation,'reservationId',r.reservation_id,'reused',true);
    end if;
    if r.state='running' and r.lease_until>clock_timestamp() then return jsonb_build_object('status','busy'); end if;
    if r.state='running' then
      select * into s from intelligence_spend where id=r.reservation_id;
      -- Only this new protocol can prove a provider dispatch was never authorized.
      if s.jev_policy_id is not null and s.dispatched_at is null then perform intelligence_settle(r.reservation_id,0,0);
      else perform intelligence_settle(r.reservation_id,null,null); end if;
    end if;
  end if;
  d:=intelligence_jev_reserve_policy(v_reservation,p_purpose,p_company,p_observation,p_source_kind,p_fingerprint,p_workload);
  if d->>'status'<>'reserved' then return d; end if;
  insert into intelligence_jev_requests(fingerprint,purpose,company_id,observation_id,source_kind,workload,state,reservation_id,lease_token,lease_until)
  values(p_fingerprint,p_purpose,p_company,p_observation,p_source_kind,p_workload,'running',v_reservation,v_lease,clock_timestamp()+interval '2 minutes')
  on conflict(fingerprint) do update set state='running',reservation_id=v_reservation,lease_token=v_lease,lease_until=excluded.lease_until,
    evaluation=null,completed_at=null,settled_at=null,observation_id=p_observation,source_kind=p_source_kind,workload=p_workload;
  return jsonb_build_object('status','execute','reservationId',v_reservation,'leaseToken',v_lease,'policyId',d->>'policyId');
end $$;

-- Consume a ticket once, immediately before the one outbound HTTP attempt.
create function public.intelligence_jev_dispatch(p_fingerprint text,p_reservation uuid,p_lease uuid,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; s intelligence_spend%rowtype; p intelligence_jev_budget_policy%rowtype; v_now timestamptz; v_enabled boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('jev:'||p_fingerprint,0));
  select * into r from intelligence_jev_requests where fingerprint=p_fingerprint for update;
  if not found or r.state<>'running' or r.reservation_id<>p_reservation or r.lease_token<>p_lease then
    return jsonb_build_object('status','budget_deferred','reason','invalid_dispatch_ticket','retryAt',null);
  end if;
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' for update;
  select enabled into v_enabled from intelligence_config where id=1 for update;
  select * into s from intelligence_spend where id=p_reservation for update;
  v_now:=clock_timestamp();
  if not p.enabled or not coalesce(v_enabled,false) then
    return jsonb_build_object('status','budget_deferred','reason','policy_disabled','retryAt',null);
  end if;
  if s.jev_policy_id is distinct from p.id or s.state<>'reserved' or s.dispatched_at is not null
    or s.jev_model is distinct from p_model or p_model<>'jev-1.13.0'
    or s.dispatch_expires_at<=v_now or r.lease_until<=v_now then
    return jsonb_build_object('status','budget_deferred','reason','invalid_or_expired_dispatch_ticket','retryAt',null);
  end if;
  update intelligence_spend set dispatched_at=v_now where id=p_reservation;
  return jsonb_build_object('status','authorized','expiresAt',s.dispatch_expires_at,'model',s.jev_model);
end $$;


-- A provider billing/authentication rejection closes the shared gate in the
-- same transaction as its durable receipt. This does not clear unknown usage.
-- Only an exact new-policy reservation that was dispatched can trip the circuit.
create function public.intelligence_jev_halt_on_provider_failure()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_policy text; v_reason text;
begin
  if new.state<>'failed' or new.completed_at is null or new.evaluation->>'ok'<>'false' then return new; end if;
  v_reason:=case
    when new.evaluation#>>'{error,kind}'='billing' or new.evaluation#>>'{error,code}'='typesafe_http_402'
      then 'provider_billing_unavailable'
    when new.evaluation#>>'{error,kind}'='authentication' or new.evaluation#>>'{error,code}' in ('typesafe_http_401','typesafe_http_403')
      then 'provider_authentication_unavailable' else null end;
  if v_reason is null then return new; end if;
  select jev_policy_id into v_policy from intelligence_spend
    where id=new.reservation_id and request_fingerprint=new.fingerprint
      and purpose=new.purpose and dispatched_at is not null;
  if v_policy is not null then
    update intelligence_jev_budget_policy set enabled=false,
      halt_reason=coalesce(halt_reason,v_reason),updated_at=clock_timestamp() where id=v_policy;
  end if;
  return new;
end $$;
revoke all on function public.intelligence_jev_halt_on_provider_failure() from public,anon,authenticated,service_role;
create trigger intelligence_jev_provider_failure_circuit
  after insert or update of evaluation on public.intelligence_jev_requests
  for each row execute function public.intelligence_jev_halt_on_provider_failure();

-- Read-only display snapshot. Reservation RPC remains the authoritative decision.
create function public.intelligence_jev_budget_status()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p intelligence_jev_budget_policy%rowtype; v_now timestamptz:=clock_timestamp(); v_day date; v_next timestamptz;
  v_enabled boolean; v_phase text; v_reason text; v_total numeric; v_initial numeric; v_maintenance numeric;
  v_today numeric; v_inflight numeric; v_unknown numeric; v_carried numeric; v_funded boolean; v_reconciled boolean;
  v_initial_remaining numeric; v_daily_remaining numeric; v_maintenance_remaining numeric; v_remaining numeric;
begin
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24';
  if not found then return null; end if;
  select enabled into v_enabled from intelligence_config where id=1;
  v_day:=(v_now at time zone p.timezone)::date; v_next:=((v_day+1)::timestamp at time zone p.timezone);
  v_phase:=case when v_now<p.initial_starts_at then 'before_start' when v_now<p.initial_expires_at then 'initial'
    when v_now<p.maintenance_expires_at then 'maintenance' else 'expired' end;
  v_funded:=p.funding_confirmed_at is not null and nullif(btrim(p.funding_receipt),'') is not null and p.confirmed_available_usd>0;
  v_reconciled:=p.legacy_reconciliation_status='reconciled' and p.opening_liability_usd is not null and nullif(btrim(p.reconciliation_receipt),'') is not null;
  select coalesce(sum(coalesce(charged_usd,reserved_usd)),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_phase='initial'),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_phase='maintenance'),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_budget_day=v_day),0),
    coalesce(sum(reserved_usd) filter(where state='reserved'),0),
    coalesce(sum(charged_usd) filter(where state='settled' and input_tokens is null),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where jev_budget_day<v_day and input_tokens is null and dispatched_at is not null),0)
    into v_total,v_initial,v_maintenance,v_today,v_inflight,v_unknown,v_carried
    from intelligence_spend where jev_policy_id=p.id;
  v_remaining:=case when v_funded and v_reconciled then greatest(0,p.confirmed_available_usd-p.opening_liability_usd-v_total) else 0 end;
  v_initial_remaining:=case when v_funded and v_reconciled then greatest(0,least(p.initial_limit_usd,p.initial_effective_limit_usd,
    p.confirmed_available_usd-p.opening_liability_usd-p.protected_maintenance_usd)-v_initial) else 0 end;
  v_maintenance_remaining:=greatest(0,least(p.maintenance_limit_usd-v_maintenance,v_remaining));
  v_daily_remaining:=greatest(0,least(p.daily_limit_usd-v_today-v_carried,v_maintenance_remaining));
  v_reason:=case when not p.enabled or not coalesce(v_enabled,false) then coalesce(p.halt_reason,'policy_disabled')
    when not v_funded or not v_reconciled then 'funding_or_reconciliation_required'
    when v_phase in ('before_start','expired') then 'policy_term_exhausted'
    when v_remaining<p.reservation_usd then 'funded_balance_exhausted'
    when v_phase='initial' and v_initial_remaining<p.reservation_usd then 'initial_allowance_exhausted'
    when v_phase='maintenance' and v_maintenance_remaining<p.reservation_usd then 'maintenance_allowance_exhausted'
    when v_phase='maintenance' and v_daily_remaining<p.reservation_usd then 'daily_allowance_exhausted' else null end;
  return jsonb_build_object('asOf',v_now,'policyId',p.id,'enabled',v_reason is null,
    'policyEnabled',p.enabled,'processingEnabled',coalesce(v_enabled,false),'phase',v_phase,'blockedReason',v_reason,
    'initialMaxUsd',least(p.initial_limit_usd,p.initial_effective_limit_usd),'dailyCapUsd',p.daily_limit_usd,'maintenanceLimitUsd',p.maintenance_limit_usd,
    'initialUsedUsd',v_initial,'maintenanceUsedUsd',v_maintenance,'todayUsedUsd',v_today,
    'inFlightReserveUsd',v_inflight,'unknownReserveUsd',v_unknown,'carriedUnknownUsd',v_carried,
    'totalRemainingUsd',v_remaining,'dailyRemainingUsd',v_daily_remaining,'initialRemainingUsd',v_initial_remaining,
    'maintenanceRemainingUsd',v_maintenance_remaining,
    'nextResetAt',case when v_phase='initial' then p.initial_expires_at when v_phase='maintenance' and v_next<p.maintenance_expires_at then v_next else null end,
    'initialExpiresAt',p.initial_expires_at,'maintenanceExpiresAt',p.maintenance_expires_at,
    'fundingConfirmed',v_funded,'legacyReconciled',v_reconciled,'openingLiabilityUsd',p.opening_liability_usd);
end $$;
revoke all on function public.intelligence_jev_budget_status() from public,anon,authenticated;
grant execute on function public.intelligence_jev_budget_status() to service_role;

alter table public.intelligence_jev_budget_policy enable row level security;
alter table public.intelligence_jev_legacy_reconciliation enable row level security;
revoke all on public.intelligence_jev_budget_policy,public.intelligence_jev_legacy_reconciliation from public,anon,authenticated;
grant all on public.intelligence_jev_budget_policy,public.intelligence_jev_legacy_reconciliation to service_role;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname in ('intelligence_reserve','intelligence_settle','intelligence_reserve_jev','intelligence_jev_reserve_policy','intelligence_jev_claim','intelligence_jev_dispatch') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
