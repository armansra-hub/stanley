-- 0048: durable, fair reservation for cached-priority recomputation.
--
-- Ordering by the mutable priority value repeatedly starved higher-priority rows,
-- while a full ghost batch left no room for priority-zero "zombies" whose inline
-- recompute had failed. The reservation cursor is independent of priority and the
-- RPC protects a bounded zombie share while allowing either bucket to fill unused
-- capacity. Callers reserve only the next immediately attempted micro-batch.

alter table companies
  add column if not exists priority_recompute_reserved_at timestamptz;

create index if not exists companies_priority_recompute_rotation_idx
  on companies (priority_recompute_reserved_at asc nulls first, id);

create index if not exists triggers_company_detected_idx
  on triggers (company_id, detected_at desc);

create or replace function reserve_priority_recompute(
  p_epoch timestamptz,
  p_limit integer,
  p_zombie_slots integer
)
returns table (company_id uuid, reservation_kind text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_trigger_cutoff timestamptz := v_now - interval '120 days';
begin
  if p_epoch is null or p_epoch > v_now then
    raise exception 'priority reservation requires a non-future UTC daily epoch';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'priority reservation limit must be between 1 and 100';
  end if;
  if p_zombie_slots is null or p_zombie_slots < 0 or p_zombie_slots > p_limit then
    raise exception 'priority zombie slots must be between 0 and the reservation limit';
  end if;

  -- The quota is a property of the whole reservation, so serialize this short
  -- catalog-only transaction. Row locks still avoid waiting on unrelated writers.
  perform pg_advisory_xact_lock(hashtext('stanley:reserve_priority_recompute'));

  return query
    with eligible as materialized (
      select
        c.id,
        c.priority_recompute_reserved_at as prior_reserved_at,
        case when coalesce(c.priority, 0) <= 0 then 'zombie' else 'ghost' end as kind,
        row_number() over (
          partition by case when coalesce(c.priority, 0) <= 0 then 'zombie' else 'ghost' end
          order by c.priority_recompute_reserved_at asc nulls first, c.id
        ) as bucket_rank
      from companies c
      where (c.priority_recompute_reserved_at is null or c.priority_recompute_reserved_at < p_epoch)
        and (
          c.priority > 0
          or (
            coalesce(c.priority, 0) <= 0
            and exists (
              select 1
              from triggers t
              where t.company_id = c.id
                and t.detected_at > v_trigger_cutoff
                and t.metadata #> '{stanley_quarantine,active}' is distinct from 'true'::jsonb
            )
          )
        )
    ), prioritized as materialized (
      select e.*
      from eligible e
      order by
        case
          when e.kind = 'zombie' and e.bucket_rank <= p_zombie_slots then 0
          when e.kind = 'ghost' and e.bucket_rank <= (p_limit - p_zombie_slots) then 0
          else 1
        end,
        e.prior_reserved_at asc nulls first,
        e.id
      limit p_limit
    ), selected as materialized (
      select p.id, p.kind, p.prior_reserved_at
      from companies c
      join prioritized p on p.id = c.id
      order by p.prior_reserved_at asc nulls first, p.id
      for update of c skip locked
    ), reserved as (
      update companies c
      set priority_recompute_reserved_at = clock_timestamp()
      from selected s
      where c.id = s.id
      returning c.id
    )
    select r.id, s.kind
    from reserved r
    join selected s on s.id = r.id
    order by s.prior_reserved_at asc nulls first, r.id;
end;
$$;

revoke all on function reserve_priority_recompute(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function reserve_priority_recompute(timestamptz, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
