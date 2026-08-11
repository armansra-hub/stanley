-- 0050: one atomic, row-locked score write with complete before-images.
--
-- The historical bridge inserted snapshots and then upserted companies in separate
-- chunks. A later chunk could fail after earlier company writes committed, and the
-- upsert had to resend a stale company name. This RPC snapshots and UPDATEs every
-- target inside one PostgreSQL transaction; any validation, snapshot, or update
-- failure rolls the entire call back.
--
-- This forward migration also supersedes the historical scoring commentary in
-- already-applied 0034 without altering 0034's checksum: codex_score is the raw
-- independent grade; tam_score equals it except for record-derived hard zeros;
-- public signals rank only the Triggered worklist and never adjust either score.

-- Exactly one non-retired company may own a numeric NetSuite Internal ID. The
-- historical twin rows remain legal only while explicitly tagged tam_duplicate.
-- Building this index is also the deployment preflight: any unexpected active
-- duplicate aborts 0050 before the write RPC exists.
create unique index if not exists companies_canonical_netsuite_internal_id_idx
  on companies (netsuite_internal_id)
  where netsuite_internal_id ~ '^[0-9]+$'
    and not ('tam_duplicate' = any(coalesce(lists, '{}'::text[])));

create or replace function apply_agent_score_batch(
  p_label text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_company companies%rowtype;
  v_company_id uuid;
  v_internal_id text;
  v_count int := 0;
  v_resurfaced_ids text[] := '{}'::text[];
  v_raw_score numeric;
  v_effective_dead boolean;
  v_dead_reason text;
  v_hard_zero_reason text;
  v_tam_score numeric;
  v_old_gold_candidate numeric;
  v_old_gold_score numeric;
  v_record_digest text;
  v_old_gold_reasons jsonb;
  v_opportunity_text text;
  v_score_adjust_note text;
  v_hard_zeroed jsonb := '[]'::jsonb;
begin
  if nullif(btrim(p_label), '') is null or length(p_label) > 200 then
    raise exception 'score batch label must contain 1-200 characters';
  end if;
  if coalesce(jsonb_typeof(p_rows), 'null') <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 1000 then
    raise exception 'score batch must contain 1-1000 rows';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    where item ? 'name'
       or coalesce(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or not (item ?& array[
         'netsuite_internal_id', 'raw_score', 'old_gold_score_input', 'resurface_exported',
         'record_dead_input', 'record_dead_reason', 'record_dead_reason_provided',
         'record_digest', 'old_gold_class', 'old_gold_class_provided',
         'old_gold_reasons', 'old_gold_reasons_provided', 'revisit_on',
         'revisit_on_provided', 'fallback_last_sql', 'note_prefix'
       ])
       or coalesce(item->>'netsuite_internal_id', '') !~ '^[0-9]+$'
       or jsonb_typeof(item->'raw_score') <> 'number'
       or (item->>'raw_score')::numeric not between 0 and 100
       or jsonb_typeof(item->'old_gold_score_input') not in ('number','null')
       or (
         jsonb_typeof(item->'old_gold_score_input') = 'number'
         and (item->>'old_gold_score_input')::numeric not between 0 and 100
       )
       or jsonb_typeof(item->'resurface_exported') <> 'boolean'
       or jsonb_typeof(item->'record_dead_input') not in ('boolean','null')
       or jsonb_typeof(item->'record_dead_reason') not in ('string','null')
       or jsonb_typeof(item->'record_dead_reason_provided') <> 'boolean'
       or jsonb_typeof(item->'record_digest') not in ('string','null')
       or jsonb_typeof(item->'old_gold_class') not in ('string','null')
       or jsonb_typeof(item->'old_gold_class_provided') <> 'boolean'
       or jsonb_typeof(item->'old_gold_reasons') <> 'array'
       or jsonb_typeof(item->'old_gold_reasons_provided') <> 'boolean'
       or jsonb_typeof(item->'revisit_on') not in ('string','null')
       or jsonb_typeof(item->'revisit_on_provided') <> 'boolean'
       or jsonb_typeof(item->'fallback_last_sql') not in ('string','null')
       or jsonb_typeof(item->'note_prefix') <> 'string'
  ) then
    raise exception 'score batch contains an invalid row';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    group by item->>'id'
    having count(*) > 1
  ) then
    raise exception 'score batch repeats a company id';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    group by item->>'netsuite_internal_id'
    having count(*) > 1
  ) then
    raise exception 'score batch repeats a NetSuite Internal ID';
  end if;

  -- Coordinate with TAM membership/publish writers before locking company rows.
  -- Every score batch acquires exact-ID locks in the same stable order.
  for v_internal_id in
    select item->>'netsuite_internal_id'
    from jsonb_array_elements(p_rows) item
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('tam-company:' || v_internal_id, 0));
  end loop;

  -- Acquire every row lock in one stable order before taking any before-image.
  for v_company_id in
    select (item->>'id')::uuid
    from jsonb_array_elements(p_rows) item
    order by 1
  loop
    perform 1 from companies where id = v_company_id for update;
    if not found then raise exception 'score target not found: %', v_company_id; end if;
    if exists (
      select 1
      from tam_regrade_records r
      join tam_regrade_checkpoint_seeds s on s.run_id = r.run_id
      where r.company_id = v_company_id and r.is_current
    ) then
      raise exception 'current seeded TAM grades must publish through the fenced coordinator: %', v_company_id;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    v_company_id := (v_item->>'id')::uuid;
    v_internal_id := v_item->>'netsuite_internal_id';
    select * into strict v_company from companies where id = v_company_id;
    if v_company.netsuite_internal_id is distinct from v_internal_id
       or tam_canonical_company_id(v_internal_id) is distinct from v_company_id then
      raise exception 'score target no longer has one canonical NetSuite mapping: %', v_internal_id;
    end if;

    v_raw_score := (v_item->>'raw_score')::numeric;
    v_effective_dead := case
      when jsonb_typeof(v_item->'record_dead_input') = 'boolean'
        then (v_item->>'record_dead_input')::boolean
      else coalesce(v_company.record_dead, false)
    end;
    v_dead_reason := case
      when not v_effective_dead then null
      when (v_item->>'record_dead_reason_provided')::boolean
        then nullif(btrim(v_item->>'record_dead_reason'), '')
      else nullif(btrim(v_company.record_dead_reason), '')
    end;
    if v_effective_dead and v_dead_reason is null then
      raise exception 'effective dead score target lacks a specific reason: %', v_company_id;
    end if;
    v_record_digest := case
      when nullif(btrim(v_item->>'record_digest'), '') is not null
        then v_item->>'record_digest'
      else v_company.record_digest
    end;
    v_old_gold_reasons := case
      when (v_item->>'old_gold_reasons_provided')::boolean
        then v_item->'old_gold_reasons'
      else coalesce(v_company.oldgold_reasons, '[]'::jsonb)
    end;
    if jsonb_typeof(v_old_gold_reasons) <> 'array' then
      raise exception 'effective Old Gold reasons are not an array: %', v_company_id;
    end if;
    v_hard_zero_reason := case
      when v_effective_dead then 'record dead'
      when lower(btrim(coalesce(v_company.erp_incumbent, ''))) = 'netsuite'
        then 'already on NetSuite'
      else null
    end;
    v_tam_score := case when v_hard_zero_reason is null then v_raw_score else 0 end;
    v_old_gold_candidate := case
      when v_hard_zero_reason is not null then 0
      else coalesce((v_item->>'old_gold_score_input')::numeric, v_tam_score)
    end;
    -- Membership is derived from the exact post-write evidence. A correction
    -- can remove a stale Opportunity marker, while an omitted reasons field
    -- preserves and evaluates the row-locked current reasons.
    v_opportunity_text := coalesce(v_record_digest, '') || ' '
      || coalesce((
        select string_agg(value, ' ')
        from jsonb_array_elements_text(v_old_gold_reasons) value
      ), '');
    v_old_gold_score := case
      when not (
        (
          nullif(btrim(v_company.qual_note), '') is not null
          and coalesce(v_company.last_sql_date, (v_item->>'fallback_last_sql')::date) is not null
        )
        or v_opportunity_text ~* '(^|[^[:alnum:]_])Opportunity (created|confirmed):[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)'
      ) then null
      else v_old_gold_candidate
    end;
    v_score_adjust_note := left(
      case when nullif(btrim(v_item->>'note_prefix'), '') is null
        then '' else btrim(v_item->>'note_prefix') || '; ' end
      || case when v_hard_zero_reason is null
        then 'TAM equals raw grade; public signals are Triggered-only'
        else format('hard 0 - %s', v_hard_zero_reason)
      end,
      400
    );

    insert into score_snapshots (
      label, company_id, netsuite_internal_id, tam_score, codex_score,
      oldgold_score, score_adjust_note, prior_values
    ) values (
      p_label,
      v_company.id,
      v_company.netsuite_internal_id,
      v_company.tam_score,
      v_company.codex_score,
      v_company.oldgold_score,
      v_company.score_adjust_note,
      jsonb_build_object(
        'tam_score', v_company.tam_score,
        'codex_score', v_company.codex_score,
        'oldgold_score', v_company.oldgold_score,
        'score_adjust_note', v_company.score_adjust_note,
        'tam_provisional', v_company.tam_provisional,
        'status', v_company.status,
        'record_dead', v_company.record_dead,
        'record_dead_reason', v_company.record_dead_reason,
        'record_digest', v_company.record_digest,
        'oldgold_class', v_company.oldgold_class,
        'oldgold_reasons', v_company.oldgold_reasons,
        'revisit_on', v_company.revisit_on
      )
    );

    update companies
    set tam_score = v_tam_score,
        codex_score = v_raw_score,
        oldgold_score = v_old_gold_score,
        tam_provisional = false,
        status = case
          when (v_item->>'resurface_exported')::boolean
            and companies.claimable
            and 'netsuite_tam' = any(coalesce(companies.lists, '{}'::text[]))
            and companies.status in ('exported_csv','exported_sql')
          then 'new'
          else companies.status
        end,
        record_dead = v_effective_dead,
        record_dead_reason = v_dead_reason,
        record_digest = v_record_digest,
        oldgold_class = case
          when (v_item->>'old_gold_class_provided')::boolean then v_item->>'old_gold_class'
          else companies.oldgold_class
        end,
        oldgold_reasons = v_old_gold_reasons,
        revisit_on = case
          when (v_item->>'revisit_on_provided')::boolean then (v_item->>'revisit_on')::date
          else companies.revisit_on
        end,
        score_adjust_note = v_score_adjust_note
    where id = v_company_id;
    if not found then raise exception 'score target disappeared: %', v_company_id; end if;
    if (v_item->>'resurface_exported')::boolean
       and v_company.claimable
       and 'netsuite_tam' = any(coalesce(v_company.lists, '{}'::text[]))
       and v_company.status in ('exported_csv','exported_sql') then
      v_resurfaced_ids := array_append(v_resurfaced_ids, v_company.netsuite_internal_id);
    end if;
    if v_hard_zero_reason is not null then
      v_hard_zeroed := v_hard_zeroed || jsonb_build_array(jsonb_build_object(
        'name', v_company.name,
        'reason', v_hard_zero_reason
      ));
    end if;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'written', v_count,
    'label', p_label,
    'hard_zeroed', v_hard_zeroed,
    'resurfaced', cardinality(v_resurfaced_ids),
    'resurfaced_internal_ids', to_jsonb(v_resurfaced_ids)
  );
end;
$$;

revoke all on function apply_agent_score_batch(text,jsonb) from public, anon, authenticated;
grant execute on function apply_agent_score_batch(text,jsonb) to service_role;

notify pgrst, 'reload schema';
