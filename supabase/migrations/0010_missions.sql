-- 0010: Missions module (reminders / tasks + calendar). Lean, email-first design:
--   • Outlook reminds (we email .ics invites; no server-side reminder engine).
--   • A recurring mission is ONE row that advances to its next occurrence on
--     dismiss/complete (no instance explosion, no separate template table).
--   • The published ICS feed is read every 15 min into calendar_busy for free/busy.
-- Three tables: user_prefs, missions, calendar_busy.

-- ── Single-row preferences (id=1, mirrors app_config) ─────────────────────────
create table if not exists user_prefs (
  id                int primary key default 1,
  timezone          text not null default 'America/Los_Angeles',
  work_hours        jsonb not null default
    '{"1":{"start":"08:00","end":"17:00"},"2":{"start":"08:00","end":"17:00"},"3":{"start":"08:00","end":"17:00"},"4":{"start":"08:00","end":"17:00"},"5":{"start":"08:00","end":"17:00"}}'::jsonb,
  quiet_hours       jsonb not null default '{"start":"17:00","end":"08:00"}'::jsonb,
  reminder_lead_min int  not null default 15,        -- VALARM minutes-before on invites
  from_email        text,                            -- verified Resend sender
  user_email        text,                            -- his Outlook address (invites go here)
  ics_publish_url   text,                            -- his published calendar feed (read for busy)
  updated_at        timestamptz not null default now(),
  check (id = 1)
);
insert into user_prefs (id) values (1) on conflict (id) do nothing;

-- ── Missions (tasks that block time + point reminders) ────────────────────────
create table if not exists missions (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  notes            text,
  kind             text not null default 'task' check (kind in ('task','reminder')),
  priority         text not null default 'medium' check (priority in ('low','medium','high')),
  status           text not null default 'open' check (status in ('open','done','dismissed','snoozed')),
  due_at           timestamptz,                       -- when it's relevant (chronological sort key)
  scheduled_start  timestamptz,                       -- the booked calendar slot
  scheduled_end    timestamptz,
  all_day          bool not null default false,
  is_recurring     bool not null default false,
  rrule            text,                              -- recurrence lives on the row
  linked_company_id uuid references companies(id) on delete set null,
  source           text not null default 'manual' check (source in ('manual','voice','chat','auto')),
  ics_uid          text not null default gen_random_uuid()::text,  -- STABLE; reused on update/cancel
  ics_sequence     int  not null default 0,
  invite_sent_at   timestamptz,                       -- last time we emailed an invite
  reminder_lead_min int,                              -- per-mission override of the pref
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  dismissed_at     timestamptz
);
create index if not exists missions_open_due_idx on missions (due_at) where status in ('open','snoozed');
create index if not exists missions_sched_idx on missions (scheduled_start);
create index if not exists missions_company_idx on missions (linked_company_id) where linked_company_id is not null;

-- ── Calendar busy blocks (from the 15-min published-ICS poll) ─────────────────
create table if not exists calendar_busy (
  id           uuid primary key default gen_random_uuid(),
  external_uid text,
  title        text,
  start        timestamptz not null,
  "end"        timestamptz not null,
  busy         bool not null default true,            -- false = TRANSP:TRANSPARENT (free)
  last_synced  timestamptz not null default now()
);
create index if not exists calendar_busy_range_idx on calendar_busy (start, "end");
create unique index if not exists calendar_busy_uid_idx on calendar_busy (external_uid, start) where external_uid is not null;
