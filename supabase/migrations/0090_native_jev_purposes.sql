-- Native questions share existing accounting; private answers remain local.
begin;
alter table public.intelligence_jev_requests drop constraint intelligence_jev_requests_purpose_check;
alter table public.intelligence_jev_requests add constraint intelligence_jev_requests_purpose_check check (purpose in ('public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector'));
create or replace function public.intelligence_reserve_jev(p_id uuid,p_amount numeric,p_purpose text,
  p_company uuid default null,p_observation uuid default null,p_source_kind text default null,
  p_fingerprint text default null,p_workload text default 'unattributed')
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_purpose not in ('public_interpretation','research_ranking','saved_view','private_tam','federal_identity','event_match','codex_connector')
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

create or replace function public.intelligence_jev_claim(p_fingerprint text,p_purpose text,p_company uuid default null,
  p_observation uuid default null,p_source_kind text default null,p_workload text default 'unattributed')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r intelligence_jev_requests%rowtype; v_reservation uuid := gen_random_uuid(); v_lease uuid := gen_random_uuid();
begin
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_purpose is null or p_purpose not in ('public_interpretation','research_ranking','saved_view','federal_identity','event_match','codex_connector') then
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
commit;
