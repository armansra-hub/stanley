-- 0043: leased, exact-ID TAM regrade coordination for Codex + Claude Code.
--
-- NetSuite Internal ID is the workflow identity, but it is not globally unique
-- in companies: retired rows explicitly tagged tam_duplicate are preserved.
-- Every write resolves one non-retired row and fails closed if that mapping is
-- absent or ambiguous. No global companies identity constraint is introduced.

create extension if not exists pgcrypto;

create table if not exists tam_regrade_runs (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique,
  search_id              text not null check (search_id ~ '^[0-9]+$'),
  mission                jsonb not null default '{}'::jsonb,
  status                 text not null default 'initializing'
                         check (status in ('initializing','capturing','grading','paused','complete','failed')),
  source_total           int check (source_total is null or source_total >= 0),
  source_snapshot_sha256 text check (
                           source_snapshot_sha256 is null
                           or source_snapshot_sha256 ~ '^[0-9a-f]{64}$'
                         ),
  last_heartbeat_at      timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table if not exists tam_regrade_actors (
  run_id          uuid not null references tam_regrade_runs(id) on delete restrict,
  actor_key       text not null,
  status          text not null default 'idle'
                  check (status in ('idle','working','blocked','offline','complete')),
  current_work    text,
  metadata        jsonb not null default '{}'::jsonb,
  heartbeat_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (run_id, actor_key)
);

create table if not exists tam_regrade_records (
  run_id                    uuid not null references tam_regrade_runs(id) on delete restrict,
  netsuite_internal_id      text not null check (netsuite_internal_id ~ '^[0-9]+$'),
  company_id                uuid references companies(id) on delete set null,
  company_name              text,

  is_current                boolean not null default true,
  membership_status         text not null default 'overlap'
                            check (membership_status in ('new','overlap','removed')),
  table_row                 jsonb not null default '{}'::jsonb,
  source_page               int check (source_page is null or source_page > 0),
  source_row                int check (source_row is null or source_row > 0),
  table_rows                jsonb not null default '[]'::jsonb,
  source_coordinates        jsonb not null default '[]'::jsonb,
  saved_search_row_count    int not null default 0
                            check (saved_search_row_count >= 0),
  table_rows_sha256         text check (
                              table_rows_sha256 is null
                              or table_rows_sha256 ~ '^[0-9a-f]{64}$'
                            ),

  pdf_status                text not null default 'missing'
                            check (pdf_status in ('missing','queued','downloading','verified','error','stale')),
  pdf_object_path           text,
  pdf_sha256                text check (
                              pdf_sha256 is null
                              or pdf_sha256 ~ '^[0-9a-f]{64}$'
                            ),
  pdf_page_count            int check (pdf_page_count is null or pdf_page_count > 0),
  pdf_verified_at           timestamptz,
  pdf_error                 text,

  grade_status              text not null default 'pending'
                            check (grade_status in ('pending','reading','hold','final','published')),
  hold_reason               text,
  last_actor                text,
  claim_actor               text,
  claim_token               uuid,
  claim_generation          bigint not null default 0 check (claim_generation >= 0),
  claim_started_at          timestamptz,
  claim_heartbeat_at        timestamptz,
  claim_expires_at          timestamptz,

  -- final_score and codex_score are the same raw independently validated grade.
  -- tam_score is the stored display grade after record-derived hard zeros only.
  final_score               numeric check (final_score is null or final_score between 0 and 100),
  codex_score               numeric check (codex_score is null or codex_score between 0 and 100),
  tam_score                 numeric check (tam_score is null or tam_score between 0 and 100),
  score_adjust_note         text,
  assessment_score_note     text,
  record_digest             text,
  record_dead               boolean,
  record_dead_reason        text,
  assessment_old_gold_score numeric check (
                              assessment_old_gold_score is null
                              or assessment_old_gold_score between 0 and 100
                            ),
  old_gold_class            text,
  old_gold_reasons          jsonb not null default '[]'::jsonb,
  intro_call_exists         boolean,
  opportunity_exists       boolean,
  revisit_on                date,
  grade_provenance          jsonb not null default '{}'::jsonb,
  grade_provenance_object_path text,
  grade_provenance_canonical_json text,
  grade_provenance_sha256   text check (
                              grade_provenance_sha256 is null
                              or grade_provenance_sha256 ~ '^[0-9a-f]{64}$'
                            ),
  validation_status         text not null default 'pending'
                            check (validation_status in ('pending','passed','failed')),
  validated_by              text,
  validated_at              timestamptz,
  graded_at                 timestamptz,
  published_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  primary key (run_id, netsuite_internal_id),
  check (
    (is_current and membership_status in ('new','overlap'))
    or (not is_current and membership_status = 'removed')
  ),
  check (jsonb_typeof(table_rows) = 'array'),
  check (jsonb_typeof(source_coordinates) = 'array'),
  check (jsonb_typeof(old_gold_reasons) = 'array'),
  check (
    not is_current
    or (
      saved_search_row_count > 0
      and jsonb_array_length(table_rows) = saved_search_row_count
      and jsonb_array_length(source_coordinates) = saved_search_row_count
      and table_rows_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  check (
    pdf_status <> 'verified'
    or (
      nullif(btrim(pdf_object_path), '') is not null
      and pdf_sha256 ~ '^[0-9a-f]{64}$'
      and pdf_page_count > 0
      and pdf_verified_at is not null
    )
  ),
  check (
    grade_status <> 'reading'
    or (
      nullif(btrim(claim_actor), '') is not null
      and claim_token is not null
      and claim_started_at is not null
      and claim_heartbeat_at is not null
      and claim_expires_at > claim_heartbeat_at
    )
  ),
  check (
    grade_status not in ('final','published')
    or (
      final_score is not null
      and codex_score = final_score
      and tam_score is not null
      and nullif(btrim(record_digest), '') is not null
      and record_dead is not null
      and assessment_old_gold_score is not null
      and nullif(btrim(old_gold_class), '') is not null
      and intro_call_exists is not null
      and opportunity_exists is not null
      and nullif(btrim(grade_provenance_object_path), '') is not null
      and nullif(grade_provenance_canonical_json, '') is not null
      and grade_provenance_sha256 ~ '^[0-9a-f]{64}$'
      and graded_at is not null
    )
  ),
  check (
    grade_status <> 'published'
    or (
      validation_status = 'passed'
      and nullif(btrim(validated_by), '') is not null
      and validated_at is not null
      and published_at is not null
    )
  )
);

create table if not exists tam_regrade_events (
  id                    bigint generated always as identity primary key,
  run_id                uuid not null references tam_regrade_runs(id) on delete restrict,
  actor_key             text not null,
  kind                  text not null,
  netsuite_internal_id  text check (
                           netsuite_internal_id is null
                           or netsuite_internal_id ~ '^[0-9]+$'
                         ),
  summary               text not null,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists tam_regrade_runs_updated_idx
  on tam_regrade_runs (updated_at desc);
create index if not exists tam_regrade_actors_heartbeat_idx
  on tam_regrade_actors (run_id, heartbeat_at desc);
create index if not exists tam_regrade_records_current_idx
  on tam_regrade_records (run_id, is_current, grade_status);
create index if not exists tam_regrade_records_pdf_idx
  on tam_regrade_records (run_id, is_current, pdf_status);
create index if not exists tam_regrade_records_lease_idx
  on tam_regrade_records (run_id, claim_expires_at)
  where grade_status = 'reading';
create index if not exists tam_regrade_records_company_idx
  on tam_regrade_records (company_id) where company_id is not null;
create index if not exists tam_regrade_events_run_idx
  on tam_regrade_events (run_id, created_at desc, id desc);
create index if not exists tam_regrade_events_record_idx
  on tam_regrade_events (run_id, netsuite_internal_id, created_at desc)
  where netsuite_internal_id is not null;

create or replace function tam_regrade_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tam_regrade_runs_updated_at on tam_regrade_runs;
create trigger tam_regrade_runs_updated_at
before update on tam_regrade_runs
for each row execute function tam_regrade_set_updated_at();

drop trigger if exists tam_regrade_actors_updated_at on tam_regrade_actors;
create trigger tam_regrade_actors_updated_at
before update on tam_regrade_actors
for each row execute function tam_regrade_set_updated_at();

drop trigger if exists tam_regrade_records_updated_at on tam_regrade_records;
create trigger tam_regrade_records_updated_at
before update on tam_regrade_records
for each row execute function tam_regrade_set_updated_at();

create or replace function tam_regrade_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'tam_regrade_events is append-only';
end;
$$;

drop trigger if exists tam_regrade_events_no_mutation on tam_regrade_events;
create trigger tam_regrade_events_no_mutation
before update or delete on tam_regrade_events
for each row execute function tam_regrade_events_are_append_only();

-- Return the sole non-retired row for an exact ID. Historical tam_duplicate
-- rows are deliberately ignored; any other duplicate state is ambiguous.
create or replace function tam_canonical_company_id(p_netsuite_internal_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if p_netsuite_internal_id is null or p_netsuite_internal_id !~ '^[0-9]+$' then
    raise exception 'exact numeric NetSuite Internal ID is required';
  end if;

  select array_agg(c.id order by c.id)
    into v_ids
  from companies c
  where c.netsuite_internal_id = p_netsuite_internal_id
    and not ('tam_duplicate' = any(coalesce(c.lists, '{}'::text[])));

  if coalesce(cardinality(v_ids), 0) = 0 then
    return null;
  end if;
  if cardinality(v_ids) <> 1 then
    raise exception 'exact NetSuite Internal ID % has % non-retired company rows; expected 1',
      p_netsuite_internal_id, cardinality(v_ids);
  end if;
  return v_ids[1];
end;
$$;

create or replace function bootstrap_tam_regrade_run(
  p_run_slug text,
  p_search_id text,
  p_mission jsonb,
  p_status text,
  p_source_total int,
  p_source_snapshot_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run tam_regrade_runs%rowtype;
  v_now timestamptz := now();
begin
  if nullif(btrim(p_run_slug), '') is null then raise exception 'run slug is required'; end if;
  if p_search_id is null or p_search_id !~ '^[0-9]+$' then raise exception 'numeric saved search ID is required'; end if;
  if p_status not in ('initializing','capturing','grading','paused','complete','failed') then raise exception 'invalid run status'; end if;
  if p_source_total is not null and p_source_total < 0 then raise exception 'source total cannot be negative'; end if;
  if p_source_snapshot_sha256 is not null and p_source_snapshot_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid source snapshot SHA-256'; end if;

  insert into tam_regrade_runs (
    slug, search_id, mission, status, source_total, source_snapshot_sha256,
    last_heartbeat_at
  ) values (
    btrim(p_run_slug), p_search_id, coalesce(p_mission, '{}'::jsonb), p_status,
    p_source_total, p_source_snapshot_sha256, v_now
  )
  on conflict (slug) do update
  set search_id = excluded.search_id,
      mission = excluded.mission,
      status = excluded.status,
      source_total = coalesce(excluded.source_total, tam_regrade_runs.source_total),
      source_snapshot_sha256 = coalesce(excluded.source_snapshot_sha256, tam_regrade_runs.source_snapshot_sha256),
      last_heartbeat_at = excluded.last_heartbeat_at
  returning * into v_run;

  insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
  values (
    v_run.id, 'system', 'run.bootstrapped',
    format('Bootstrapped TAM regrade run %s for saved search %s', v_run.slug, v_run.search_id),
    jsonb_build_object(
      'source_total', v_run.source_total,
      'source_snapshot_sha256', v_run.source_snapshot_sha256
    )
  );
  return to_jsonb(v_run);
end;
$$;

-- Atomically materialize current membership and bind every exact ID to its one
-- non-retired company row. The advisory lock prevents two imports from creating
-- competing company rows for the same previously unseen exact ID.
create or replace function upsert_tam_regrade_membership(
  p_run_slug text,
  p_actor_key text,
  p_rows jsonb,
  p_source_total int,
  p_source_snapshot_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_item jsonb;
  v_internal_id text;
  v_company_name text;
  v_company_id uuid;
  v_company_count int;
  v_table_rows jsonb;
  v_coordinates jsonb;
  v_row_count int;
  v_now timestamptz := now();
  v_upserted int := 0;
  v_inserted int := 0;
  v_updated int := 0;
begin
  if nullif(btrim(p_actor_key), '') is null then raise exception 'actor key is required'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'membership rows must be a non-empty array'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'membership batch exceeds 1000 exact IDs'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) item
    group by item->>'netsuiteInternalId' having count(*) > 1
  ) then raise exception 'membership batch repeats an exact Internal ID'; end if;

  select id into v_run_id from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    v_internal_id := v_item->>'netsuiteInternalId';
    v_table_rows := v_item->'tableRows';
    v_coordinates := v_item->'sourceCoordinates';
    v_row_count := (v_item->>'savedSearchRowCount')::int;
    if v_internal_id is null or v_internal_id !~ '^[0-9]+$' then raise exception 'membership contains an invalid exact Internal ID'; end if;
    if v_item->>'membershipStatus' not in ('new','overlap') then raise exception 'membership status must be new or overlap'; end if;
    if jsonb_typeof(v_table_rows) <> 'array'
       or jsonb_typeof(v_coordinates) <> 'array'
       or jsonb_array_length(v_table_rows) <> v_row_count
       or jsonb_array_length(v_coordinates) <> v_row_count
       or v_row_count <= 0 then
      raise exception 'membership evidence count mismatch for %', v_internal_id;
    end if;
    if (v_item->>'tableRowsSha256') !~ '^[0-9a-f]{64}$' then raise exception 'invalid membership SHA-256 for %', v_internal_id; end if;

    perform pg_advisory_xact_lock(hashtextextended('tam-company:' || v_internal_id, 0));
    v_company_id := tam_canonical_company_id(v_internal_id);
    v_company_name := nullif(btrim(v_item->>'companyName'), '');
    if v_company_name is null then
      select nullif(btrim(row_value->>'COMPANY NAME'), '') into v_company_name
      from jsonb_array_elements(v_table_rows) row_value
      where nullif(btrim(row_value->>'COMPANY NAME'), '') is not null
      limit 1;
    end if;
    if v_company_name is null then raise exception 'current NetSuite ID % has no company name', v_internal_id; end if;

    if v_company_id is null then
      insert into companies (
        name, domain, source, status, sources, lists, claimable, is_base,
        lead_vendor, netsuite_internal_id, in_territory, first_seen_at,
        last_updated_at
      ) values (
        v_company_name, null, 'imported', 'new', '["netsuite"]'::jsonb,
        array['netsuite_tam'], true, true, 'netsuite', v_internal_id, true,
        v_now, v_now
      ) returning id into v_company_id;
      v_inserted := v_inserted + 1;
    else
      -- Recheck after acquiring the exact-ID lock, including unresolved active duplicates.
      select count(*) into v_company_count
      from companies c
      where c.netsuite_internal_id = v_internal_id
        and not ('tam_duplicate' = any(coalesce(c.lists, '{}'::text[])));
      if v_company_count <> 1 then raise exception 'exact NetSuite Internal ID % is ambiguous', v_internal_id; end if;
      update companies
      set name = v_company_name,
          lists = array(select distinct value from unnest(coalesce(lists, '{}'::text[]) || array['netsuite_tam']) value order by value),
          claimable = true,
          is_base = true,
          lead_vendor = 'netsuite',
          in_territory = true,
          status = case when status = 'removed_from_tam' then 'new' else status end,
          last_updated_at = v_now
      where id = v_company_id;
      v_updated := v_updated + 1;
    end if;

    insert into tam_regrade_records (
      run_id, netsuite_internal_id, company_id, company_name, is_current,
      membership_status, table_row, source_page, source_row, table_rows,
      source_coordinates, saved_search_row_count, table_rows_sha256, last_actor
    ) values (
      v_run_id, v_internal_id, v_company_id, v_company_name, true,
      v_item->>'membershipStatus', v_table_rows->0,
      (v_coordinates->0->>'page')::int, (v_coordinates->0->>'row')::int,
      v_table_rows, v_coordinates, v_row_count, v_item->>'tableRowsSha256',
      p_actor_key
    )
    on conflict (run_id, netsuite_internal_id) do update
    set company_id = excluded.company_id,
        company_name = excluded.company_name,
        is_current = true,
        membership_status = excluded.membership_status,
        table_row = excluded.table_row,
        source_page = excluded.source_page,
        source_row = excluded.source_row,
        table_rows = excluded.table_rows,
        source_coordinates = excluded.source_coordinates,
        saved_search_row_count = excluded.saved_search_row_count,
        table_rows_sha256 = excluded.table_rows_sha256,
        last_actor = excluded.last_actor;
    v_upserted := v_upserted + 1;
  end loop;

  update tam_regrade_runs
  set source_total = coalesce(p_source_total, source_total),
      source_snapshot_sha256 = coalesce(p_source_snapshot_sha256, source_snapshot_sha256),
      last_heartbeat_at = v_now
  where id = v_run_id;

  insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
  values (
    v_run_id, p_actor_key, 'membership.upserted',
    format('Upserted %s current TAM records by exact NetSuite ID', v_upserted),
    jsonb_build_object(
      'count', v_upserted, 'companies_inserted', v_inserted,
      'companies_updated', v_updated, 'source_total', p_source_total,
      'source_snapshot_sha256', p_source_snapshot_sha256
    )
  );

  return jsonb_build_object(
    'upserted', v_upserted,
    'distinctIds', v_upserted,
    'companiesInserted', v_inserted,
    'companiesUpdated', v_updated
  );
end;
$$;

create or replace function remove_tam_regrade_membership(
  p_run_slug text,
  p_actor_key text,
  p_netsuite_internal_ids text[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_internal_id text;
  v_company_id uuid;
  v_now timestamptz := now();
  v_removed int := 0;
begin
  if nullif(btrim(p_actor_key), '') is null then raise exception 'actor key is required'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'removal reason is required'; end if;
  if coalesce(cardinality(p_netsuite_internal_ids), 0) = 0 or cardinality(p_netsuite_internal_ids) > 1000 then raise exception 'removal batch must contain 1-1000 exact IDs'; end if;
  if (select count(distinct value) from unnest(p_netsuite_internal_ids) value) <> cardinality(p_netsuite_internal_ids) then raise exception 'removal batch repeats an exact Internal ID'; end if;
  if exists (select 1 from unnest(p_netsuite_internal_ids) value where value !~ '^[0-9]+$') then raise exception 'removal batch contains an invalid exact Internal ID'; end if;

  select id into v_run_id from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;

  foreach v_internal_id in array p_netsuite_internal_ids
  loop
    perform pg_advisory_xact_lock(hashtextextended('tam-company:' || v_internal_id, 0));
    v_company_id := tam_canonical_company_id(v_internal_id);
    if v_company_id is not null then
      update companies
      set lists = array_remove(coalesce(lists, '{}'::text[]), 'netsuite_tam'),
          claimable = false,
          status = 'removed_from_tam',
          last_updated_at = v_now
      where id = v_company_id;
    end if;

    insert into tam_regrade_records (
      run_id, netsuite_internal_id, company_id, is_current,
      membership_status, grade_status, last_actor
    ) values (
      v_run_id, v_internal_id, v_company_id, false, 'removed', 'pending', p_actor_key
    )
    on conflict (run_id, netsuite_internal_id) do update
    set company_id = coalesce(excluded.company_id, tam_regrade_records.company_id),
        is_current = false,
        membership_status = 'removed',
        grade_status = case
          when tam_regrade_records.grade_status = 'reading' then 'pending'
          else tam_regrade_records.grade_status
        end,
        hold_reason = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.hold_reason
        end,
        claim_actor = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.claim_actor
        end,
        claim_token = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.claim_token
        end,
        claim_started_at = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.claim_started_at
        end,
        claim_heartbeat_at = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.claim_heartbeat_at
        end,
        claim_expires_at = case
          when tam_regrade_records.grade_status = 'reading' then null
          else tam_regrade_records.claim_expires_at
        end,
        last_actor = excluded.last_actor;
    v_removed := v_removed + 1;
  end loop;

  insert into tam_regrade_events (run_id, actor_key, kind, summary, metadata)
  values (
    v_run_id, p_actor_key, 'membership.removed',
    format('Marked %s TAM records removed without deleting history', v_removed),
    jsonb_build_object('count', v_removed, 'reason', p_reason)
  );
  return jsonb_build_object('removed', v_removed);
end;
$$;

create or replace function update_tam_regrade_pdf(
  p_run_slug text,
  p_actor_key text,
  p_netsuite_internal_id text,
  p_status text,
  p_object_path text,
  p_sha256 text,
  p_page_count int,
  p_verified_at timestamptz,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_record tam_regrade_records%rowtype;
begin
  select id into v_run_id from tam_regrade_runs where slug = p_run_slug;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  select * into v_record from tam_regrade_records
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  for update;
  if not found or not v_record.is_current then raise exception 'current TAM record not found: %', p_netsuite_internal_id; end if;

  if v_record.grade_status in ('reading','final','published') then
    if p_status = v_record.pdf_status
       and coalesce(p_object_path, v_record.pdf_object_path) is not distinct from v_record.pdf_object_path
       and coalesce(p_sha256, v_record.pdf_sha256) is not distinct from v_record.pdf_sha256
       and coalesce(p_page_count, v_record.pdf_page_count) is not distinct from v_record.pdf_page_count
       and coalesce(p_verified_at, v_record.pdf_verified_at) is not distinct from v_record.pdf_verified_at
       and p_error is not distinct from v_record.pdf_error then
      return to_jsonb(v_record);
    end if;
    raise exception 'PDF evidence is immutable while record % is %', p_netsuite_internal_id, v_record.grade_status;
  end if;

  update tam_regrade_records
  set pdf_status = p_status,
      pdf_object_path = coalesce(p_object_path, pdf_object_path),
      pdf_sha256 = coalesce(p_sha256, pdf_sha256),
      pdf_page_count = coalesce(p_page_count, pdf_page_count),
      pdf_verified_at = coalesce(p_verified_at, pdf_verified_at),
      pdf_error = p_error,
      last_actor = p_actor_key
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  returning * into v_record;

  insert into tam_regrade_events (
    run_id, actor_key, kind, netsuite_internal_id, summary, metadata
  ) values (
    v_run_id, p_actor_key, 'pdf.' || p_status, p_netsuite_internal_id,
    format('PDF %s for NetSuite ID %s', p_status, p_netsuite_internal_id),
    jsonb_build_object('object_path', p_object_path, 'sha256', p_sha256, 'page_count', p_page_count, 'error', p_error)
  );
  return to_jsonb(v_record);
end;
$$;

-- Claims are serialized by the exact record row lock and fenced with a token.
-- An active claim can be resumed only with its token. An expired claim receives
-- a new token/generation, so the stale worker cannot heartbeat, release or write.
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
  if exists (
    select 1 from tam_regrade_records
    where run_id = v_run_id
      and netsuite_internal_id <> p_netsuite_internal_id
      and grade_status = 'reading'
      and claim_expires_at > v_now
  ) then
    raise exception 'another exact TAM record already has the run active lease';
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

create or replace function heartbeat_tam_regrade_actor(
  p_run_slug text,
  p_actor_key text,
  p_status text,
  p_current_work text,
  p_metadata jsonb,
  p_netsuite_internal_id text,
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
  v_actor tam_regrade_actors%rowtype;
  v_now timestamptz := now();
begin
  if nullif(btrim(p_actor_key), '') is null then raise exception 'actor key is required'; end if;
  if p_status not in ('idle','working','blocked','offline','complete') then raise exception 'invalid actor status'; end if;
  if (p_netsuite_internal_id is null) <> (p_claim_token is null) then raise exception 'exact Internal ID and claim token must be supplied together'; end if;
  if p_claim_token is not null and (p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 3600) then raise exception 'lease must be between 60 and 3600 seconds'; end if;

  select id, status into v_run_id, v_run_status from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;

  if p_claim_token is not null then
    if v_run_status <> 'grading' then raise exception 'TAM regrade run % is %, not grading', p_run_slug, v_run_status; end if;
    select * into v_record from tam_regrade_records
    where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
    for update;
    if not found
       or v_record.grade_status <> 'reading'
       or not v_record.is_current
       or v_record.claim_actor is distinct from p_actor_key
       or v_record.claim_token is distinct from p_claim_token
       or v_record.claim_expires_at <= v_now then
      raise exception 'claim heartbeat rejected for stale or unowned NetSuite ID %', p_netsuite_internal_id;
    end if;
    update tam_regrade_records
    set claim_heartbeat_at = v_now,
        claim_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_actor = p_actor_key
    where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
    returning * into v_record;
  end if;

  insert into tam_regrade_actors (
    run_id, actor_key, status, current_work, metadata, heartbeat_at
  ) values (
    v_run_id, p_actor_key, p_status, p_current_work,
    coalesce(p_metadata, '{}'::jsonb), v_now
  )
  on conflict (run_id, actor_key) do update
  set status = excluded.status,
      current_work = excluded.current_work,
      metadata = excluded.metadata,
      heartbeat_at = excluded.heartbeat_at
  returning * into v_actor;
  update tam_regrade_runs set last_heartbeat_at = v_now where id = v_run_id;

  return jsonb_build_object(
    'actor', to_jsonb(v_actor),
    'claim', case when p_claim_token is null then null else jsonb_build_object(
      'netsuite_internal_id', v_record.netsuite_internal_id,
      'claim_actor', v_record.claim_actor,
      'claim_generation', v_record.claim_generation,
      'claim_heartbeat_at', v_record.claim_heartbeat_at,
      'claim_expires_at', v_record.claim_expires_at
    ) end
  );
end;
$$;

create or replace function set_tam_regrade_work_status(
  p_run_slug text,
  p_netsuite_internal_id text,
  p_actor_key text,
  p_claim_token uuid,
  p_status text,
  p_hold_reason text
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
begin
  if p_status not in ('pending','hold') then raise exception 'grade work status must be pending or hold'; end if;
  if p_status = 'hold' and nullif(btrim(p_hold_reason), '') is null then raise exception 'held grade needs a reason'; end if;
  select id, status into v_run_id, v_run_status from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  if v_run_status <> 'grading' then raise exception 'TAM regrade run % is %, not grading', p_run_slug, v_run_status; end if;
  select * into v_record from tam_regrade_records
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  for update;
  if not found
     or not v_record.is_current
     or v_record.grade_status <> 'reading'
     or v_record.claim_actor is distinct from p_actor_key
     or v_record.claim_token is distinct from p_claim_token
     or v_record.claim_expires_at <= v_now then
    raise exception 'grade status change rejected for stale or unowned NetSuite ID %', p_netsuite_internal_id;
  end if;

  update tam_regrade_records
  set grade_status = p_status,
      hold_reason = case when p_status = 'hold' then btrim(p_hold_reason) else null end,
      last_actor = p_actor_key,
      claim_actor = null,
      claim_token = null,
      claim_started_at = null,
      claim_heartbeat_at = null,
      claim_expires_at = null
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  returning * into v_record;

  insert into tam_regrade_events (
    run_id, actor_key, kind, netsuite_internal_id, summary, metadata
  ) values (
    v_run_id, p_actor_key, 'grade.' || p_status, p_netsuite_internal_id,
    format('Grade %s for NetSuite ID %s', p_status, p_netsuite_internal_id),
    jsonb_build_object('hold_reason', p_hold_reason)
  );
  return jsonb_build_object(
    'netsuite_internal_id', v_record.netsuite_internal_id,
    'grade_status', v_record.grade_status,
    'hold_reason', v_record.hold_reason,
    'last_actor', v_record.last_actor
  );
end;
$$;

-- Publish one independently validated final under the exact active lease. The
-- raw grade is stored in codex_score; only record_dead or a confirmed NetSuite
-- incumbent can hard-zero tam_score. Public signals are structurally absent.
create or replace function publish_tam_regrade_final(
  p_run_slug text,
  p_netsuite_internal_id text,
  p_actor_key text,
  p_claim_token uuid,
  p_final_score numeric,
  p_record_digest text,
  p_provenance_sha256 text,
  p_validated_by text,
  p_validated_at timestamptz,
  p_provenance jsonb,
  p_assessment_old_gold_score numeric,
  p_old_gold_class text,
  p_old_gold_reasons jsonb,
  p_intro_call_exists boolean,
  p_opportunity_exists boolean,
  p_revisit_on date,
  p_record_dead boolean,
  p_record_dead_reason text,
  p_assessment_score_note text,
  p_provenance_canonical_json text,
  p_provenance_object_path text
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
  v_company companies%rowtype;
  v_company_count int;
  v_now timestamptz := now();
  v_hard_zero_reason text;
  v_tam_score numeric;
  v_old_gold_member boolean;
  v_live_old_gold_score numeric;
  v_score_note text;
  v_opportunity_text text;
begin
  if p_netsuite_internal_id is null or p_netsuite_internal_id !~ '^[0-9]+$' then raise exception 'exact numeric NetSuite Internal ID is required'; end if;
  if nullif(btrim(p_actor_key), '') is null or p_claim_token is null then raise exception 'actor and claim token are required'; end if;
  if p_final_score is null or p_final_score < 0 or p_final_score > 100 then raise exception 'raw final score must be between 0 and 100'; end if;
  if nullif(btrim(p_record_digest), '') is null then raise exception 'record digest is required'; end if;
  if p_provenance_sha256 is null or p_provenance_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'valid lowercase SHA-256 grade provenance is required'; end if;
  if nullif(p_provenance_canonical_json, '') is null
     or nullif(btrim(p_provenance_object_path), '') is null then
    raise exception 'canonical provenance bytes and object path are required';
  end if;
  if encode(digest(convert_to(p_provenance_canonical_json, 'UTF8'), 'sha256'), 'hex')
       is distinct from p_provenance_sha256 then
    raise exception 'grade provenance SHA-256 does not match canonical provenance bytes';
  end if;
  if p_provenance_canonical_json::jsonb is distinct from p_provenance then
    raise exception 'canonical provenance bytes do not match structured provenance';
  end if;
  if nullif(btrim(p_validated_by), '') is null or p_validated_at is null then raise exception 'passed validation identity and time are required'; end if;
  if p_validated_at > v_now + interval '5 minutes' then raise exception 'validation time cannot be in the future'; end if;
  if p_assessment_old_gold_score is null or p_assessment_old_gold_score < 0 or p_assessment_old_gold_score > 100 then raise exception 'assessment Old Gold score is required on the 0-100 scale'; end if;
  if nullif(btrim(p_old_gold_class), '') is null or jsonb_typeof(p_old_gold_reasons) <> 'array' then raise exception 'complete Old Gold assessment evidence is required'; end if;
  if p_intro_call_exists is null or p_opportunity_exists is null or p_record_dead is null then raise exception 'current assessment booleans are required'; end if;
  if p_final_score <= 10 and (not p_record_dead or p_assessment_old_gold_score <> 0) then raise exception 'dead-band final requires record_dead and assessment Old Gold score 0'; end if;
  if p_record_dead and nullif(btrim(p_record_dead_reason), '') is null then raise exception 'record-dead final needs a specific reason'; end if;
  if not p_record_dead and nullif(btrim(coalesce(p_record_dead_reason, '')), '') is not null then raise exception 'non-dead final cannot carry a record-dead reason'; end if;
  if jsonb_typeof(p_provenance) <> 'object' then raise exception 'structured grade provenance is required'; end if;
  if p_provenance->>'runSlug' is distinct from p_run_slug
     or p_provenance->>'netsuiteInternalId' is distinct from p_netsuite_internal_id
     or p_provenance->>'schema' is distinct from 'tam-grade-provenance'
     or (p_provenance->>'version')::int is distinct from 1
     or p_provenance->>'snapshotSha256' !~ '^[0-9a-f]{64}$'
     or p_provenance->>'method' is distinct from 'full-record-reader-plus-independent-full-record-validator'
     or p_provenance->>'pdfSha256' !~ '^[0-9a-f]{64}$'
     or p_provenance->>'recordTextSha256' !~ '^[0-9a-f]{64}$'
     or p_provenance->>'candidateFileSha256' !~ '^[0-9a-f]{64}$'
     or p_provenance->>'validatorOutputSha256' !~ '^[0-9a-f]{64}$'
     or p_provenance->>'validatorHashScope' is distinct from 'canonical-record'
     or jsonb_typeof(p_provenance->'assessment') <> 'object' then
    raise exception 'grade provenance identity/full-read contract mismatch';
  end if;
  if (p_provenance->'assessment'->>'exact_id') is distinct from p_netsuite_internal_id
     or (p_provenance->'assessment'->>'final_score')::numeric is distinct from p_final_score
     or (p_provenance->'assessment'->>'record_digest') is distinct from p_record_digest
     or (p_provenance->'assessment'->>'old_gold_score')::numeric is distinct from p_assessment_old_gold_score
     or (p_provenance->'assessment'->>'old_gold_class') is distinct from p_old_gold_class
     or (p_provenance->'assessment'->'old_gold_reasons') is distinct from p_old_gold_reasons
     or (p_provenance->'assessment'->>'intro_call_exists')::boolean is distinct from p_intro_call_exists
     or (p_provenance->'assessment'->>'opportunity_exists')::boolean is distinct from p_opportunity_exists
     or (p_provenance->'assessment'->>'revisit_on')::date is distinct from p_revisit_on
     or (p_provenance->'assessment'->>'score_adjust_note') is distinct from coalesce(p_assessment_score_note, '')
     or (p_record_dead and (p_provenance->'assessment'->>'dq_reason') is distinct from p_record_dead_reason)
     or (p_provenance->'assessment'->'validation'->>'status') is distinct from 'passed'
     or (p_provenance->'assessment'->'validation'->>'validated_by') is distinct from p_validated_by
     or (p_provenance->'assessment'->'validation'->>'validated_at')::timestamptz is distinct from p_validated_at then
    raise exception 'grade provenance assessment differs from publish fields';
  end if;

  select id, status into v_run_id, v_run_status from tam_regrade_runs where slug = p_run_slug for update;
  if not found then raise exception 'TAM regrade run not found: %', p_run_slug; end if;
  select * into v_record from tam_regrade_records
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  for update;
  if not found then raise exception 'record is not registered in this TAM run: %', p_netsuite_internal_id; end if;

  if v_record.company_id is null then raise exception 'TAM record has no canonical company mapping'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tam-company:' || p_netsuite_internal_id, 0));
  select count(*) into v_company_count
  from companies c
  where c.netsuite_internal_id = p_netsuite_internal_id
    and not ('tam_duplicate' = any(coalesce(c.lists, '{}'::text[])));
  if v_company_count <> 1 then raise exception 'exact NetSuite Internal ID % maps to % non-retired companies; expected 1', p_netsuite_internal_id, v_company_count; end if;
  select * into v_company from companies c
  where c.id = v_record.company_id
    and c.netsuite_internal_id = p_netsuite_internal_id
    and not ('tam_duplicate' = any(coalesce(c.lists, '{}'::text[])))
  for update;
  if not found then raise exception 'stored company mapping for NetSuite ID % is stale or retired', p_netsuite_internal_id; end if;

  v_hard_zero_reason := case
    when p_record_dead then 'record dead'
    when lower(btrim(coalesce(v_company.erp_incumbent, ''))) = 'netsuite' then 'already on NetSuite'
    else null
  end;
  v_tam_score := case when v_hard_zero_reason is null then p_final_score else 0 end;
  v_opportunity_text := p_record_digest || ' ' || coalesce((
    select string_agg(value, ' ') from jsonb_array_elements_text(p_old_gold_reasons) value
  ), '');
  v_old_gold_member := (
    nullif(btrim(v_company.qual_note), '') is not null
    and v_company.last_sql_date is not null
  ) or v_opportunity_text ~* '(^|[^[:alnum:]_])Opportunity (created|confirmed):[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)';
  v_live_old_gold_score := case
    when not v_old_gold_member then null
    when v_hard_zero_reason is not null then 0
    else p_assessment_old_gold_score
  end;
  v_score_note := left(
    case when nullif(btrim(p_assessment_score_note), '') is null
      then '' else btrim(p_assessment_score_note) || '; ' end
    || case when v_hard_zero_reason is null
      then 'TAM equals raw grade; public signals are Triggered-only'
      else format('hard 0 - %s', v_hard_zero_reason)
    end,
    400
  );

  -- Preserve successful retries after publication, even after the lease time has
  -- passed, but only for the exact actor/token, byte-equivalent final and exact
  -- current company readback. A later writer's drift must never look successful.
  if v_record.grade_status = 'published' then
    if v_record.claim_actor is not distinct from p_actor_key
       and v_record.claim_token is not distinct from p_claim_token
       and v_record.final_score is not distinct from p_final_score
       and v_record.codex_score is not distinct from p_final_score
       and v_record.tam_score is not distinct from v_tam_score
       and v_record.score_adjust_note is not distinct from v_score_note
       and v_record.record_digest is not distinct from p_record_digest
       and v_record.grade_provenance_sha256 is not distinct from p_provenance_sha256
       and v_record.grade_provenance is not distinct from p_provenance
       and v_record.assessment_old_gold_score is not distinct from p_assessment_old_gold_score
       and v_record.old_gold_class is not distinct from p_old_gold_class
       and v_record.old_gold_reasons is not distinct from p_old_gold_reasons
       and v_record.intro_call_exists is not distinct from p_intro_call_exists
       and v_record.opportunity_exists is not distinct from p_opportunity_exists
       and v_record.revisit_on is not distinct from p_revisit_on
       and v_record.record_dead is not distinct from p_record_dead
       and v_record.record_dead_reason is not distinct from p_record_dead_reason
       and v_record.assessment_score_note is not distinct from p_assessment_score_note
       and v_record.grade_provenance_canonical_json is not distinct from p_provenance_canonical_json
       and v_record.grade_provenance_object_path is not distinct from p_provenance_object_path
       and v_record.validated_by is not distinct from p_validated_by
       and v_record.validated_at is not distinct from p_validated_at then
      if v_company.codex_score is distinct from p_final_score
         or v_company.tam_score is distinct from v_tam_score
         or v_company.oldgold_score is distinct from v_live_old_gold_score
         or v_company.oldgold_class is distinct from p_old_gold_class
         or v_company.oldgold_reasons is distinct from p_old_gold_reasons
         or v_company.revisit_on is distinct from p_revisit_on
         or v_company.record_dead is distinct from p_record_dead
         or v_company.record_dead_reason is distinct from case
           when p_record_dead then p_record_dead_reason else null end
         or v_company.record_digest is distinct from p_record_digest
         or v_company.score_adjust_note is distinct from v_score_note
         or v_company.tam_provisional is distinct from false then
        raise exception 'published coordination final exists but exact company readback drifted for NetSuite ID %', p_netsuite_internal_id;
      end if;
      return jsonb_build_object(
        'run_id', v_run_id, 'company_id', v_record.company_id,
        'netsuite_internal_id', p_netsuite_internal_id,
        'final_score', v_record.final_score, 'tam_score', v_record.tam_score,
        'published_at', v_record.published_at, 'already_published', true
      );
    end if;
    raise exception 'NetSuite ID % already has a different published final', p_netsuite_internal_id;
  end if;

  if v_run_status <> 'grading' then raise exception 'TAM regrade run % is %, not grading', p_run_slug, v_run_status; end if;

  if not v_record.is_current or v_record.membership_status = 'removed' then raise exception 'removed/non-current TAM record cannot be published: %', p_netsuite_internal_id; end if;
  if v_record.pdf_status <> 'verified'
     or p_provenance->>'pdfSha256' is distinct from v_record.pdf_sha256
     or (p_provenance->>'pdfPageCount')::int is distinct from v_record.pdf_page_count then
    raise exception 'published provenance does not match the verified exact-ID PDF';
  end if;
  if v_record.grade_status <> 'reading'
     or v_record.claim_actor is distinct from p_actor_key
     or v_record.claim_token is distinct from p_claim_token
     or v_record.claim_expires_at <= v_now then
    raise exception 'publish rejected for stale or unowned NetSuite ID %', p_netsuite_internal_id;
  end if;

  update companies
  set codex_score = p_final_score,
      tam_score = v_tam_score,
      oldgold_score = v_live_old_gold_score,
      oldgold_class = p_old_gold_class,
      oldgold_reasons = p_old_gold_reasons,
      revisit_on = p_revisit_on,
      record_dead = p_record_dead,
      record_dead_reason = case when p_record_dead then p_record_dead_reason else null end,
      record_digest = p_record_digest,
      score_adjust_note = v_score_note,
      tam_provisional = false,
      last_updated_at = v_now
  where id = v_company.id;

  update tam_regrade_records
  set grade_status = 'published',
      hold_reason = null,
      final_score = p_final_score,
      codex_score = p_final_score,
      tam_score = v_tam_score,
      score_adjust_note = v_score_note,
      assessment_score_note = p_assessment_score_note,
      record_digest = p_record_digest,
      record_dead = p_record_dead,
      record_dead_reason = case when p_record_dead then p_record_dead_reason else null end,
      assessment_old_gold_score = p_assessment_old_gold_score,
      old_gold_class = p_old_gold_class,
      old_gold_reasons = p_old_gold_reasons,
      intro_call_exists = p_intro_call_exists,
      opportunity_exists = p_opportunity_exists,
      revisit_on = p_revisit_on,
      grade_provenance = p_provenance,
      grade_provenance_object_path = p_provenance_object_path,
      grade_provenance_canonical_json = p_provenance_canonical_json,
      grade_provenance_sha256 = p_provenance_sha256,
      validation_status = 'passed',
      validated_by = p_validated_by,
      validated_at = p_validated_at,
      graded_at = v_now,
      published_at = v_now,
      last_actor = p_actor_key
  where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id
  returning * into v_record;

  insert into tam_regrade_events (
    run_id, actor_key, kind, netsuite_internal_id, summary, metadata
  ) values (
    v_run_id, p_actor_key, 'grade.published', p_netsuite_internal_id,
    format('Published validated raw TAM grade %s for NetSuite ID %s', p_final_score, p_netsuite_internal_id),
    jsonb_build_object(
      'raw_final_score', p_final_score,
      'tam_score', v_tam_score,
      'hard_zero_reason', v_hard_zero_reason,
      'assessment_old_gold_score', p_assessment_old_gold_score,
      'live_old_gold_score', v_live_old_gold_score,
      'old_gold_class', p_old_gold_class,
      'intro_call_exists', p_intro_call_exists,
      'opportunity_exists', p_opportunity_exists,
      'provenance_sha256', p_provenance_sha256,
      'validated_by', p_validated_by,
      'validated_at', p_validated_at,
      'company_id', v_company.id,
      'claim_generation', v_record.claim_generation,
      'previous', jsonb_build_object(
        'codex_score', v_company.codex_score,
        'tam_score', v_company.tam_score,
        'oldgold_score', v_company.oldgold_score,
        'record_dead', v_company.record_dead,
        'record_digest', v_company.record_digest,
        'status', v_company.status
      )
    )
  );
  insert into tam_regrade_actors (run_id, actor_key, status, current_work, heartbeat_at)
  values (v_run_id, p_actor_key, 'working', format('Published NetSuite ID %s', p_netsuite_internal_id), v_now)
  on conflict (run_id, actor_key) do update
  set status = 'working', current_work = excluded.current_work,
      heartbeat_at = excluded.heartbeat_at;
  update tam_regrade_runs set last_heartbeat_at = v_now where id = v_run_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'company_id', v_company.id,
    'netsuite_internal_id', p_netsuite_internal_id,
    'final_score', p_final_score,
    'tam_score', v_tam_score,
    'oldgold_score', v_live_old_gold_score,
    'published_at', v_now,
    'already_published', false
  );
end;
$$;

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
    'lease_expired', count(*) filter (where is_current and grade_status = 'reading' and claim_expires_at <= now())
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
  return jsonb_build_object('run', to_jsonb(v_run), 'counts', v_counts, 'actors', v_actors, 'events', v_events);
end;
$$;

-- Machine-only state. There are deliberately no anon/authenticated policies.
alter table tam_regrade_runs enable row level security;
alter table tam_regrade_actors enable row level security;
alter table tam_regrade_records enable row level security;
alter table tam_regrade_events enable row level security;
revoke all on tam_regrade_runs, tam_regrade_actors, tam_regrade_records, tam_regrade_events
  from public, anon, authenticated;
grant select, insert, update, delete on tam_regrade_runs, tam_regrade_actors, tam_regrade_records
  to service_role;
grant select, insert on tam_regrade_events to service_role;
revoke all on sequence tam_regrade_events_id_seq from public, anon, authenticated;
grant usage, select on sequence tam_regrade_events_id_seq to service_role;

revoke all on function tam_canonical_company_id(text) from public, anon, authenticated;
revoke all on function bootstrap_tam_regrade_run(text,text,jsonb,text,int,text) from public, anon, authenticated;
revoke all on function upsert_tam_regrade_membership(text,text,jsonb,int,text) from public, anon, authenticated;
revoke all on function remove_tam_regrade_membership(text,text,text[],text) from public, anon, authenticated;
revoke all on function update_tam_regrade_pdf(text,text,text,text,text,text,int,timestamptz,text) from public, anon, authenticated;
revoke all on function claim_tam_regrade_record(text,text,text,boolean,uuid,int) from public, anon, authenticated;
revoke all on function heartbeat_tam_regrade_actor(text,text,text,text,jsonb,text,uuid,int) from public, anon, authenticated;
revoke all on function set_tam_regrade_work_status(text,text,text,uuid,text,text) from public, anon, authenticated;
revoke all on function publish_tam_regrade_final(text,text,text,uuid,numeric,text,text,text,timestamptz,jsonb,numeric,text,jsonb,boolean,boolean,date,boolean,text,text,text,text) from public, anon, authenticated;
revoke all on function get_tam_regrade_status(text,int) from public, anon, authenticated;

grant execute on function tam_canonical_company_id(text) to service_role;
grant execute on function bootstrap_tam_regrade_run(text,text,jsonb,text,int,text) to service_role;
grant execute on function upsert_tam_regrade_membership(text,text,jsonb,int,text) to service_role;
grant execute on function remove_tam_regrade_membership(text,text,text[],text) to service_role;
grant execute on function update_tam_regrade_pdf(text,text,text,text,text,text,int,timestamptz,text) to service_role;
grant execute on function claim_tam_regrade_record(text,text,text,boolean,uuid,int) to service_role;
grant execute on function heartbeat_tam_regrade_actor(text,text,text,text,jsonb,text,uuid,int) to service_role;
grant execute on function set_tam_regrade_work_status(text,text,text,uuid,text,text) to service_role;
grant execute on function publish_tam_regrade_final(text,text,text,uuid,numeric,text,text,text,timestamptz,jsonb,numeric,text,jsonb,boolean,boolean,date,boolean,text,text,text,text) to service_role;
grant execute on function get_tam_regrade_status(text,int) to service_role;

-- PDFs remain private and outside the application bundle.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tam-lead-records', 'tam-lead-records', false, 104857600,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';
