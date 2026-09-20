-- Cache exact public Jev requests and commit paid answers before accounting.
-- Existing intelligence_reserve remains authoritative, including live monitoring-only settings.
begin;

alter table public.intelligence_spend
  add column if not exists purpose text,
  add column if not exists company_id uuid,
  add column if not exists observation_id uuid,
  add column if not exists source_kind text,
  add column if not exists request_fingerprint text,
  add column if not exists workload text;

create table public.intelligence_jev_requests (
  fingerprint text primary key check (fingerprint ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('public_interpretation','research_ranking','saved_view')),
  company_id uuid,
  observation_id uuid,
  source_kind text,
  workload text not null check (workload in ('initial_coverage','monitoring','manual','unattributed')),
  state text not null check (state in ('running','complete','failed')),
  reservation_id uuid not null references public.intelligence_spend(id),
  lease_token uuid not null,
  lease_until timestamptz not null,
  evaluation jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  settled_at timestamptz,
  reuse_count bigint not null default 0,
  last_reused_at timestamptz
);
create index intelligence_jev_receipts_unsettled on public.intelligence_jev_requests(completed_at)
  where completed_at is not null and settled_at is null;
create index intelligence_spend_purpose on public.intelligence_spend(month,purpose);

create function public.intelligence_reserve_jev(p_id uuid,p_amount numeric,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_purpose not in ('public_interpretation','research_ranking','saved_view','private_tam')
    or p_purpose is null or p_workload not in ('initial_coverage','monitoring','manual','unattributed')
    or p_workload is null or length(p_source_kind)>80
    or (p_fingerprint is not null and p_fingerprint !~ '^[a-f0-9]{64}$') then
    raise exception 'Invalid Jev attribution';
  end if;
  if not intelligence_reserve(p_id,'jev',p_amount) then return false; end if;
  update intelligence_spend set purpose=p_purpose,company_id=p_company,observation_id=p_observation,
    source_kind=p_source_kind,request_fingerprint=p_fingerprint,workload=p_workload where id=p_id;
  return true;
end $$;

create function public.intelligence_jev_claim(p_fingerprint text,p_purpose text,p_company uuid default null,
  p_observation uuid default null,p_source_kind text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; v_reservation uuid := gen_random_uuid(); v_lease uuid := gen_random_uuid();
begin
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_purpose is null or p_purpose not in ('public_interpretation','research_ranking','saved_view') then
    raise exception 'Invalid cache request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('jev:' || p_fingerprint,0));
  select * into r from intelligence_jev_requests where fingerprint=p_fingerprint for update;
  if found then
    if r.company_id is distinct from p_company or r.purpose<>p_purpose then raise exception 'Request scope mismatch'; end if;
    if r.state='complete' or (r.state='failed' and r.settled_at is null) then
      update intelligence_jev_requests set reuse_count=reuse_count+1,last_reused_at=now() where fingerprint=p_fingerprint;
      return jsonb_build_object('status','complete','evaluation',r.evaluation,'reservationId',r.reservation_id,'reused',true);
    end if;
    if r.state='running' and r.lease_until>now() then return jsonb_build_object('status','busy'); end if;
    -- An expired in-flight acceptance is uncertain, not free. Preserve its full
    -- reservation before a new, separately accounted attempt can be made.
    if r.state='running' then perform intelligence_settle(r.reservation_id,null,null); end if;
  end if;
  if not intelligence_reserve_jev(v_reservation,0.002753,p_purpose,p_company,p_observation,
    p_source_kind,p_fingerprint,p_workload) then return jsonb_build_object('status','budget_deferred'); end if;
  insert into intelligence_jev_requests(fingerprint,purpose,company_id,observation_id,source_kind,workload,
    state,reservation_id,lease_token,lease_until)
  values(p_fingerprint,p_purpose,p_company,p_observation,p_source_kind,p_workload,
    'running',v_reservation,v_lease,now()+interval '2 minutes')
  on conflict(fingerprint) do update set state='running',reservation_id=v_reservation,lease_token=v_lease,
    lease_until=excluded.lease_until,evaluation=null,completed_at=null,settled_at=null,
    observation_id=p_observation,source_kind=p_source_kind,workload=p_workload;
  return jsonb_build_object('status','execute','reservationId',v_reservation,'leaseToken',v_lease);
end $$;

create function public.intelligence_jev_record(p_fingerprint text,p_lease uuid,p_reservation uuid,p_evaluation jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(p_evaluation)<>'object' or jsonb_typeof(p_evaluation->'ok') is distinct from 'boolean'
    or octet_length(p_evaluation::text)>524288 then raise exception 'Invalid Jev receipt'; end if;
  -- This RPC only commits the answer. Accounting is a subsequent transaction.
  update intelligence_jev_requests set evaluation=p_evaluation,
    state=case when (p_evaluation->>'ok')::boolean then 'complete' else 'failed' end,
    completed_at=now()
    where fingerprint=p_fingerprint and lease_token=p_lease and reservation_id=p_reservation and state='running';
  if found then return true; end if;
  -- A response-lost database retry must not overwrite or lose a committed receipt.
  return exists(select 1 from intelligence_jev_requests where fingerprint=p_fingerprint and lease_token=p_lease
    and reservation_id=p_reservation and evaluation=p_evaluation and state in ('complete','failed'));
end $$;

create function public.intelligence_jev_settle(p_fingerprint text,p_reservation uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; v_tokens bigint; v_actual numeric;
begin
  select * into r from intelligence_jev_requests where fingerprint=p_fingerprint and reservation_id=p_reservation for update;
  if not found or r.state='running' or r.evaluation is null then return false; end if;
  if r.settled_at is not null then return true; end if;
  if jsonb_typeof(r.evaluation#>'{usage,inputTokens}')='number' then
    v_tokens := (r.evaluation#>>'{usage,inputTokens}')::bigint;
    if v_tokens<0 then raise exception 'Invalid usage'; end if;
    v_actual := ceil(v_tokens*0.042)/1000000;
  end if;
  perform intelligence_settle(p_reservation,v_actual,v_tokens);
  if not exists(select 1 from intelligence_spend where id=p_reservation and state='settled') then return false; end if;
  update intelligence_jev_requests set settled_at=now() where fingerprint=p_fingerprint;
  return true;
end $$;

alter table public.intelligence_jev_requests enable row level security;
revoke all on public.intelligence_jev_requests from public,anon,authenticated;
grant all on public.intelligence_jev_requests to service_role;
do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace
    and proname in ('intelligence_reserve_jev','intelligence_jev_claim','intelligence_jev_record','intelligence_jev_settle') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
