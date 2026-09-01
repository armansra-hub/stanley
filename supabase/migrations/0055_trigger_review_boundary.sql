-- A review/dismissal acknowledges every trigger known at that time. Preserve the
-- boundary on the company so late discovery of older evidence cannot reheat it.
alter table companies
  add column if not exists trigger_reviewed_through timestamptz;

-- Current hidden rows have an authoritative status timestamp even when an old
-- bulk event receipt truncated its ID array.
update companies
set trigger_reviewed_through = last_updated_at
where status in ('reviewed', 'dismissed')
  and last_updated_at is not null
  and (trigger_reviewed_through is null or trigger_reviewed_through < last_updated_at);

-- Backfill the latest historical human review/dismissal from the canonical event
-- receipts. Existing reheats remain auditable; read-time freshness will show only
-- evidence whose event and detection timestamps are later than this boundary.
with decisions as (
  select
    ids.company_id::uuid as company_id,
    max(events.ts) as reviewed_through
  from app_events events
  cross join lateral jsonb_array_elements_text(coalesce(events.meta->'ids', '[]'::jsonb)) as ids(company_id)
  where events.module = 'headhunter'
    and events.kind = 'lead.status_changed'
    and events.meta->>'status' in ('reviewed', 'dismissed')
    and ids.company_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  group by ids.company_id
)
update companies company
set trigger_reviewed_through = decisions.reviewed_through
from decisions
where company.id = decisions.company_id
  and (company.trigger_reviewed_through is null or company.trigger_reviewed_through < decisions.reviewed_through);

create index if not exists companies_trigger_reviewed_through_idx
  on companies (trigger_reviewed_through)
  where trigger_reviewed_through is not null;

notify pgrst, 'reload schema';
