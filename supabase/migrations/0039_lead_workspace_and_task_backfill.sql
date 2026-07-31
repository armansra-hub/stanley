-- 0039: make every Kill List card a complete call workspace and repair any
-- already-created dated tasks that were not mirrored into Missions.

alter table leads add column if not exists intro_call_transcript_url text;
alter table leads add column if not exists summary text;
alter table leads add column if not exists notes text;

-- The USGP intro call is the first complete workspace record.
update leads
set
  intro_call_transcript_url = coalesce(intro_call_transcript_url, '/intro-call-transcripts/usgp-intro-call.pdf'),
  summary = coalesce(summary, 'Government contract staffing/services firm (~800 workers, $85-90M this year; ~$100M projected next year). Joshua Graves, CEO/President/Owner, is the economic buyer and champion. They need one live source of truth across recruiting, credentialing, onboarding, time, HR, and contract profitability.'),
  notes = coalesce(notes, 'Current stack: QuickBooks Online, Monday.com, Paycom, Excel, and an in-progress Microsoft GCC transition. Immediate agreed commercial step: a one-hour Solutions Architect scoping/discovery session with Josh and Angela (COO). Budget range discussed: $40-50K annual licensing plus comparable implementation cost; budget remains unconfirmed. Urgency: government-award ramp through end of September, with ~100 additional workers possible.')
where lower(name) = 'usgp';

-- Backfill the four user-requested USGP next steps. These are idempotent and
-- use pinned reminders, which are mirrored into Missions below.
insert into lead_tasks (lead_id, title, due_at, block_time)
select l.id, v.title, v.due_at, false
from leads l
cross join (values
  ('Send TAL drop to USGP', '2026-07-30T23:00:00Z'::timestamptz),
  ('Set up KT for USGP', '2026-07-31T16:00:00Z'::timestamptz),
  ('Set up BD for USGP', '2026-07-31T16:15:00Z'::timestamptz),
  ('Talk to Steven about USGP KT and BD decks', '2026-07-31T16:30:00Z'::timestamptz)
) as v(title, due_at)
where lower(l.name) = 'usgp'
  and not exists (
    select 1 from lead_tasks t where t.lead_id = l.id and t.title = v.title and t.status = 'open'
  );

-- The original TAL task was created without its date in the browser. Give it
-- today's reminder time so it is eligible for the standard task-to-Mission bridge.
update lead_tasks t
set due_at = '2026-07-30T23:00:00Z'::timestamptz, block_time = false
from leads l
where t.lead_id = l.id
  and lower(l.name) = 'usgp'
  and t.title = 'Send TAL drop to USGP'
  and t.due_at is null
  and t.status = 'open';

-- Every dated, open, unlinked Kill List task becomes its corresponding Mission.
with candidates as (
  select t.id as task_id, t.lead_id, t.title, t.notes, t.due_at, t.remind_at, t.block_time, l.name as lead_name
  from lead_tasks t
  join leads l on l.id = t.lead_id
  where t.status = 'open' and t.due_at is not null and t.mission_id is null
), created as (
  insert into missions (title, notes, kind, due_at, scheduled_start, scheduled_end, linked_account_id, source, reminder_lead_min)
  select
    c.title,
    case when nullif(trim(c.notes), '') is null then c.lead_name || ' (Kill List)' else c.notes || E'\n\n- ' || c.lead_name || ' (Kill List)' end,
    case when c.block_time then 'task' else 'reminder' end,
    c.due_at,
    case when c.block_time then c.due_at else null end,
    case when c.block_time then c.due_at + interval '30 minutes' else null end,
    c.lead_id,
    'pipeline',
    case when c.remind_at is null then null else greatest(0, round(extract(epoch from (c.due_at - c.remind_at)) / 60))::int end
  from candidates c
  returning id, linked_account_id, title, due_at
)
update lead_tasks t
set mission_id = c.id
from created c
where t.lead_id = c.linked_account_id and t.title = c.title and t.due_at = c.due_at and t.mission_id is null;
