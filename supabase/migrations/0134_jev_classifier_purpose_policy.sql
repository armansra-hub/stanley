-- Customer-first paid scope, independent of budget_caps/provider_balance.
-- Installation never enables policy or processing, clears holds, rewrites paid
-- answers, or consumes a provider credit. Old exact answers stay readable.
begin;

create function public.intelligence_jev_classifier_allowed(p_purpose text,p_source_kind text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select coalesce(case p_purpose
    when 'operating_catalog' then p_source_kind in ('account_catalog')
    when 'public_interpretation' then p_source_kind in ('news','website','job','government')
    when 'federal_identity' then p_source_kind in ('federal_identity','federal_recipient_identity')
    when 'event_match' then p_source_kind in ('event_reconciliation','award_correspondence')
    else false end,false)
$$;

-- The existing claim checks the saved response before reserving. Keep that
-- behavior while constraining every NEW reservation in either funding mode.
alter function public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text)
  rename to intelligence_jev_reserve_before_classifier_policy;
revoke all on function public.intelligence_jev_reserve_before_classifier_policy(uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;

create function public.intelligence_jev_reserve_policy(p_id uuid,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not intelligence_jev_classifier_allowed(p_purpose,p_source_kind) then
    return jsonb_build_object('status','budget_deferred','reason','purpose_retired','retryAt',null);
  end if;
  return intelligence_jev_reserve_before_classifier_policy(p_id,p_purpose,p_company,p_observation,
    p_source_kind,p_fingerprint,p_workload);
end $$;

-- Read-only exact-cache path lets the application retire a workflow without
-- reserving on a miss, including while old app/database versions overlap.
create function public.intelligence_jev_cached(p_fingerprint text,p_purpose text,p_company uuid default null)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('status','complete','evaluation',r.evaluation,
    'reservationId',r.reservation_id,'reused',true)
  from intelligence_jev_requests r
  where r.fingerprint=p_fingerprint and r.purpose=p_purpose and r.purpose<>'private_tam'
    and r.company_id is not distinct from p_company
    and (r.state='complete' or (r.state='failed' and r.settled_at is null))
$$;

-- A previously reserved ticket must pass CURRENT purpose policy too. Enabling
-- provider_balance cannot bypass this final check immediately before HTTP.
create or replace function public.intelligence_jev_dispatch(p_fingerprint text,p_reservation uuid,p_lease uuid,p_model text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; s intelligence_spend%rowtype;
  p intelligence_jev_budget_policy%rowtype; v_now timestamptz; v_enabled boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('jev:'||p_fingerprint,0));
  select * into r from intelligence_jev_requests where fingerprint=p_fingerprint for update;
  if not found or r.state<>'running' or r.reservation_id<>p_reservation or r.lease_token<>p_lease then
    return jsonb_build_object('status','budget_deferred','reason','invalid_dispatch_ticket','retryAt',null);
  end if;
  if not intelligence_jev_classifier_allowed(r.purpose,r.source_kind) then
    return jsonb_build_object('status','budget_deferred','reason','purpose_retired','retryAt',null);
  end if;
  select * into p from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' for update;
  select enabled into v_enabled from intelligence_config where id=1 for update;
  select * into s from intelligence_spend where id=p_reservation for update;
  v_now:=clock_timestamp();
  if not p.enabled or not coalesce(v_enabled,false) then
    return jsonb_build_object('status','budget_deferred','reason','policy_disabled','retryAt',null);
  end if;
  if not intelligence_jev_classifier_allowed(s.purpose,s.source_kind)
    or s.purpose is distinct from r.purpose or s.source_kind is distinct from r.source_kind
    or s.company_id is distinct from r.company_id or s.request_fingerprint is distinct from p_fingerprint
    or s.jev_policy_id is distinct from p.id or s.state<>'reserved' or s.dispatched_at is not null
    or s.jev_model is distinct from p_model or p_model<>'jev-1.13.0'
    or s.dispatch_expires_at<=v_now or r.lease_until<=v_now then
    return jsonb_build_object('status','budget_deferred','reason','invalid_or_expired_dispatch_ticket','retryAt',null);
  end if;
  update intelligence_spend set dispatched_at=v_now where id=p_reservation;
  return jsonb_build_object('status','authorized','expiresAt',s.dispatch_expires_at,'model',s.jev_model);
end $$;

-- Retired saved-question producers become inert at their existing entry points.
-- This leaves historical rows, results, checkpoints, revisions and live leases
-- untouched. The observation redirect still passes every interpret insert and
-- diverts legacy view inserts to the now-inert enqueue function.
create or replace function public.intelligence_account_question_enqueue(p_view uuid,p_company uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin return; end $$;

create or replace function public.intelligence_account_question_claim()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select null::jsonb
$$;

create or replace function public.intelligence_backfill_view(p_view uuid,p_limit integer default 100)
returns integer language sql security definer set search_path=public,pg_temp as $$
  select 0
$$;

revoke all on function public.intelligence_jev_classifier_allowed(text,text),
  public.intelligence_jev_cached(text,text,uuid),
  public.intelligence_account_question_enqueue(uuid,uuid),
  public.intelligence_account_question_claim(),
  public.intelligence_backfill_view(uuid,integer),
  public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text),
  public.intelligence_jev_dispatch(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.intelligence_jev_classifier_allowed(text,text),
  public.intelligence_jev_cached(text,text,uuid),
  public.intelligence_account_question_enqueue(uuid,uuid),
  public.intelligence_account_question_claim(),
  public.intelligence_backfill_view(uuid,integer),
  public.intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text),
  public.intelligence_jev_dispatch(text,uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
