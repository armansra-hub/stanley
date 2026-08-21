-- 0054: A validated fail-closed hold is terminal for cohort progression.
-- It remains unpublished and cannot be silently converted to a grade, but it
-- must not make every later recovery cohort permanently unclaimable.

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
    and r.grade_status not in ('published', 'hold');

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
