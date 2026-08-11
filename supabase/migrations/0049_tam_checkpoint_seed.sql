-- 0049: import the already-verified TAM checkpoint into coordination without
-- rewriting live company scores, then enforce recovery-cohort claim order.

alter table tam_regrade_records
  add column if not exists membership_ordinal int,
  add column if not exists recovery_cohort text,
  add column if not exists checkpoint_seed_id uuid,
  add column if not exists checkpoint_artifact_sha256 text,
  add column if not exists checkpoint_payload_sha256 text,
  add column if not exists checkpoint_source_hashes jsonb not null default '{}'::jsonb,
  add column if not exists publication_origin text,
  add column if not exists historical_published_at timestamptz,
  add column if not exists checkpoint_seeded_at timestamptz;

alter table tam_regrade_records
  drop constraint if exists tam_regrade_records_membership_ordinal_check,
  add constraint tam_regrade_records_membership_ordinal_check
    check (membership_ordinal is null or membership_ordinal > 0),
  drop constraint if exists tam_regrade_records_recovery_cohort_check,
  add constraint tam_regrade_records_recovery_cohort_check
    check (
      recovery_cohort is null
      or recovery_cohort in (
        'published_complete',
        'legacy_schema_recovery',
        'lost_staging_recovery',
        'active_hold',
        'unrepresented'
      )
    ),
  drop constraint if exists tam_regrade_records_checkpoint_artifact_sha_check,
  add constraint tam_regrade_records_checkpoint_artifact_sha_check
    check (
      checkpoint_artifact_sha256 is null
      or checkpoint_artifact_sha256 ~ '^[0-9a-f]{64}$'
    ),
  drop constraint if exists tam_regrade_records_checkpoint_payload_sha_check,
  add constraint tam_regrade_records_checkpoint_payload_sha_check
    check (
      checkpoint_payload_sha256 is null
      or checkpoint_payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  drop constraint if exists tam_regrade_records_checkpoint_source_hashes_check,
  add constraint tam_regrade_records_checkpoint_source_hashes_check
    check (jsonb_typeof(checkpoint_source_hashes) = 'object'),
  drop constraint if exists tam_regrade_records_publication_origin_check,
  add constraint tam_regrade_records_publication_origin_check
    check (
      publication_origin is null
      or publication_origin in ('historical_live_import', 'coordinator')
    );

create unique index if not exists tam_regrade_records_current_ordinal_uidx
  on tam_regrade_records (run_id, membership_ordinal)
  where is_current and membership_ordinal is not null;

create index if not exists tam_regrade_records_recovery_queue_idx
  on tam_regrade_records (run_id, recovery_cohort, grade_status, membership_ordinal)
  where is_current;

create table if not exists tam_regrade_checkpoint_seeds (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null unique references tam_regrade_runs(id) on delete restrict,
  seed_token          uuid not null unique default gen_random_uuid(),
  actor_key           text not null,
  status              text not null default 'building'
                      check (status in ('building', 'complete')),
  manifest_sha256     text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_object_path text not null check (nullif(btrim(manifest_object_path), '') is not null),
  release_commit      text not null check (release_commit ~ '^[0-9a-f]{40}$'),
  expected_counts     jsonb not null check (jsonb_typeof(expected_counts) = 'object'),
  cohort_hashes       jsonb not null check (jsonb_typeof(cohort_hashes) = 'object'),
  capture_snapshot_hashes jsonb not null check (jsonb_typeof(capture_snapshot_hashes) = 'object'),
  source_hashes       jsonb not null default '{}'::jsonb check (jsonb_typeof(source_hashes) = 'object'),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  updated_at          timestamptz not null default now(),
  check ((status = 'complete') = (completed_at is not null))
);

alter table tam_regrade_records
  drop constraint if exists tam_regrade_records_checkpoint_seed_fkey,
  add constraint tam_regrade_records_checkpoint_seed_fkey
    foreign key (checkpoint_seed_id)
    references tam_regrade_checkpoint_seeds(id)
    on delete restrict;

alter table tam_regrade_runs
  add column if not exists completed_checkpoint_seed_id uuid;

alter table tam_regrade_runs
  drop constraint if exists tam_regrade_runs_completed_checkpoint_seed_fkey,
  add constraint tam_regrade_runs_completed_checkpoint_seed_fkey
    foreign key (completed_checkpoint_seed_id)
    references tam_regrade_checkpoint_seeds(id)
    on delete restrict;

create or replace function tam_regrade_checkpoint_seed_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tam_regrade_checkpoint_seed_updated_at on tam_regrade_checkpoint_seeds;
create trigger tam_regrade_checkpoint_seed_updated_at
before update on tam_regrade_checkpoint_seeds
for each row execute function tam_regrade_checkpoint_seed_set_updated_at();

create or replace function tam_regrade_checkpoint_seed_is_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'TAM checkpoint seed control rows cannot be deleted';
  end if;
  if old.status = 'complete' then
    raise exception 'completed TAM checkpoint seed control rows are immutable';
  end if;
  if new.id is distinct from old.id
     or new.run_id is distinct from old.run_id
     or new.seed_token is distinct from old.seed_token
     or new.actor_key is distinct from old.actor_key
     or new.manifest_sha256 is distinct from old.manifest_sha256
     or new.manifest_object_path is distinct from old.manifest_object_path
     or new.release_commit is distinct from old.release_commit
     or new.expected_counts is distinct from old.expected_counts
     or new.cohort_hashes is distinct from old.cohort_hashes
     or new.capture_snapshot_hashes is distinct from old.capture_snapshot_hashes
     or new.source_hashes is distinct from old.source_hashes
     or new.created_at is distinct from old.created_at then
    raise exception 'TAM checkpoint seed identity, token, manifest, hashes and counts are immutable';
  end if;
  if new.status <> 'complete'
     or new.completed_at is null
     or old.completed_at is not null then
    raise exception 'the only checkpoint seed mutation is building to complete once';
  end if;
  if current_setting('stanley.tam_checkpoint_finalize_token', true)
     is distinct from old.seed_token::text then
    raise exception 'checkpoint seed completion is allowed only inside the fenced finalize RPC';
  end if;
  return new;
end;
$$;

drop trigger if exists tam_regrade_checkpoint_seed_immutable on tam_regrade_checkpoint_seeds;
create trigger tam_regrade_checkpoint_seed_immutable
before update or delete on tam_regrade_checkpoint_seeds
for each row execute function tam_regrade_checkpoint_seed_is_immutable();

-- A run cannot enter grading before the exact checkpoint is complete. Once a
-- seed starts, its membership authority and mission cannot be silently changed.
create or replace function tam_regrade_guard_seeded_run()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seed tam_regrade_checkpoint_seeds%rowtype;
  v_has_seed boolean := false;
  v_current int;
  v_removed int;
  v_seeded int;
  v_unpublished int;
  v_current_hash text;
  v_removed_hash text;
  v_complete_hash text;
  v_legacy_hash text;
  v_lost_hash text;
  v_hold_hash text;
  v_unrepresented_hash text;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.slug is distinct from old.slug
    or new.created_at is distinct from old.created_at
  ) then raise exception 'TAM run identity, slug and creation time are immutable'; end if;

  select * into v_seed from tam_regrade_checkpoint_seeds s where s.run_id = new.id;
  v_has_seed := found;

  if tg_op = 'UPDATE'
     and v_has_seed
     and (
       new.search_id is distinct from old.search_id
       or new.mission is distinct from old.mission
       or new.source_total is distinct from old.source_total
       or new.source_snapshot_sha256 is distinct from old.source_snapshot_sha256
     ) then
    raise exception 'TAM run membership authority is immutable after checkpoint seed begins';
  end if;

  if tg_op = 'UPDATE'
     and old.completed_checkpoint_seed_id is not null
     and new.completed_checkpoint_seed_id is distinct from old.completed_checkpoint_seed_id then
    raise exception 'completed TAM checkpoint seed is immutable';
  end if;

  if new.completed_checkpoint_seed_id is not null and not exists (
    select 1
    from tam_regrade_checkpoint_seeds s
    where s.id = new.completed_checkpoint_seed_id
      and s.run_id = new.id
      and s.status = 'complete'
  ) then
    raise exception 'completed checkpoint seed must belong to this run and be complete';
  end if;

  if new.status = 'grading' and new.completed_checkpoint_seed_id is null then
    raise exception 'TAM run cannot enter grading before checkpoint seed finalization';
  end if;

  if new.status = 'complete' and new.completed_checkpoint_seed_id is null then
    raise exception 'TAM run cannot complete before checkpoint seed finalization';
  end if;

  if v_has_seed and v_seed.status = 'building' then
    if new.completed_checkpoint_seed_id is not null or new.status <> 'capturing' then
      raise exception 'a building TAM checkpoint seed requires the run to remain capturing';
    end if;
  elsif v_has_seed and v_seed.status = 'complete' then
    if new.completed_checkpoint_seed_id is distinct from v_seed.id then
      raise exception 'seeded TAM run must retain its exact completed checkpoint';
    end if;
    if tg_op = 'UPDATE' and not (
      (old.status = 'capturing' and new.status = 'grading')
      or (old.status = 'grading' and new.status in ('grading','paused','failed','complete'))
      or (old.status = 'paused' and new.status in ('paused','grading','failed','complete'))
      or (old.status = 'failed' and new.status = 'failed')
      or (old.status = 'complete' and new.status = 'complete')
    ) then
      raise exception 'invalid seeded TAM run status transition from % to %', old.status, new.status;
    end if;
    if tg_op = 'UPDATE'
       and old.status = 'capturing'
       and new.status = 'grading'
       and current_setting('stanley.tam_checkpoint_finalize_token', true)
         is distinct from v_seed.seed_token::text then
      raise exception 'capturing to grading is allowed only inside the fenced checkpoint finalize RPC';
    end if;
  end if;

  if new.status = 'complete' then
    select
      count(*) filter (where r.is_current),
      count(*) filter (where not r.is_current and r.membership_status = 'removed'),
      count(*) filter (where r.is_current and r.checkpoint_seed_id = v_seed.id),
      count(*) filter (where r.is_current and r.grade_status <> 'published')
      into v_current, v_removed, v_seeded, v_unpublished
    from tam_regrade_records r where r.run_id = new.id;
    if v_current <> (v_seed.expected_counts->>'currentTotal')::int
       or v_seeded <> v_current
       or v_unpublished <> 0
       or v_removed <> (v_seed.expected_counts->>'removedTotal')::int
       or exists (
         select 1 from tam_regrade_records r
         where r.run_id = new.id and r.is_current
           and r.grade_status in ('pending','reading','hold','final')
       ) then
      raise exception 'TAM run cannot complete until every exact current checkpoint record is published and unleased';
    end if;

    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_current_hash from tam_regrade_records r where r.run_id = new.id and r.is_current;
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by length(r.netsuite_internal_id), r.netsuite_internal_id), ''), 'UTF8'), 'sha256'), 'hex')
      into v_removed_hash from tam_regrade_records r
      where r.run_id = new.id and not r.is_current and r.membership_status = 'removed';
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_complete_hash from tam_regrade_records r where r.run_id = new.id and r.is_current and r.recovery_cohort = 'published_complete';
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_legacy_hash from tam_regrade_records r where r.run_id = new.id and r.is_current and r.recovery_cohort = 'legacy_schema_recovery';
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_lost_hash from tam_regrade_records r where r.run_id = new.id and r.is_current and r.recovery_cohort = 'lost_staging_recovery';
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_hold_hash from tam_regrade_records r where r.run_id = new.id and r.is_current and r.recovery_cohort = 'active_hold';
    select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
      into v_unrepresented_hash from tam_regrade_records r where r.run_id = new.id and r.is_current and r.recovery_cohort = 'unrepresented';
    if v_current_hash is distinct from v_seed.cohort_hashes->>'current'
       or v_removed_hash is distinct from v_seed.cohort_hashes->>'removed'
       or v_complete_hash is distinct from v_seed.cohort_hashes->>'publishedComplete'
       or v_legacy_hash is distinct from v_seed.cohort_hashes->>'legacySchemaRecovery'
       or v_lost_hash is distinct from v_seed.cohort_hashes->>'lostStagingRecovery'
       or v_hold_hash is distinct from v_seed.cohort_hashes->>'activeHold'
       or v_unrepresented_hash is distinct from v_seed.cohort_hashes->>'unrepresented' then
      raise exception 'TAM run completion checkpoint hashes drifted';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tam_regrade_runs_seed_guard on tam_regrade_runs;
create trigger tam_regrade_runs_seed_guard
before insert or update on tam_regrade_runs
for each row execute function tam_regrade_guard_seeded_run();

-- Beginning a seed freezes the run's actual membership/PDF evidence. The seed
-- batch may fill checkpoint metadata once while capturing; after finalization,
-- only the fenced grading lifecycle can change non-checkpoint grading fields.
create or replace function tam_regrade_freeze_seeded_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seed tam_regrade_checkpoint_seeds%rowtype;
  v_completed_seed_id uuid;
  v_workflow_changed boolean;
  v_run_id uuid;
begin
  v_run_id := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  select s.* into v_seed
  from tam_regrade_checkpoint_seeds s
  where s.run_id = v_run_id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'TAM membership is frozen after checkpoint seed begins; create a new run for a new snapshot';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'seeded TAM coordination records cannot be deleted';
  end if;

  if new.run_id is distinct from old.run_id
     or new.netsuite_internal_id is distinct from old.netsuite_internal_id
     or new.company_id is distinct from old.company_id
     or new.company_name is distinct from old.company_name
     or new.is_current is distinct from old.is_current
     or new.membership_status is distinct from old.membership_status
     or new.table_row is distinct from old.table_row
     or new.source_page is distinct from old.source_page
     or new.source_row is distinct from old.source_row
     or new.table_rows is distinct from old.table_rows
     or new.source_coordinates is distinct from old.source_coordinates
     or new.saved_search_row_count is distinct from old.saved_search_row_count
     or new.table_rows_sha256 is distinct from old.table_rows_sha256
     or new.pdf_status is distinct from old.pdf_status
     or new.pdf_object_path is distinct from old.pdf_object_path
     or new.pdf_sha256 is distinct from old.pdf_sha256
     or new.pdf_page_count is distinct from old.pdf_page_count
     or new.pdf_verified_at is distinct from old.pdf_verified_at
     or new.pdf_error is distinct from old.pdf_error then
    raise exception 'TAM membership and PDF evidence are immutable after checkpoint seed begins';
  end if;

  select r.completed_checkpoint_seed_id into v_completed_seed_id
  from tam_regrade_runs r where r.id = new.run_id;
  if v_completed_seed_id is null then
    if old.checkpoint_seed_id is null
       and new.checkpoint_seed_id = v_seed.id
       and current_setting('stanley.tam_checkpoint_batch_token', true)
         = v_seed.seed_token::text
       and new.membership_ordinal is not null
       and new.recovery_cohort is not null
       and new.checkpoint_payload_sha256 is not null
       and new.checkpoint_seeded_at is not null then
      return new;
    end if;
    raise exception 'checkpoint build permits only the first exact seed write per record';
  end if;

  if old.checkpoint_seed_id is distinct from v_completed_seed_id
     or new.checkpoint_seed_id is distinct from old.checkpoint_seed_id
     or new.membership_ordinal is distinct from old.membership_ordinal
     or new.recovery_cohort is distinct from old.recovery_cohort
     or new.checkpoint_artifact_sha256 is distinct from old.checkpoint_artifact_sha256
     or new.checkpoint_payload_sha256 is distinct from old.checkpoint_payload_sha256
     or new.checkpoint_source_hashes is distinct from old.checkpoint_source_hashes
     or new.checkpoint_seeded_at is distinct from old.checkpoint_seeded_at
     or new.historical_published_at is distinct from old.historical_published_at then
    raise exception 'completed TAM checkpoint membership, order and source metadata are immutable';
  end if;

  v_workflow_changed :=
    new.grade_status is distinct from old.grade_status
    or new.hold_reason is distinct from old.hold_reason
    or new.claim_actor is distinct from old.claim_actor
    or new.claim_token is distinct from old.claim_token
    or new.claim_generation is distinct from old.claim_generation
    or new.claim_started_at is distinct from old.claim_started_at
    or new.claim_heartbeat_at is distinct from old.claim_heartbeat_at
    or new.claim_expires_at is distinct from old.claim_expires_at
    or new.final_score is distinct from old.final_score
    or new.codex_score is distinct from old.codex_score
    or new.tam_score is distinct from old.tam_score
    or new.score_adjust_note is distinct from old.score_adjust_note
    or new.assessment_score_note is distinct from old.assessment_score_note
    or new.record_digest is distinct from old.record_digest
    or new.record_dead is distinct from old.record_dead
    or new.record_dead_reason is distinct from old.record_dead_reason
    or new.assessment_old_gold_score is distinct from old.assessment_old_gold_score
    or new.old_gold_class is distinct from old.old_gold_class
    or new.old_gold_reasons is distinct from old.old_gold_reasons
    or new.intro_call_exists is distinct from old.intro_call_exists
    or new.opportunity_exists is distinct from old.opportunity_exists
    or new.revisit_on is distinct from old.revisit_on
    or new.grade_provenance is distinct from old.grade_provenance
    or new.grade_provenance_object_path is distinct from old.grade_provenance_object_path
    or new.grade_provenance_canonical_json is distinct from old.grade_provenance_canonical_json
    or new.grade_provenance_sha256 is distinct from old.grade_provenance_sha256
    or new.validation_status is distinct from old.validation_status
    or new.validated_by is distinct from old.validated_by
    or new.validated_at is distinct from old.validated_at
    or new.graded_at is distinct from old.graded_at
    or new.published_at is distinct from old.published_at;
  if not v_workflow_changed then
    raise exception 'membership upsert/removal is forbidden for a seeded TAM run';
  end if;

  if new.grade_status = 'published' and old.grade_status <> 'published' then
    new.publication_origin := 'coordinator';
  elsif new.publication_origin is distinct from old.publication_origin then
    raise exception 'TAM publication origin is immutable outside the publish transition';
  end if;
  return new;
end;
$$;

drop trigger if exists tam_regrade_records_seed_freeze on tam_regrade_records;
create trigger tam_regrade_records_seed_freeze
before insert or update or delete on tam_regrade_records
for each row execute function tam_regrade_freeze_seeded_record();

-- The database, not the caller, owns recovery phase ordering. Work inside one
-- cohort may proceed in membership order chosen by the coordinator, but no
-- later cohort can start while an earlier cohort has an unpublished record.
create or replace function tam_regrade_enforce_checkpoint_claim_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_completed_seed_id uuid;
  v_requested_rank int;
  v_min_unfinished_rank int;
begin
  if new.grade_status <> 'reading' or old.grade_status = 'reading' then
    return new;
  end if;

  select completed_checkpoint_seed_id
    into v_completed_seed_id
  from tam_regrade_runs
  where id = new.run_id;

  if v_completed_seed_id is null
     or new.checkpoint_seed_id is distinct from v_completed_seed_id
     or new.recovery_cohort is null
     or new.membership_ordinal is null then
    raise exception 'TAM claim requires the completed exact checkpoint seed';
  end if;

  v_requested_rank := case new.recovery_cohort
    when 'legacy_schema_recovery' then 1
    when 'lost_staging_recovery' then 2
    when 'active_hold' then 3
    when 'unrepresented' then 4
    else null
  end;
  if v_requested_rank is null then
    raise exception 'checkpoint cohort % is not claimable', new.recovery_cohort;
  end if;

  select min(case r.recovery_cohort
    when 'legacy_schema_recovery' then 1
    when 'lost_staging_recovery' then 2
    when 'active_hold' then 3
    when 'unrepresented' then 4
    else null
  end)
    into v_min_unfinished_rank
  from tam_regrade_records r
  where r.run_id = new.run_id
    and r.is_current
    and r.checkpoint_seed_id = v_completed_seed_id
    and r.recovery_cohort <> 'published_complete'
    and r.grade_status <> 'published';

  if v_min_unfinished_rank is null then
    raise exception 'TAM checkpoint has no unfinished claimable records';
  end if;
  if v_requested_rank > v_min_unfinished_rank then
    raise exception 'TAM recovery cohort % is blocked by unfinished cohort rank %',
      new.recovery_cohort, v_min_unfinished_rank;
  end if;
  return new;
end;
$$;

drop trigger if exists tam_regrade_records_claim_order on tam_regrade_records;
create trigger tam_regrade_records_claim_order
before update of grade_status on tam_regrade_records
for each row execute function tam_regrade_enforce_checkpoint_claim_order();

create or replace function begin_tam_regrade_checkpoint_seed(
  p_run_slug text,
  p_actor_key text,
  p_manifest_sha256 text,
  p_manifest_object_path text,
  p_release_commit text,
  p_expected_counts jsonb,
  p_cohort_hashes jsonb,
  p_capture_snapshot_hashes jsonb,
  p_source_hashes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run tam_regrade_runs%rowtype;
  v_seed tam_regrade_checkpoint_seeds%rowtype;
  v_current int;
  v_expected_current int;
  v_expected_cohorts int;
  v_now timestamptz := now();
begin
  if nullif(btrim(p_actor_key), '') is null then raise exception 'actor key is required'; end if;
  if p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid checkpoint manifest SHA-256'; end if;
  if nullif(btrim(p_manifest_object_path), '') is null then raise exception 'checkpoint manifest object path is required'; end if;
  if p_release_commit is null or p_release_commit !~ '^[0-9a-f]{40}$' then raise exception 'full lowercase release commit is required'; end if;
  if jsonb_typeof(p_expected_counts) <> 'object' then raise exception 'checkpoint expected counts must be an object'; end if;
  if jsonb_typeof(p_cohort_hashes) <> 'object' then raise exception 'checkpoint cohort hashes must be an object'; end if;
  if jsonb_typeof(p_capture_snapshot_hashes) <> 'object' then raise exception 'checkpoint capture snapshot hashes must be an object'; end if;
  if jsonb_typeof(coalesce(p_source_hashes, '{}'::jsonb)) <> 'object' then raise exception 'checkpoint source hashes must be an object'; end if;
  if not (p_expected_counts ?& array[
    'currentTotal', 'removedTotal', 'pdfVerified', 'publishedComplete',
    'legacySchemaRecovery', 'lostStagingRecovery', 'activeHold', 'unrepresented'
  ]) or (select count(*) from jsonb_object_keys(p_expected_counts)) <> 8 or exists (
    select 1 from jsonb_each_text(p_expected_counts) c
    where c.key in (
      'currentTotal', 'removedTotal', 'pdfVerified', 'publishedComplete',
      'legacySchemaRecovery', 'lostStagingRecovery', 'activeHold', 'unrepresented'
    ) and c.value !~ '^[0-9]+$'
  ) then raise exception 'checkpoint expected counts are incomplete or invalid'; end if;
  if not (p_cohort_hashes ?& array[
    'current', 'removed', 'publishedComplete', 'legacySchemaRecovery',
    'lostStagingRecovery', 'activeHold', 'unrepresented'
  ]) or exists (
    select 1 from jsonb_each_text(p_cohort_hashes) h where h.value !~ '^[0-9a-f]{64}$'
  ) or (select count(*) from jsonb_each_text(p_cohort_hashes)) <> 7 then
    raise exception 'checkpoint requires exactly seven valid ordered-ID hashes';
  end if;
  if exists (
    select 1 from jsonb_each_text(coalesce(p_source_hashes, '{}'::jsonb)) h where h.value !~ '^[0-9a-f]{64}$'
  ) then raise exception 'checkpoint source hashes must all be lowercase SHA-256 values'; end if;
  if not (p_capture_snapshot_hashes ?& array['current', 'allowedPrior'])
     or (select count(*) from jsonb_object_keys(p_capture_snapshot_hashes)) <> 2
     or (p_capture_snapshot_hashes->>'current') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_capture_snapshot_hashes->'allowedPrior') <> 'array'
     or exists (
       select 1 from jsonb_array_elements_text(p_capture_snapshot_hashes->'allowedPrior') h
       where h !~ '^[0-9a-f]{64}$'
     ) then raise exception 'checkpoint capture snapshot whitelist is invalid'; end if;

  begin
    v_expected_current := (p_expected_counts->>'currentTotal')::int;
    v_expected_cohorts := (p_expected_counts->>'publishedComplete')::int
      + (p_expected_counts->>'legacySchemaRecovery')::int
      + (p_expected_counts->>'lostStagingRecovery')::int
      + (p_expected_counts->>'activeHold')::int
      + (p_expected_counts->>'unrepresented')::int;
  exception when others then
    raise exception 'checkpoint expected counts are incomplete or invalid';
  end;
  if v_expected_current <= 0 or v_expected_cohorts <> v_expected_current then
    raise exception 'checkpoint cohorts must exactly cover current membership';
  end if;
  if (p_expected_counts->>'pdfVerified')::int <> v_expected_current then
    raise exception 'checkpoint requires one verified PDF per current record';
  end if;
  if p_run_slug = 'ars-bs-tam-current' and (
    v_expected_current <> 6949
    or (p_expected_counts->>'publishedComplete')::int <> 2696
    or (p_expected_counts->>'legacySchemaRecovery')::int <> 2240
    or (p_expected_counts->>'lostStagingRecovery')::int <> 3
    or (p_expected_counts->>'activeHold')::int <> 49
    or (p_expected_counts->>'unrepresented')::int <> 1961
    or (p_expected_counts->>'removedTotal')::int <> 34
    or p_cohort_hashes->>'current' is distinct from '2294caa9c38d2302437a8fda18c54316c3416695d21871fd4b3ea9c6e58c7de9'
    or p_cohort_hashes->>'removed' is distinct from 'a9893713cabdcc6f053004a3fb0530aa84e6d9419fa6293496ded73f1ed19881'
    or p_cohort_hashes->>'publishedComplete' is distinct from '6e30f7747f5e3201954bb9fc82160484f97d19ad8a5af2590401be1c40a64d1d'
    or p_cohort_hashes->>'legacySchemaRecovery' is distinct from '57898de64e0f2d1d9dac20ccec39f66a2d804a7c2434f53648b0d58961bb4571'
    or p_cohort_hashes->>'lostStagingRecovery' is distinct from '1b3e140b16b9eab67747c285bd620e43d453a055cccbfb95b039afb2f425d840'
    or p_cohort_hashes->>'activeHold' is distinct from 'ca8778eb3f0416f9152186de207adeae779a09c79813e2ce83218fc14a7cda29'
    or p_cohort_hashes->>'unrepresented' is distinct from '08383fc5bed27d2691df5186ae481e13ff1bec986c4ba2793c163b2f89f7daa7'
    or p_capture_snapshot_hashes->>'current' is distinct from '1a539c7e3ffe8af9b44aa4e7d120449e6e7aed9f6932137caa7268da6993156e'
    or p_capture_snapshot_hashes->'allowedPrior' is distinct from '["e44d06e4d4b0a8146dbeb58eb99c0baf7ba1c93df402cb786429145b85246ca2"]'::jsonb
    or not (coalesce(p_source_hashes, '{}'::jsonb) ?& array[
      'pdf_reconciliation_manifest_sha256', 'coordination_membership_sha256',
      'coordination_removed_ids_sha256',
      'current_membership_sha256', 'current_pdf_inventory_sha256',
      'final_assessments_sha256', 'publish_queue_sha256', 'grading_manifest_sha256',
      'live_final_reconciliation_sha256', 'localEvidenceState', 'localEvidenceReceipt',
      'evidence_corpus_sha256', 'evidence_readback_sha256', 'checkpoint_rows_sha256'
    ])
    or (select count(*) from jsonb_object_keys(coalesce(p_source_hashes, '{}'::jsonb))) <> 14
    or p_source_hashes->>'pdf_reconciliation_manifest_sha256' is distinct from '5e3072347fd25ed56f2916b2f4485d0183a4ccf96e5b09bcdc02e1182d63e6ce'
    or p_source_hashes->>'current_membership_sha256' is distinct from '61708344dd9527141401c1b61dd36cc08c185d0efd418426f982364ed118bbfa'
    or p_source_hashes->>'current_pdf_inventory_sha256' is distinct from '25acada430c358dd43d324c362bda3f25986b7d8b95f45fd109671b5e918cd8c'
    or p_source_hashes->>'final_assessments_sha256' is distinct from '50586b401e3c455260bb90436b6bbcf43d049e8272750c14d83c1dd39344c0c1'
    or p_source_hashes->>'publish_queue_sha256' is distinct from 'd0134db0a745f024bccfaffdf3762eaac8e6bf1ed927f98956139cd3f47a75eb'
    or p_source_hashes->>'coordination_membership_sha256' is distinct from 'c907b130f6c064beca576520eaca82c325868c9df8fa039053b12ecda218d414'
    or p_source_hashes->>'coordination_removed_ids_sha256' is distinct from 'a95259f8634c8d1f63e9126dc3413ce94f59f051df42f95ffd0ac9d468a24eeb'
    or p_source_hashes->>'grading_manifest_sha256' is distinct from 'c0f3e809a4b06c48750e2783e6f386580a1026535ff948ee9eef31f904c000cf'
    or p_source_hashes->>'live_final_reconciliation_sha256' is distinct from 'df22e1336e885a4918ddff13c530acd8afaa262b55325f15c12af611e46924c3'
  ) then
    raise exception 'ars-bs-tam-current checkpoint counts/hashes differ from the audited immutable partition';
  end if;

  select * into v_run from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  if p_run_slug = 'ars-bs-tam-current' and (
    v_run.source_total is distinct from 7618
    or v_run.source_snapshot_sha256 is distinct from '1a539c7e3ffe8af9b44aa4e7d120449e6e7aed9f6932137caa7268da6993156e'
  ) then raise exception 'ars-bs-tam-current run source authority differs from the audited saved-search snapshot'; end if;
  select * into v_seed from tam_regrade_checkpoint_seeds where run_id = v_run.id for update;
  if found then
    if v_seed.actor_key is distinct from btrim(p_actor_key)
       or v_seed.manifest_sha256 is distinct from p_manifest_sha256
       or v_seed.manifest_object_path is distinct from btrim(p_manifest_object_path)
       or v_seed.release_commit is distinct from p_release_commit
       or v_seed.expected_counts is distinct from p_expected_counts
       or v_seed.cohort_hashes is distinct from p_cohort_hashes
       or v_seed.capture_snapshot_hashes is distinct from p_capture_snapshot_hashes
       or v_seed.source_hashes is distinct from coalesce(p_source_hashes, '{}'::jsonb) then
      raise exception 'checkpoint seed already exists with different immutable inputs';
    end if;
    if v_seed.status = 'building' and v_run.status <> 'capturing' then
      raise exception 'building checkpoint seed requires the run to remain capturing';
    end if;
    if v_seed.status = 'complete'
       and v_run.completed_checkpoint_seed_id is distinct from v_seed.id then
      raise exception 'completed checkpoint seed is not fenced into its TAM run';
    end if;
    if v_seed.status = 'building' and exists (
      select 1 from tam_regrade_records r
      where r.run_id = v_run.id and r.grade_status = 'reading'
    ) then raise exception 'checkpoint seed cannot run while any TAM record has a lease'; end if;
    return jsonb_build_object(
      'seedId', v_seed.id,
      'seedToken', v_seed.seed_token,
      'status', v_seed.status,
      'alreadyStarted', true
    );
  end if;

  if v_run.status not in ('initializing', 'capturing') then
    raise exception 'checkpoint seed requires an initializing or capturing TAM run';
  end if;
  if exists (
    select 1 from tam_regrade_records r
    where r.run_id = v_run.id and r.grade_status = 'reading'
  ) then raise exception 'checkpoint seed cannot run while any TAM record has a lease'; end if;
  select count(*) into v_current from tam_regrade_records r where r.run_id = v_run.id and r.is_current;
  if v_current <> v_expected_current then
    raise exception 'checkpoint expected % current IDs but coordination has %', v_expected_current, v_current;
  end if;

  insert into tam_regrade_checkpoint_seeds (
    run_id, actor_key, manifest_sha256, manifest_object_path, release_commit,
    expected_counts, cohort_hashes, capture_snapshot_hashes, source_hashes
  ) values (
    v_run.id, btrim(p_actor_key), p_manifest_sha256, btrim(p_manifest_object_path),
    p_release_commit, p_expected_counts, p_cohort_hashes, p_capture_snapshot_hashes,
    coalesce(p_source_hashes, '{}'::jsonb)
  ) returning * into v_seed;

  update tam_regrade_runs
  set status = 'capturing', last_heartbeat_at = v_now
  where id = v_run.id;
  insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
  values (
    v_run.id, p_actor_key, 'checkpoint.seed_started',
    format('Started exact TAM checkpoint seed %s', v_seed.id),
    jsonb_build_object(
      'seed_id', v_seed.id,
      'manifest_sha256', p_manifest_sha256,
      'release_commit', p_release_commit,
      'expected_counts', p_expected_counts,
      'cohort_hashes', p_cohort_hashes,
      'capture_snapshot_hashes', p_capture_snapshot_hashes
    )
  );
  return jsonb_build_object(
    'seedId', v_seed.id,
    'seedToken', v_seed.seed_token,
    'status', v_seed.status,
    'alreadyStarted', false
  );
end;
$$;

create or replace function seed_tam_regrade_checkpoint_batch(
  p_run_slug text,
  p_actor_key text,
  p_seed_token uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run tam_regrade_runs%rowtype;
  v_seed tam_regrade_checkpoint_seeds%rowtype;
  v_record tam_regrade_records%rowtype;
  v_company companies%rowtype;
  v_item jsonb;
  v_provenance jsonb;
  v_assessment jsonb;
  v_validation jsonb;
  v_source_hashes jsonb;
  v_internal_id text;
  v_cohort text;
  v_ordinal int;
  v_payload_sha text;
  v_artifact_sha text;
  v_table_rows_sha text;
  v_pdf_object_path text;
  v_pdf_sha text;
  v_pdf_page_count int;
  v_pdf_verified_at timestamptz;
  v_pdf_binding_sha text;
  v_pdf_capture_snapshot_sha text;
  v_final_score numeric;
  v_tam_score numeric;
  v_assessment_old_gold_score numeric;
  v_live_old_gold_score numeric;
  v_old_gold_class text;
  v_old_gold_reasons jsonb;
  v_intro_call_exists boolean;
  v_opportunity_exists boolean;
  v_revisit_on date;
  v_record_dead boolean;
  v_record_dead_reason text;
  v_record_digest text;
  v_assessment_score_note text;
  v_score_note text;
  v_hard_zero_reason text;
  v_old_gold_member boolean;
  v_canonical_json text;
  v_provenance_sha text;
  v_provenance_object_path text;
  v_validated_by text;
  v_validated_at timestamptz;
  v_historical_published_at timestamptz;
  v_hold_reason text;
  v_inserted int := 0;
  v_unchanged int := 0;
  v_now timestamptz := now();
begin
  if nullif(btrim(p_actor_key), '') is null or p_seed_token is null then raise exception 'actor and seed token are required'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 100 then
    raise exception 'checkpoint seed batch must contain 1-100 records';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) item
    group by item->>'netsuiteInternalId' having count(*) > 1
  ) then raise exception 'checkpoint batch repeats an exact Internal ID'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) item
    group by item->>'membershipOrdinal' having count(*) > 1
  ) then raise exception 'checkpoint batch repeats a membership ordinal'; end if;

  select * into v_run from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  select * into v_seed from tam_regrade_checkpoint_seeds
  where run_id = v_run.id for update;
  if not found
     or v_seed.seed_token is distinct from p_seed_token
     or v_seed.actor_key is distinct from btrim(p_actor_key) then
    raise exception 'checkpoint seed token is stale or unowned';
  end if;
  if v_seed.status <> 'building' then raise exception 'checkpoint seed is %, not building', v_seed.status; end if;
  if v_run.status <> 'capturing' then raise exception 'checkpoint seed requires the run to remain capturing'; end if;
  if exists (select 1 from tam_regrade_records r where r.run_id = v_run.id and r.grade_status = 'reading') then
    raise exception 'checkpoint seed cannot run while any TAM record has a lease';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_rows)
    order by (value->>'membershipOrdinal')::int
  loop
    v_internal_id := v_item->>'netsuiteInternalId';
    v_cohort := v_item->>'recoveryCohort';
    if v_internal_id is null or v_internal_id !~ '^[0-9]+$' then raise exception 'checkpoint contains an invalid exact Internal ID'; end if;
    if (v_item->>'membershipOrdinal') !~ '^[1-9][0-9]*$' then raise exception 'checkpoint ordinal is invalid for %', v_internal_id; end if;
    v_ordinal := (v_item->>'membershipOrdinal')::int;
    if v_ordinal > (v_seed.expected_counts->>'currentTotal')::int then raise exception 'checkpoint ordinal is out of range for %', v_internal_id; end if;
    if v_cohort not in ('published_complete','legacy_schema_recovery','lost_staging_recovery','active_hold','unrepresented') then
      raise exception 'checkpoint recovery cohort is invalid for %', v_internal_id;
    end if;
    v_payload_sha := encode(digest(convert_to(v_item::text, 'UTF8'), 'sha256'), 'hex');

    select * into v_record from tam_regrade_records
    where run_id = v_run.id and netsuite_internal_id = v_internal_id
    for update;
    if not found or not v_record.is_current or v_record.membership_status = 'removed' then
      raise exception 'checkpoint exact current record not found: %', v_internal_id;
    end if;
    if v_record.company_id is null or tam_canonical_company_id(v_internal_id) is distinct from v_record.company_id then
      raise exception 'checkpoint record % lacks one exact canonical company mapping', v_internal_id;
    end if;
    v_table_rows_sha := v_item->>'tableRowsSha256';
    if v_table_rows_sha !~ '^[0-9a-f]{64}$'
       or v_record.table_rows_sha256 is distinct from v_table_rows_sha then
      raise exception 'checkpoint membership table-row evidence differs for %', v_internal_id;
    end if;
    select * into v_company from companies c where c.id = v_record.company_id for update;

    begin
      v_pdf_object_path := nullif(btrim(v_item->>'pdfObjectPath'), '');
      v_pdf_sha := v_item->>'pdfSha256';
      v_pdf_page_count := (v_item->>'pdfPageCount')::int;
      v_pdf_verified_at := (v_item->>'pdfVerifiedAt')::timestamptz;
      v_pdf_capture_snapshot_sha := v_item->>'pdfCaptureSnapshotSha256';
    exception when others then
      raise exception 'checkpoint PDF binding types are invalid for %', v_internal_id;
    end;
    if v_pdf_object_path is null
       or v_pdf_sha !~ '^[0-9a-f]{64}$'
       or v_pdf_capture_snapshot_sha !~ '^[0-9a-f]{64}$'
       or not (
         v_pdf_capture_snapshot_sha = v_seed.capture_snapshot_hashes->>'current'
         or exists (
           select 1 from jsonb_array_elements_text(v_seed.capture_snapshot_hashes->'allowedPrior') h
           where h = v_pdf_capture_snapshot_sha
         )
       )
       or v_pdf_page_count <= 0
       or v_pdf_verified_at is null
       or v_record.pdf_status <> 'verified'
       or v_record.pdf_object_path is distinct from v_pdf_object_path
       or v_record.pdf_sha256 is distinct from v_pdf_sha
       or v_record.pdf_page_count is distinct from v_pdf_page_count
       or v_record.pdf_verified_at is distinct from v_pdf_verified_at
       or v_record.pdf_error is not null then
      raise exception 'checkpoint PDF binding differs from exact verified evidence for %', v_internal_id;
    end if;
    v_pdf_binding_sha := encode(digest(convert_to(
      v_internal_id || E'\t' || v_pdf_object_path || E'\t' || v_pdf_sha || E'\t'
      || v_pdf_page_count::text || E'\t'
      || to_char(v_pdf_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || E'\n',
      'UTF8'
    ), 'sha256'), 'hex');

    v_source_hashes := jsonb_build_object(
      'table_rows_sha256', v_table_rows_sha,
      'pdf_sha256', v_pdf_sha,
      'pdf_binding_sha256', v_pdf_binding_sha,
      'pdf_capture_snapshot_sha256', v_pdf_capture_snapshot_sha
    );
    v_artifact_sha := null;
    v_hold_reason := null;
    v_provenance := null;
    v_assessment := null;
    v_validation := null;
    v_final_score := null;
    v_tam_score := null;
    v_assessment_old_gold_score := null;
    v_live_old_gold_score := null;
    v_old_gold_class := null;
    v_old_gold_reasons := '[]'::jsonb;
    v_intro_call_exists := null;
    v_opportunity_exists := null;
    v_revisit_on := null;
    v_record_dead := null;
    v_record_dead_reason := null;
    v_record_digest := null;
    v_assessment_score_note := null;
    v_score_note := null;
    v_canonical_json := null;
    v_provenance_sha := null;
    v_provenance_object_path := null;
    v_validated_by := null;
    v_validated_at := null;
    v_historical_published_at := null;

    if v_cohort in ('published_complete', 'legacy_schema_recovery') then
      if (v_item->>'finalAssessmentLineSha256') !~ '^[0-9a-f]{64}$'
         or (v_item->>'publishQueueLineSha256') !~ '^[0-9a-f]{64}$'
         or (v_item ? 'historicalReceiptSha256' and (v_item->>'historicalReceiptSha256') !~ '^[0-9a-f]{64}$') then
        raise exception 'checkpoint staged artifact hashes are invalid for %', v_internal_id;
      end if;
      v_artifact_sha := v_item->>'finalAssessmentLineSha256';
      v_source_hashes := v_source_hashes || jsonb_strip_nulls(jsonb_build_object(
        'final_assessment_line_sha256', v_item->>'finalAssessmentLineSha256',
        'publish_queue_line_sha256', v_item->>'publishQueueLineSha256',
        'historical_receipt_sha256', v_item->>'historicalReceiptSha256'
      ));
    elsif v_cohort = 'lost_staging_recovery' then
      if (v_item->>'historicalReceiptSha256') !~ '^[0-9a-f]{64}$' then raise exception 'lost-staging receipt hash is invalid for %', v_internal_id; end if;
      v_artifact_sha := v_item->>'historicalReceiptSha256';
      v_source_hashes := v_source_hashes || jsonb_build_object('historical_receipt_sha256', v_artifact_sha);
    elsif v_cohort = 'active_hold' then
      if (v_item->>'holdFileSha256') !~ '^[0-9a-f]{64}$' then raise exception 'hold artifact hash is invalid for %', v_internal_id; end if;
      v_hold_reason := nullif(btrim(v_item->>'holdReason'), '');
      if v_hold_reason is null or length(v_hold_reason) > 2000 then raise exception 'active hold requires a bounded reason for %', v_internal_id; end if;
      v_artifact_sha := v_item->>'holdFileSha256';
      v_source_hashes := v_source_hashes || jsonb_build_object('hold_file_sha256', v_artifact_sha);
    end if;

    if v_cohort = 'published_complete' then
      v_provenance := v_item->'provenance'->'data';
      v_assessment := v_provenance->'assessment';
      v_validation := v_item->'validation';
      v_canonical_json := v_item->'provenance'->>'canonicalJson';
      v_provenance_sha := v_item->'provenance'->>'sha256';
      v_provenance_object_path := nullif(btrim(v_item->'provenance'->>'objectPath'), '');
      if jsonb_typeof(v_provenance) <> 'object' or jsonb_typeof(v_assessment) <> 'object'
         or jsonb_typeof(v_validation) <> 'object' then raise exception 'complete published checkpoint provenance is invalid for %', v_internal_id; end if;
      if v_canonical_json is null or v_provenance_sha !~ '^[0-9a-f]{64}$'
         or encode(digest(convert_to(v_canonical_json, 'UTF8'), 'sha256'), 'hex') is distinct from v_provenance_sha
         or v_canonical_json::jsonb is distinct from v_provenance then
        raise exception 'checkpoint provenance bytes/hash mismatch for %', v_internal_id;
      end if;
      if v_provenance_object_path is null then raise exception 'checkpoint provenance object path is required for %', v_internal_id; end if;

      begin
        v_final_score := (v_item->>'finalScore')::numeric;
        v_assessment_old_gold_score := (v_assessment->>'old_gold_score')::numeric;
        v_intro_call_exists := (v_assessment->>'intro_call_exists')::boolean;
        v_opportunity_exists := (v_assessment->>'opportunity_exists')::boolean;
        v_revisit_on := nullif(v_assessment->>'revisit_on', '')::date;
        v_validated_at := (v_validation->>'validatedAt')::timestamptz;
        v_historical_published_at := (v_item->>'historicalPublishedAt')::timestamptz;
      exception when others then
        raise exception 'checkpoint published field types are invalid for %', v_internal_id;
      end;
      if v_final_score < 0 or v_final_score > 100 or v_assessment_old_gold_score < 0 or v_assessment_old_gold_score > 100 then
        raise exception 'checkpoint scores are out of range for %', v_internal_id;
      end if;
      v_record_digest := nullif(btrim(v_item->>'recordDigest'), '');
      v_old_gold_class := nullif(btrim(v_assessment->>'old_gold_class'), '');
      v_old_gold_reasons := v_assessment->'old_gold_reasons';
      v_validated_by := nullif(btrim(v_validation->>'validatedBy'), '');
      v_record_dead := v_final_score <= 10;
      v_record_dead_reason := case when v_record_dead then nullif(btrim(v_assessment->>'dq_reason'), '') else null end;
      v_assessment_score_note := coalesce(v_item->>'scoreAdjustNote', v_assessment->>'score_adjust_note');
      if v_record_digest is null or v_old_gold_class is null or jsonb_typeof(v_old_gold_reasons) <> 'array'
         or v_validated_by is null or (v_validation->>'status') is distinct from 'passed' then
        raise exception 'checkpoint published assessment is incomplete for %', v_internal_id;
      end if;
      if (v_provenance->>'schema') is distinct from 'tam-grade-provenance'
         or (v_provenance->>'version')::int is distinct from 1
         or (v_provenance->>'runSlug') is distinct from p_run_slug
         or (v_provenance->>'netsuiteInternalId') is distinct from v_internal_id
         or (v_provenance->>'method') is distinct from 'full-record-reader-plus-independent-full-record-validator'
         or (v_provenance->>'validatorHashScope') is distinct from 'canonical-record'
         or (v_provenance->>'snapshotSha256') is distinct from v_seed.capture_snapshot_hashes->>'current'
         or (v_provenance->>'pdfSha256') is distinct from v_record.pdf_sha256
         or (v_provenance->>'pdfPageCount')::int is distinct from v_record.pdf_page_count
         or (v_assessment->>'exact_id') is distinct from v_internal_id
         or (v_assessment->>'final_score')::numeric is distinct from v_final_score
         or (v_assessment->>'record_digest') is distinct from v_record_digest
         or (v_assessment->'validation'->>'status') is distinct from 'passed'
         or (v_assessment->'validation'->>'validated_by') is distinct from v_validated_by
         or (v_assessment->'validation'->>'validated_at')::timestamptz is distinct from v_validated_at then
        raise exception 'checkpoint published provenance identity/full-read contract mismatch for %', v_internal_id;
      end if;
      if v_record.pdf_status <> 'verified' then raise exception 'checkpoint published record lacks verified PDF: %', v_internal_id; end if;
      if v_record_dead and (v_record_dead_reason is null or v_assessment_old_gold_score <> 0 or v_old_gold_class <> 'dead') then
        raise exception 'checkpoint dead-band evidence is inconsistent for %', v_internal_id;
      end if;
      if not v_record_dead and v_old_gold_class = 'dead' then raise exception 'checkpoint live assessment uses dead class for %', v_internal_id; end if;

      v_hard_zero_reason := case
        when v_record_dead then 'record dead'
        when lower(btrim(coalesce(v_company.erp_incumbent, ''))) = 'netsuite' then 'already on NetSuite'
        else null
      end;
      v_tam_score := case when v_hard_zero_reason is null then v_final_score else 0 end;
      v_old_gold_member := (
        nullif(btrim(v_company.qual_note), '') is not null and v_company.last_sql_date is not null
      ) or (v_record_digest || ' ' || coalesce((
        select string_agg(value, ' ') from jsonb_array_elements_text(v_old_gold_reasons) value
      ), '')) ~* '(^|[^[:alnum:]_])Opportunity (created|confirmed):[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)';
      v_live_old_gold_score := case
        when not v_old_gold_member then null
        when v_hard_zero_reason is not null then 0
        else v_assessment_old_gold_score
      end;
      v_score_note := left(
        case when nullif(btrim(v_assessment_score_note), '') is null then '' else btrim(v_assessment_score_note) || '; ' end
        || case when v_hard_zero_reason is null
          then 'TAM equals raw grade; public signals are Triggered-only'
          else format('hard 0 - %s', v_hard_zero_reason)
        end,
        400
      );

      -- This import is coordination-only. The company row is locked and read
      -- back exactly; no company column is rewritten or normalized here.
      if v_company.codex_score is distinct from v_final_score
         or v_company.tam_score is distinct from v_tam_score
         or v_company.oldgold_score is distinct from v_live_old_gold_score
         or v_company.oldgold_class is distinct from v_old_gold_class
         or v_company.oldgold_reasons is distinct from v_old_gold_reasons
         or v_company.revisit_on is distinct from v_revisit_on
         or v_company.record_dead is distinct from v_record_dead
         or v_company.record_dead_reason is distinct from v_record_dead_reason
         or v_company.record_digest is distinct from v_record_digest
         or v_company.score_adjust_note is distinct from v_score_note
         or v_company.tam_provisional is distinct from false then
        raise exception 'checkpoint company exact normalized readback drifted for NetSuite ID %', v_internal_id;
      end if;
    end if;

    if v_record.checkpoint_seed_id is not null then
      if v_record.checkpoint_seed_id is distinct from v_seed.id
         or v_record.membership_ordinal is distinct from v_ordinal
         or v_record.recovery_cohort is distinct from v_cohort
         or v_record.checkpoint_artifact_sha256 is distinct from v_artifact_sha
         or v_record.checkpoint_payload_sha256 is distinct from v_payload_sha
         or v_record.checkpoint_source_hashes is distinct from v_source_hashes
         or (v_cohort = 'published_complete' and (
           v_record.grade_status <> 'published'
           or v_record.final_score is distinct from v_final_score
           or v_record.codex_score is distinct from v_final_score
           or v_record.tam_score is distinct from v_tam_score
           or v_record.record_digest is distinct from v_record_digest
           or v_record.assessment_old_gold_score is distinct from v_assessment_old_gold_score
           or v_record.old_gold_class is distinct from v_old_gold_class
           or v_record.old_gold_reasons is distinct from v_old_gold_reasons
           or v_record.intro_call_exists is distinct from v_intro_call_exists
           or v_record.opportunity_exists is distinct from v_opportunity_exists
           or v_record.revisit_on is distinct from v_revisit_on
           or v_record.record_dead is distinct from v_record_dead
           or v_record.record_dead_reason is distinct from v_record_dead_reason
           or v_record.grade_provenance is distinct from v_provenance
           or v_record.grade_provenance_canonical_json is distinct from v_canonical_json
           or v_record.grade_provenance_sha256 is distinct from v_provenance_sha
           or v_record.grade_provenance_object_path is distinct from v_provenance_object_path
           or v_record.validated_by is distinct from v_validated_by
           or v_record.validated_at is distinct from v_validated_at
           or v_record.historical_published_at is distinct from v_historical_published_at
           or v_record.publication_origin is distinct from 'historical_live_import'
         ))
         or (v_cohort = 'active_hold' and (
           v_record.grade_status <> 'hold' or v_record.hold_reason is distinct from v_hold_reason
         ))
         or (v_cohort not in ('published_complete','active_hold') and v_record.grade_status <> 'pending') then
        raise exception 'checkpoint retry drifted from the stored exact seed for NetSuite ID %', v_internal_id;
      end if;
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if v_record.grade_status <> 'pending'
       or v_record.claim_token is not null
       or v_record.final_score is not null
       or v_record.grade_provenance_sha256 is not null then
      raise exception 'checkpoint refuses to overwrite pre-existing coordination state for NetSuite ID %', v_internal_id;
    end if;

    perform set_config('stanley.tam_checkpoint_batch_token', v_seed.seed_token::text, true);
    update tam_regrade_records
    set membership_ordinal = v_ordinal,
        recovery_cohort = v_cohort,
        checkpoint_seed_id = v_seed.id,
        checkpoint_artifact_sha256 = v_artifact_sha,
        checkpoint_payload_sha256 = v_payload_sha,
        checkpoint_source_hashes = v_source_hashes,
        checkpoint_seeded_at = v_now,
        grade_status = case
          when v_cohort = 'published_complete' then 'published'
          when v_cohort = 'active_hold' then 'hold'
          else 'pending'
        end,
        hold_reason = v_hold_reason,
        final_score = v_final_score,
        codex_score = v_final_score,
        tam_score = v_tam_score,
        score_adjust_note = v_score_note,
        assessment_score_note = v_assessment_score_note,
        record_digest = v_record_digest,
        record_dead = v_record_dead,
        record_dead_reason = v_record_dead_reason,
        assessment_old_gold_score = v_assessment_old_gold_score,
        old_gold_class = v_old_gold_class,
        old_gold_reasons = v_old_gold_reasons,
        intro_call_exists = v_intro_call_exists,
        opportunity_exists = v_opportunity_exists,
        revisit_on = v_revisit_on,
        grade_provenance = coalesce(v_provenance, '{}'::jsonb),
        grade_provenance_object_path = v_provenance_object_path,
        grade_provenance_canonical_json = v_canonical_json,
        grade_provenance_sha256 = v_provenance_sha,
        validation_status = case when v_cohort = 'published_complete' then 'passed' else 'pending' end,
        validated_by = v_validated_by,
        validated_at = v_validated_at,
        graded_at = case when v_cohort = 'published_complete' then v_validated_at else null end,
        published_at = v_historical_published_at,
        historical_published_at = v_historical_published_at,
        publication_origin = case when v_cohort = 'published_complete' then 'historical_live_import' else null end,
        last_actor = p_actor_key,
        claim_actor = null,
        claim_token = null,
        claim_started_at = null,
        claim_heartbeat_at = null,
        claim_expires_at = null
    where run_id = v_run.id and netsuite_internal_id = v_internal_id;

    insert into tam_regrade_events (
      run_id, actor_key, kind, netsuite_internal_id, summary, metadata
    ) values (
      v_run.id, p_actor_key, 'checkpoint.' || v_cohort, v_internal_id,
      format('Seeded checkpoint cohort %s for NetSuite ID %s', v_cohort, v_internal_id),
      jsonb_build_object(
        'seed_id', v_seed.id,
        'membership_ordinal', v_ordinal,
        'checkpoint_artifact_sha256', v_artifact_sha,
        'checkpoint_payload_sha256', v_payload_sha,
        'source_hashes', v_source_hashes,
        'legacy_codex_score_ignored', v_cohort = 'published_complete' and v_item ? 'codexScore'
      )
    );
    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted > 0 then
    insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
    values (
      v_run.id, p_actor_key, 'checkpoint.batch_seeded',
      format('Seeded %s exact checkpoint records (%s byte-identical retries)', v_inserted, v_unchanged),
      jsonb_build_object(
        'seed_id', v_seed.id,
        'inserted', v_inserted,
        'unchanged', v_unchanged,
        'batch_sha256', encode(digest(convert_to(p_rows::text, 'UTF8'), 'sha256'), 'hex')
      )
    );
  end if;
  update tam_regrade_runs set last_heartbeat_at = v_now where id = v_run.id;
  return jsonb_build_object('seedId', v_seed.id, 'seeded', v_inserted, 'unchanged', v_unchanged);
end;
$$;

create or replace function finalize_tam_regrade_checkpoint_seed(
  p_run_slug text,
  p_actor_key text,
  p_seed_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run tam_regrade_runs%rowtype;
  v_seed tam_regrade_checkpoint_seeds%rowtype;
  v_counts jsonb;
  v_current_hash text;
  v_removed_hash text;
  v_complete_hash text;
  v_legacy_hash text;
  v_lost_hash text;
  v_hold_hash text;
  v_unrepresented_hash text;
  v_now timestamptz := now();
  v_already_complete boolean;
begin
  if nullif(btrim(p_actor_key), '') is null or p_seed_token is null then raise exception 'actor and seed token are required'; end if;
  select * into v_run from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  select * into v_seed from tam_regrade_checkpoint_seeds where run_id = v_run.id for update;
  if not found
     or v_seed.seed_token is distinct from p_seed_token
     or v_seed.actor_key is distinct from btrim(p_actor_key) then
    raise exception 'checkpoint seed token is stale or unowned';
  end if;
  v_already_complete := v_seed.status = 'complete';
  if v_already_complete then
    if v_run.completed_checkpoint_seed_id is distinct from v_seed.id then
      raise exception 'completed checkpoint seed is not fenced into its TAM run';
    end if;
    return jsonb_build_object(
      'seedId', v_seed.id,
      'status', 'complete',
      'alreadyComplete', true,
      'cohortHashes', v_seed.cohort_hashes
    );
  end if;
  if v_run.status <> 'capturing' then raise exception 'checkpoint finalization requires the run to remain capturing'; end if;
  if exists (select 1 from tam_regrade_records r where r.run_id = v_run.id and r.grade_status = 'reading') then
    raise exception 'checkpoint cannot finalize while any TAM record has a lease';
  end if;

  select jsonb_build_object(
    'recordsTotal', count(*),
    'current', count(*) filter (where is_current),
    'removed', count(*) filter (where not is_current and membership_status = 'removed'),
    'pdfVerified', count(*) filter (where is_current and pdf_status = 'verified'),
    'published', count(*) filter (where is_current and grade_status = 'published'),
    'pending', count(*) filter (where is_current and grade_status = 'pending'),
    'hold', count(*) filter (where is_current and grade_status = 'hold'),
    'reading', count(*) filter (where is_current and grade_status = 'reading'),
    'final', count(*) filter (where is_current and grade_status = 'final'),
    'expired', count(*) filter (where is_current and grade_status = 'reading' and claim_expires_at <= now()),
    'publishedComplete', count(*) filter (where is_current and recovery_cohort = 'published_complete'),
    'legacySchemaRecovery', count(*) filter (where is_current and recovery_cohort = 'legacy_schema_recovery'),
    'lostStagingRecovery', count(*) filter (where is_current and recovery_cohort = 'lost_staging_recovery'),
    'activeHold', count(*) filter (where is_current and recovery_cohort = 'active_hold'),
    'unrepresented', count(*) filter (where is_current and recovery_cohort = 'unrepresented'),
    'seeded', count(*) filter (where is_current and checkpoint_seed_id = v_seed.id),
    'distinctOrdinals', count(distinct membership_ordinal) filter (where is_current),
    'minOrdinal', min(membership_ordinal) filter (where is_current),
    'maxOrdinal', max(membership_ordinal) filter (where is_current)
  ) into v_counts
  from tam_regrade_records where run_id = v_run.id;

  if (v_counts->>'current')::int <> (v_seed.expected_counts->>'currentTotal')::int
     or (v_counts->>'pdfVerified')::int <> (v_seed.expected_counts->>'pdfVerified')::int
     or (v_counts->>'publishedComplete')::int <> (v_seed.expected_counts->>'publishedComplete')::int
     or (v_counts->>'legacySchemaRecovery')::int <> (v_seed.expected_counts->>'legacySchemaRecovery')::int
     or (v_counts->>'lostStagingRecovery')::int <> (v_seed.expected_counts->>'lostStagingRecovery')::int
     or (v_counts->>'activeHold')::int <> (v_seed.expected_counts->>'activeHold')::int
     or (v_counts->>'unrepresented')::int <> (v_seed.expected_counts->>'unrepresented')::int
     or (v_counts->>'seeded')::int <> (v_seed.expected_counts->>'currentTotal')::int
     or (v_counts->>'distinctOrdinals')::int <> (v_seed.expected_counts->>'currentTotal')::int
     or (v_counts->>'minOrdinal')::int <> 1
     or (v_counts->>'maxOrdinal')::int <> (v_seed.expected_counts->>'currentTotal')::int then
    raise exception 'checkpoint finalization count/ordinal drift: %', v_counts;
  end if;
  if (v_counts->>'removed')::int <> (v_seed.expected_counts->>'removedTotal')::int then
    raise exception 'checkpoint removed-membership count drift: %', v_counts;
  end if;
  if (v_counts->>'published')::int <> (v_seed.expected_counts->>'publishedComplete')::int
     or (v_counts->>'hold')::int <> (v_seed.expected_counts->>'activeHold')::int
     or (v_counts->>'pending')::int <> (
       (v_seed.expected_counts->>'legacySchemaRecovery')::int
       + (v_seed.expected_counts->>'lostStagingRecovery')::int
       + (v_seed.expected_counts->>'unrepresented')::int
     )
     or (v_counts->>'reading')::int <> 0
     or (v_counts->>'final')::int <> 0
     or (v_counts->>'expired')::int <> 0 then
    raise exception 'checkpoint finalization board status drift: %', v_counts;
  end if;
  if exists (
    select 1 from tam_regrade_records r
    where r.run_id = v_run.id and r.is_current
      and (r.claim_actor is not null or r.claim_token is not null or r.claim_started_at is not null
        or r.claim_heartbeat_at is not null or r.claim_expires_at is not null)
  ) then raise exception 'checkpoint finalization found residual claim state'; end if;
  if exists (
    select 1 from tam_regrade_records r
    where r.run_id = v_run.id and r.is_current
      and (
        r.checkpoint_source_hashes->>'table_rows_sha256' is distinct from r.table_rows_sha256
        or r.checkpoint_source_hashes->>'pdf_sha256' is distinct from r.pdf_sha256
        or not (
          r.checkpoint_source_hashes->>'pdf_capture_snapshot_sha256' = v_seed.capture_snapshot_hashes->>'current'
          or exists (
            select 1 from jsonb_array_elements_text(v_seed.capture_snapshot_hashes->'allowedPrior') h
            where h = r.checkpoint_source_hashes->>'pdf_capture_snapshot_sha256'
          )
        )
        or r.checkpoint_source_hashes->>'pdf_binding_sha256' is distinct from encode(digest(convert_to(
          r.netsuite_internal_id || E'\t' || r.pdf_object_path || E'\t' || r.pdf_sha256 || E'\t'
          || r.pdf_page_count::text || E'\t'
          || to_char(r.pdf_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || E'\n',
          'UTF8'
        ), 'sha256'), 'hex')
      )
  ) then raise exception 'checkpoint finalization found PDF evidence binding drift'; end if;

  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_current_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current;
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by length(r.netsuite_internal_id), r.netsuite_internal_id), ''), 'UTF8'), 'sha256'), 'hex')
    into v_removed_hash from tam_regrade_records r
    where r.run_id = v_run.id and not r.is_current and r.membership_status = 'removed';
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_complete_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current and r.recovery_cohort = 'published_complete';
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_legacy_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current and r.recovery_cohort = 'legacy_schema_recovery';
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_lost_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current and r.recovery_cohort = 'lost_staging_recovery';
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_hold_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current and r.recovery_cohort = 'active_hold';
  select encode(digest(convert_to(coalesce(string_agg(r.netsuite_internal_id || E'\n', '' order by r.membership_ordinal), ''), 'UTF8'), 'sha256'), 'hex')
    into v_unrepresented_hash from tam_regrade_records r where r.run_id = v_run.id and r.is_current and r.recovery_cohort = 'unrepresented';

  if v_current_hash is distinct from v_seed.cohort_hashes->>'current'
     or v_removed_hash is distinct from v_seed.cohort_hashes->>'removed'
     or v_complete_hash is distinct from v_seed.cohort_hashes->>'publishedComplete'
     or v_legacy_hash is distinct from v_seed.cohort_hashes->>'legacySchemaRecovery'
     or v_lost_hash is distinct from v_seed.cohort_hashes->>'lostStagingRecovery'
     or v_hold_hash is distinct from v_seed.cohort_hashes->>'activeHold'
     or v_unrepresented_hash is distinct from v_seed.cohort_hashes->>'unrepresented' then
    raise exception 'checkpoint exact ordered-ID hashes do not match the manifest';
  end if;

  -- Revalidate every imported final against the live company immediately before
  -- the only capturing -> grading transition. No normalization write is allowed.
  if exists (
    select 1
    from tam_regrade_records r
    left join companies c on c.id = r.company_id
    where r.run_id = v_run.id
      and r.is_current
      and r.recovery_cohort = 'published_complete'
      and (
        c.id is null
        or tam_canonical_company_id(r.netsuite_internal_id) is distinct from r.company_id
        or c.codex_score is distinct from r.final_score
        or c.tam_score is distinct from r.tam_score
        or c.oldgold_score is distinct from (
          case
          when not (
            (nullif(btrim(c.qual_note), '') is not null and c.last_sql_date is not null)
            or (r.record_digest || ' ' || coalesce((
              select string_agg(value, ' ') from jsonb_array_elements_text(r.old_gold_reasons) value
            ), '')) ~* '(^|[^[:alnum:]_])Opportunity (created|confirmed):[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)'
          ) then null
          when r.record_dead or lower(btrim(coalesce(c.erp_incumbent, ''))) = 'netsuite' then 0
          else r.assessment_old_gold_score
          end
        )
        or c.oldgold_class is distinct from r.old_gold_class
        or c.oldgold_reasons is distinct from r.old_gold_reasons
        or c.revisit_on is distinct from r.revisit_on
        or c.record_dead is distinct from r.record_dead
        or c.record_dead_reason is distinct from r.record_dead_reason
        or c.record_digest is distinct from r.record_digest
        or c.score_adjust_note is distinct from r.score_adjust_note
        or c.tam_provisional is distinct from false
      )
  ) then raise exception 'checkpoint finalization found live company readback drift'; end if;

  if not v_already_complete then
    perform set_config('stanley.tam_checkpoint_finalize_token', v_seed.seed_token::text, true);
    update tam_regrade_checkpoint_seeds
    set status = 'complete', completed_at = v_now
    where id = v_seed.id;
    update tam_regrade_runs
    set completed_checkpoint_seed_id = v_seed.id,
        status = 'grading',
        last_heartbeat_at = v_now
    where id = v_run.id;
    insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
    values (
      v_run.id, p_actor_key, 'checkpoint.seed_completed',
      format('Finalized exact TAM checkpoint seed %s and opened ordered grading', v_seed.id),
      jsonb_build_object(
        'seed_id', v_seed.id,
        'manifest_sha256', v_seed.manifest_sha256,
        'release_commit', v_seed.release_commit,
        'counts', v_counts,
        'cohort_hashes', v_seed.cohort_hashes
      )
    );
  end if;
  return jsonb_build_object(
    'seedId', v_seed.id,
    'status', 'complete',
    'alreadyComplete', v_already_complete,
    'counts', v_counts,
    'cohortHashes', v_seed.cohort_hashes
  );
end;
$$;

-- Extend the shared board with checkpoint/cohort readback without exposing the
-- seed fencing token.
create or replace function get_tam_regrade_status(
  p_run_slug text,
  p_event_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run tam_regrade_runs%rowtype;
  v_counts jsonb;
  v_actors jsonb;
  v_events jsonb;
  v_seed jsonb;
begin
  select * into v_run from tam_regrade_runs where slug = p_run_slug;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  select jsonb_build_object(
    'records_total', count(*),
    'current', count(*) filter (where is_current),
    'new', count(*) filter (where membership_status = 'new'),
    'overlap', count(*) filter (where membership_status = 'overlap'),
    'removed', count(*) filter (where membership_status = 'removed'),
    'pdf_verified', count(*) filter (where is_current and pdf_status = 'verified'),
    'grade_pending', count(*) filter (where is_current and grade_status = 'pending'),
    'grade_reading', count(*) filter (where is_current and grade_status = 'reading'),
    'grade_hold', count(*) filter (where is_current and grade_status = 'hold'),
    'grade_final', count(*) filter (where is_current and grade_status = 'final'),
    'grade_published', count(*) filter (where is_current and grade_status = 'published'),
    'lease_expired', count(*) filter (where is_current and grade_status = 'reading' and claim_expires_at <= now()),
    'cohort_published_complete', count(*) filter (where is_current and recovery_cohort = 'published_complete'),
    'cohort_legacy_schema_recovery', count(*) filter (where is_current and recovery_cohort = 'legacy_schema_recovery'),
    'cohort_lost_staging_recovery', count(*) filter (where is_current and recovery_cohort = 'lost_staging_recovery'),
    'cohort_active_hold', count(*) filter (where is_current and recovery_cohort = 'active_hold'),
    'cohort_unrepresented', count(*) filter (where is_current and recovery_cohort = 'unrepresented')
  ) into v_counts from tam_regrade_records where run_id = v_run.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.heartbeat_at desc), '[]'::jsonb)
    into v_actors from tam_regrade_actors a where a.run_id = v_run.id;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc, e.id desc), '[]'::jsonb)
    into v_events
  from (
    select * from tam_regrade_events where run_id = v_run.id
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_event_limit, 50), 0), 200)
  ) e;
  select to_jsonb(s) - 'seed_token' into v_seed
  from tam_regrade_checkpoint_seeds s where s.run_id = v_run.id;
  return jsonb_build_object(
    'run', to_jsonb(v_run),
    'counts', v_counts,
    'checkpointSeed', v_seed,
    'actors', v_actors,
    'events', v_events
  );
end;
$$;

alter table tam_regrade_checkpoint_seeds enable row level security;
revoke all on tam_regrade_checkpoint_seeds from public, anon, authenticated, service_role;
grant select on tam_regrade_checkpoint_seeds to service_role;

revoke all on function begin_tam_regrade_checkpoint_seed(text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function seed_tam_regrade_checkpoint_batch(text,text,uuid,jsonb)
  from public, anon, authenticated;
revoke all on function finalize_tam_regrade_checkpoint_seed(text,text,uuid)
  from public, anon, authenticated;
grant execute on function begin_tam_regrade_checkpoint_seed(text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)
  to service_role;
grant execute on function seed_tam_regrade_checkpoint_batch(text,text,uuid,jsonb)
  to service_role;
grant execute on function finalize_tam_regrade_checkpoint_seed(text,text,uuid)
  to service_role;

notify pgrst, 'reload schema';
