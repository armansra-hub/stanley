-- Preserve the already approved three-slot policy across exact successors.
-- Generic/new runs retain one slot. No slug-prefix or caller-supplied opt-in.
begin;
alter table public.tam_regrade_runs add column max_active_leases integer not null default 1
 check (max_active_leases between 1 and 3);

-- Existing successors qualify only through a completed canonical seed and its
-- source-bound carry-forward event. UNION prevents cycles/duplicate ancestry.
with recursive edges as (
 select child.id child_id,parent.id parent_id
 from public.tam_regrade_runs child
 join public.tam_regrade_checkpoint_seeds cs on cs.id=child.completed_checkpoint_seed_id
  and cs.run_id=child.id and cs.status='complete'
 join public.tam_regrade_events event on event.run_id=child.id and event.kind='checkpoint.successor_carried_forward'
  and event.metadata->>'manifestSha256'=cs.manifest_sha256
  and event.metadata->>'inputSha256' ~ '^[a-f0-9]{64}$'
  and event.metadata->>'copied'=cs.expected_counts->>'currentTotal'
 join public.tam_regrade_runs parent on parent.id::text=event.metadata->>'predecessorRunId'
  and parent.id<>child.id and parent.search_id=child.search_id
  and parent.source_snapshot_sha256=child.source_snapshot_sha256
 join public.tam_regrade_checkpoint_seeds ps on ps.id=parent.completed_checkpoint_seed_id
  and ps.run_id=parent.id and ps.status='complete'
  and ps.id::text=event.metadata->>'predecessorSeedId'
 where child.mission#>>'{changedEvidence,predecessorRunId}'=parent.id::text
  and child.mission#>>'{changedEvidence,evidenceIndexSha256}'=cs.source_hashes->>'evidenceIndex'
  and child.mission#>>'{changedEvidence,registrationSha256}'=cs.source_hashes->>'registrations'
), authorized(id) as (
 select id from public.tam_regrade_runs
 where slug in ('ars-bs-tam-2026-09-17','ars-bs-tam-2026-09-19-jev')
 union
 select e.child_id from edges e join authorized a on a.id=e.parent_id
)
update public.tam_regrade_runs r set max_active_leases=3
where r.id in (select id from authorized);

create or replace function public.tam_initialize_changed_successor(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare
 predecessor tam_regrade_runs; successor tam_regrade_runs; predecessor_seed tam_regrade_checkpoint_seeds;
 control jsonb:=p_input->'seed'; boot jsonb:=p_input->'bootstrap'; manifest jsonb;
 bindings jsonb:=p_input->'expectedPredecessorBindings'; changes jsonb:=p_input->'changes';
 input_hash text; existing_hash text; counts jsonb; hashes jsonb; result jsonb; total integer;
begin
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>4000000
  or jsonb_typeof(bindings) is distinct from 'array' or jsonb_array_length(bindings) not between 1 and 10000
  or jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) not between 1 and 200
  or jsonb_typeof(control) is distinct from 'object' or jsonb_typeof(boot) is distinct from 'object'
  or p_input->>'action' is distinct from 'evidence_successor_initialize' then raise exception 'invalid bounded successor request'; end if;
 if boot->>'runSlug' is null or length(boot->>'runSlug') not between 1 and 200
  or boot->>'runSlug' is distinct from control->>'runSlug' or boot->>'runSlug'=p_input->>'predecessorRunSlug'
  or control->>'manifestSha256' is null or control->>'manifestSha256' !~ '^[a-f0-9]{64}$'
  or p_input->>'manifestCanonicalJson' is null then raise exception 'invalid successor identity'; end if;
 manifest:=(p_input->>'manifestCanonicalJson')::jsonb;
 if manifest->>'schema' is distinct from 'tam-successor-checkpoint-manifest'
  or manifest->>'runSlug' is distinct from boot->>'runSlug'
  or manifest->>'historicalRunSlug' is distinct from p_input->>'predecessorRunSlug'
  or encode(sha256(convert_to(p_input->>'manifestCanonicalJson','UTF8')),'hex') is distinct from control->>'manifestSha256'
  or exists(select 1 from unnest(array['releaseCommit','expectedCounts','cohortHashes','captureSnapshotHashes','sourceHashes']) k
    where manifest->k is distinct from control->k) then raise exception 'exact successor manifest differs'; end if;
 if exists(select 1 from jsonb_array_elements(bindings) b where b->>'internalId' is null or b->>'internalId' !~ '^[0-9]+$'
   or b->>'sha256' is null or b->>'sha256' !~ '^[a-f0-9]{64}$')
  or (select count(distinct b->>'internalId') from jsonb_array_elements(bindings) b)<>jsonb_array_length(bindings)
  or (select count(distinct c->>'internalId') from jsonb_array_elements(changes) c)<>jsonb_array_length(changes)
  or (select count(distinct c->>'receiptId') from jsonb_array_elements(changes) c)<>jsonb_array_length(changes)
 then raise exception 'invalid or duplicate successor bindings'; end if;
 input_hash:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('tam-evidence-successor:'||(boot->>'runSlug'),0));
 select * into successor from tam_regrade_runs where slug=boot->>'runSlug' for update;
 if found then
  select metadata->>'inputSha256' into existing_hash from tam_regrade_events
   where run_id=successor.id and kind='checkpoint.successor_carried_forward' order by created_at limit 1;
  if existing_hash is distinct from input_hash then raise exception 'successor already exists with different or unproven bulk initialization'; end if;
  result:=begin_tam_regrade_checkpoint_seed(successor.slug,control->>'actorKey',control->>'manifestSha256',
   control->>'manifestObjectPath',control->>'releaseCommit',control->'expectedCounts',control->'cohortHashes',control->'captureSnapshotHashes',control->'sourceHashes');
  return jsonb_build_object('run',to_jsonb(successor),'seed',result,'copied',jsonb_array_length(bindings),'changed',jsonb_array_length(changes));
 end if;
 select * into predecessor from tam_regrade_runs where slug=p_input->>'predecessorRunSlug' for update;
 if not found or predecessor.status not in ('paused','complete') then raise exception 'paused or completed predecessor required'; end if;
 select * into predecessor_seed from tam_regrade_checkpoint_seeds where id=(p_input->>'predecessorSeedId')::uuid
  and run_id=predecessor.id and status='complete';
 if not found or predecessor.completed_checkpoint_seed_id is distinct from predecessor_seed.id then raise exception 'exact completed predecessor seed required'; end if;
 if predecessor.search_id is distinct from boot->>'searchId' or predecessor.source_total is distinct from (boot->>'sourceTotal')::int
  or predecessor.source_snapshot_sha256 is distinct from boot->>'sourceSnapshotSha256'
  or boot#>>'{mission,changedEvidence,predecessorRunId}' is distinct from predecessor.id::text
  or boot#>>'{mission,changedEvidence,evidenceIndexSha256}' is distinct from control#>>'{sourceHashes,evidenceIndex}'
  or boot#>>'{mission,changedEvidence,registrationSha256}' is distinct from control#>>'{sourceHashes,registrations}'
 then raise exception 'successor source authority differs'; end if;
 -- Lock the exact predecessor set before comparing hashes and copying. No
 -- record, PDF or source provenance from the predecessor is modified.
 perform 1 from tam_regrade_records where run_id=predecessor.id order by netsuite_internal_id for update;
 select count(*) into total from tam_regrade_records where run_id=predecessor.id and is_current;
 if total<>jsonb_array_length(bindings) or total<>(control#>>'{expectedCounts,currentTotal}')::int
  or exists(select 1 from tam_regrade_records where run_id=predecessor.id and
   (grade_status in ('reading','final')
    or ((claim_token is not null or claim_actor is not null or claim_expires_at is not null
      or claim_started_at is not null or claim_heartbeat_at is not null)
     and not (grade_status='published' and validation_status='passed' and published_at is not null))))
 then raise exception 'predecessor membership or idle boundary differs'; end if;
 if exists(select 1 from tam_regrade_records r left join jsonb_array_elements(bindings) b on b->>'internalId'=r.netsuite_internal_id
  where r.run_id=predecessor.id and r.is_current and (b is null or b->>'sha256' is distinct from tam_successor_predecessor_binding(r)
    or r.checkpoint_seed_id is distinct from predecessor_seed.id or r.pdf_status<>'verified' or r.pdf_error is not null
    or r.company_id is distinct from tam_canonical_company_id(r.netsuite_internal_id)
    or r.grade_status not in ('pending','hold','published')
    or (r.grade_status='published' and (r.validation_status<>'passed' or r.grade_provenance_sha256 is null
      or encode(sha256(convert_to(r.grade_provenance_canonical_json,'UTF8')),'hex') is distinct from r.grade_provenance_sha256
      or r.grade_provenance_canonical_json::jsonb is distinct from r.grade_provenance
      or r.grade_provenance->>'pdfSha256' is distinct from r.pdf_sha256))))
 then raise exception 'predecessor exact evidence binding changed'; end if;
 perform 1 from tam_evidence_change_receipts where id in (select (c->>'receiptId')::uuid from jsonb_array_elements(changes) c) for update;
 if exists(select 1 from jsonb_array_elements(changes) c
  left join tam_evidence_change_receipts e on e.id=(c->>'receiptId')::uuid
  left join tam_regrade_records r on r.run_id=predecessor.id and r.netsuite_internal_id=c->>'internalId'
  where e.id is null or r.netsuite_internal_id is null or not r.is_current or r.grade_status<>'published'
   or e.status<>'observed' or e.predecessor_run_id<>predecessor.id or e.predecessor_seed_id<>predecessor_seed.id
   or e.netsuite_internal_id is distinct from r.netsuite_internal_id or e.company_id is distinct from r.company_id
   or e.predecessor_provenance_sha256 is distinct from r.grade_provenance_sha256
   or e.record_text_sha256 is distinct from c->>'recordTextSha256' or e.captured_at is null
   or e.previous_record_text_sha256 is distinct from r.grade_provenance->>'recordTextSha256'
   or e.record_text_sha256=e.previous_record_text_sha256
   or c->>'pdfSha256' is null or c->>'pdfSha256' !~ '^[a-f0-9]{64}$' or c->>'pdfSha256'=r.pdf_sha256
   or c->>'pdfObjectPath' is null or length(c->>'pdfObjectPath') not between 1 and 2048
   or c->>'pdfObjectPath'=r.pdf_object_path or c->>'pdfObjectPath' ~ E'(^[/\\\\]|^[A-Za-z]:|[\\r\\n]|(^|[/\\\\])\\.\\.([/\\\\]|$))'
   or c->>'pdfPageCount' is null or (c->>'pdfPageCount')::int not between 1 and 100000
   or c->>'pdfVerifiedAt' is null or (c->>'pdfVerifiedAt')::timestamptz<e.captured_at
   or c->>'pdfCaptureSnapshotSha256' is distinct from predecessor.source_snapshot_sha256)
 then raise exception 'exact fresh changed evidence receipt/PDF differs'; end if;
 -- Expected canonical cohorts are derived from the locked predecessor. The
 -- ordinary seeder will independently check these hashes and published data.
 with rows as (select r.netsuite_internal_id,r.membership_ordinal,
  case when c is not null then 'unrepresented' when r.grade_status='published' then 'publishedComplete'
   when r.grade_status='hold' then 'activeHold' else 'unrepresented' end cohort
  from tam_regrade_records r left join jsonb_array_elements(changes) c on c->>'internalId'=r.netsuite_internal_id
  where r.run_id=predecessor.id and r.is_current)
 select jsonb_build_object('currentTotal',count(*),'removedTotal',0,'pdfVerified',count(*),'publishedComplete',count(*) filter(where cohort='publishedComplete'),
  'legacySchemaRecovery',0,'lostStagingRecovery',0,'activeHold',count(*) filter(where cohort='activeHold'),'unrepresented',count(*) filter(where cohort='unrepresented')),
  jsonb_build_object('current',encode(sha256(convert_to(coalesce(string_agg(netsuite_internal_id||E'\n','' order by membership_ordinal),''),'UTF8')),'hex'),
  'removed',encode(sha256(''::bytea),'hex'),'legacySchemaRecovery',encode(sha256(''::bytea),'hex'),'lostStagingRecovery',encode(sha256(''::bytea),'hex'),
  'publishedComplete',encode(sha256(convert_to(coalesce(string_agg(netsuite_internal_id||E'\n','' order by membership_ordinal) filter(where cohort='publishedComplete'),''),'UTF8')),'hex'),
  'activeHold',encode(sha256(convert_to(coalesce(string_agg(netsuite_internal_id||E'\n','' order by membership_ordinal) filter(where cohort='activeHold'),''),'UTF8')),'hex'),
  'unrepresented',encode(sha256(convert_to(coalesce(string_agg(netsuite_internal_id||E'\n','' order by membership_ordinal) filter(where cohort='unrepresented'),''),'UTF8')),'hex')) into counts,hashes from rows;
 if counts is distinct from control->'expectedCounts' or hashes is distinct from control->'cohortHashes'
  or control#>>'{captureSnapshotHashes,current}' is distinct from predecessor.source_snapshot_sha256
 then raise exception 'successor expected cohort manifest differs'; end if;
 perform bootstrap_tam_regrade_run(boot->>'runSlug',boot->>'searchId',boot->'mission','capturing',(boot->>'sourceTotal')::int,boot->>'sourceSnapshotSha256');
 select * into successor from tam_regrade_runs where slug=boot->>'runSlug';
 update tam_regrade_runs set max_active_leases=predecessor.max_active_leases
 where id=successor.id returning * into successor;
 insert into tam_regrade_records(run_id,netsuite_internal_id,company_id,company_name,is_current,membership_status,table_row,source_page,source_row,
  table_rows,source_coordinates,saved_search_row_count,table_rows_sha256,pdf_status,pdf_object_path,pdf_sha256,pdf_page_count,pdf_verified_at,pdf_error,last_actor)
 select successor.id,r.netsuite_internal_id,r.company_id,r.company_name,true,r.membership_status,r.table_row,r.source_page,r.source_row,
  r.table_rows,r.source_coordinates,r.saved_search_row_count,r.table_rows_sha256,'verified',
  coalesce(c->>'pdfObjectPath',r.pdf_object_path),coalesce(c->>'pdfSha256',r.pdf_sha256),coalesce((c->>'pdfPageCount')::int,r.pdf_page_count),
  coalesce((c->>'pdfVerifiedAt')::timestamptz,r.pdf_verified_at),null,control->>'actorKey'
 from tam_regrade_records r left join jsonb_array_elements(changes) c on c->>'internalId'=r.netsuite_internal_id
 where r.run_id=predecessor.id and r.is_current;
 result:=begin_tam_regrade_checkpoint_seed(successor.slug,control->>'actorKey',control->>'manifestSha256',
  control->>'manifestObjectPath',control->>'releaseCommit',control->'expectedCounts',control->'cohortHashes',control->'captureSnapshotHashes',control->'sourceHashes');
 insert into tam_regrade_events(run_id,actor_key,kind,summary,metadata) values(successor.id,control->>'actorKey',
  'checkpoint.successor_carried_forward','Copied exact predecessor membership/PDF bindings; canonical seed import and finalization remain required.',
  jsonb_build_object('inputSha256',input_hash,'predecessorRunId',predecessor.id,'predecessorSeedId',predecessor_seed.id,
   'manifestSha256',control->>'manifestSha256','copied',total,'changed',jsonb_array_length(changes),
   'maxActiveLeases',successor.max_active_leases));
 return jsonb_build_object('run',to_jsonb(successor),'seed',result,'copied',total,'changed',jsonb_array_length(changes));
end $$;

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
  v_max_active_leases integer;
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

  select id, status, max_active_leases into v_run_id, v_run_status, v_max_active_leases from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  if v_run_status <> 'grading' then raise exception 'TAM regrade run % is %, not grading', p_run_slug, v_run_status; end if;
  -- The run-row lock above serializes capacity admission and actor ownership.
  -- Capacity is inherited only through the exact canonical successor lifecycle.
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
  ) >= v_max_active_leases then
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

notify pgrst,'reload schema';
commit;

