-- September-only opt-in: up to three exact-record grading pipelines.
-- All existing same-record, actor, token, expiry, PDF and cohort fences remain.
create or replace function claim_tam_regrade_record(
  p_run_slug text,
  p_netsuite_internal_id text,
  p_actor_key text,
  p_include_hold boolean,
  p_claim_token uuid,
  p_lease_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_run_status text;
  v_record tam_regrade_records%rowtype;
  v_now timestamptz := now();
  v_token uuid;
  v_resumed boolean := false;
  v_reclaimed boolean := false;
  v_prior_actor text;
  v_prior_expiry timestamptz;
begin
  if p_netsuite_internal_id is null or p_netsuite_internal_id !~ '^[0-9]+$' then raise exception 'exact numeric NetSuite Internal ID is required'; end if;
  if nullif(btrim(p_actor_key), '') is null then raise exception 'actor key is required'; end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then raise exception 'lease must be between 60 and 3600 seconds'; end if;

  select id, status into v_run_id, v_run_status from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  if v_run_status <> 'grading' then raise exception 'TAM regrade run % is %, not grading', p_run_slug, v_run_status; end if;
  -- The run-row lock above serializes capacity admission and actor ownership.
  -- Only the explicitly authorized September successor permits three pipelines.
  if exists (
    select 1 from tam_regrade_records
    where run_id = v_run_id
      and netsuite_internal_id <> p_netsuite_internal_id
      and grade_status = 'reading'
      and claim_expires_at > v_now
      and claim_actor = p_actor_key
  ) then
    raise exception 'this TAM actor already has another active exact record lease';
  end if;
  if (
    select count(*) from tam_regrade_records
    where run_id = v_run_id
      and netsuite_internal_id <> p_netsuite_internal_id
      and grade_status = 'reading'
      and claim_expires_at > v_now
  ) >= (case when p_run_slug = 'ars-bs-tam-2026-09-17' then 3 else 1 end) then
    raise exception 'TAM run active lease capacity reached';
  end if;
  select * into v_record from tam_regrade_records
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  for update;
  if not found then raise exception 'record is not registered in this TAM run: %', p_netsuite_internal_id; end if;
  if not v_record.is_current or v_record.membership_status = 'removed' then raise exception 'removed/non-current TAM record cannot be claimed: %', p_netsuite_internal_id; end if;
  if v_record.pdf_status <> 'verified' then raise exception 'NetSuite ID % PDF status is %', p_netsuite_internal_id, v_record.pdf_status; end if;
  perform pg_advisory_xact_lock(hashtextextended('tam-company:' || p_netsuite_internal_id, 0));
  if v_record.company_id is null or tam_canonical_company_id(p_netsuite_internal_id) is distinct from v_record.company_id then raise exception 'NetSuite ID % lacks one exact canonical company mapping', p_netsuite_internal_id; end if;
  if v_record.grade_status in ('final','published') then raise exception 'final/published TAM record cannot be claimed: %', p_netsuite_internal_id; end if;

  if v_record.grade_status = 'reading' and v_record.claim_expires_at > v_now then
    if v_record.claim_actor is distinct from p_actor_key then raise exception 'NetSuite ID % is actively claimed by another actor', p_netsuite_internal_id; end if;
    if p_claim_token is null or v_record.claim_token is distinct from p_claim_token then raise exception 'active claim token is required to resume NetSuite ID %', p_netsuite_internal_id; end if;
    v_token := v_record.claim_token;
    v_resumed := true;
  elsif v_record.grade_status = 'reading' then
    v_prior_actor := v_record.claim_actor;
    v_prior_expiry := v_record.claim_expires_at;
    v_token := gen_random_uuid();
    v_reclaimed := true;
  elsif v_record.grade_status = 'pending' then
    v_token := gen_random_uuid();
  elsif v_record.grade_status = 'hold' and p_include_hold then
    v_token := gen_random_uuid();
  elsif v_record.grade_status = 'hold' then
    raise exception 'NetSuite ID % is on hold; explicit includeHold is required', p_netsuite_internal_id;
  else
    raise exception 'NetSuite ID % cannot be claimed from grade status %', p_netsuite_internal_id, v_record.grade_status;
  end if;

  update tam_regrade_records
  set grade_status = 'reading',
      hold_reason = null,
      last_actor = p_actor_key,
      claim_actor = p_actor_key,
      claim_token = v_token,
      claim_generation = case when v_resumed then claim_generation else claim_generation + 1 end,
      claim_started_at = case when v_resumed then claim_started_at else v_now end,
      claim_heartbeat_at = v_now,
      claim_expires_at = v_now + make_interval(secs => p_lease_seconds)
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  returning * into v_record;

  insert into tam_regrade_actors (run_id, actor_key, status, current_work, metadata, heartbeat_at)
  values (
    v_run_id, p_actor_key, 'working',
    format('Reading NetSuite ID %s', p_netsuite_internal_id),
    jsonb_build_object('exact_id', p_netsuite_internal_id, 'claim_generation', v_record.claim_generation),
    v_now
  )
  on conflict (run_id, actor_key) do update
  set status = 'working', current_work = excluded.current_work,
      metadata = excluded.metadata, heartbeat_at = excluded.heartbeat_at;
  update tam_regrade_runs
  set status = case when status in ('initializing','capturing') then 'grading' else status end,
      last_heartbeat_at = v_now
  where id = v_run_id;

  if not v_resumed then
    insert into tam_regrade_events (
      run_id, actor_key, kind, netsuite_internal_id, summary, metadata
    ) values (
      v_run_id, p_actor_key,
      case when v_reclaimed then 'grade.reclaimed' else 'grade.claimed' end,
      p_netsuite_internal_id,
      case when v_reclaimed
        then format('Reclaimed expired grade lease for NetSuite ID %s', p_netsuite_internal_id)
        else format('Claimed NetSuite ID %s for full-record grading', p_netsuite_internal_id)
      end,
      jsonb_build_object(
        'claim_generation', v_record.claim_generation,
        'lease_expires_at', v_record.claim_expires_at,
        'prior_actor', v_prior_actor,
        'prior_expiry', v_prior_expiry,
        'included_hold', p_include_hold
      )
    );
  end if;

  return jsonb_build_object(
    'netsuite_internal_id', v_record.netsuite_internal_id,
    'company_id', v_record.company_id,
    'pdf_status', v_record.pdf_status,
    'grade_status', v_record.grade_status,
    'last_actor', v_record.last_actor,
    'claim_actor', v_record.claim_actor,
    'claim_token', v_record.claim_token,
    'claim_generation', v_record.claim_generation,
    'claim_started_at', v_record.claim_started_at,
    'claim_heartbeat_at', v_record.claim_heartbeat_at,
    'claim_expires_at', v_record.claim_expires_at,
    'resumed', v_resumed,
    'reclaimed', v_reclaimed
  );
end;
$$;

notify pgrst, 'reload schema';
