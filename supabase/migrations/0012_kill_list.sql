-- 0012: Kill List module (pipeline tracker). A MANUAL CRM board — the user (or the
-- chatbot, on his instruction) types everything; Jarvis never discovers/enriches.
-- Siloed from Prospecting + Missions EXCEPT the one bridge: a dated lead_task also
-- becomes a Mission (reminder + calendar invite) via missions.linked_account_id.
--
-- Four tables: pipeline_stages (config), leads, lead_notes, lead_tasks.

-- ── Pipeline stages (user-editable Kanban columns) ────────────────────────────
create table if not exists pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  not null default 0,
  color       text,
  archived    bool not null default false,
  created_at  timestamptz not null default now()
);
-- Seed the four default stages (no Won/Lost — a lead's state IS its stage).
insert into pipeline_stages (name, sort_order, color)
select * from (values
  ('Hot Leads',     0, '#8c1d1d'),
  ('Post Intro',    1, '#b5532a'),
  ('Opportunities', 2, '#c9a24a'),
  ('Nurture',       3, '#8a7a63')
) as s(name, sort_order, color)
where not exists (select 1 from pipeline_stages);

-- ── Leads (lean: description + the NetSuite link; notes + tasks are children) ──
create table if not exists leads (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  website          text,
  description      text,                              -- "what they do" (free text)
  netsuite_url     text,                              -- link to the NetSuite lead record
  stage_id         uuid references pipeline_stages(id) on delete set null,
  sort_in_stage    int  not null default 0,
  last_activity_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists leads_stage_idx on leads (stage_id, sort_in_stage);

-- ── Activity log (append-only) ────────────────────────────────────────────────
create table if not exists lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  body       text not null,
  author     text not null default 'manual' check (author in ('manual','chatbot','system')),
  created_at timestamptz not null default now()
);
create index if not exists lead_notes_lead_idx on lead_notes (lead_id, created_at desc);

-- ── Tasks (a due_at triggers the Mission bridge) ──────────────────────────────
create table if not exists lead_tasks (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  title        text not null,
  notes        text,
  due_at       timestamptz,                           -- nullable; presence → Mission
  remind_at    timestamptz,                           -- nullable; sets the VALARM lead time
  block_time   bool not null default false,           -- true = time-block (auto-fit around meetings); false = pinned reminder
  status       text not null default 'open' check (status in ('open','done')),
  mission_id   uuid references missions(id) on delete set null,  -- idempotency anchor
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists lead_tasks_lead_idx on lead_tasks (lead_id, status);
create index if not exists lead_tasks_mission_idx on lead_tasks (mission_id) where mission_id is not null;

-- ── Extend missions for the bridge ────────────────────────────────────────────
alter table missions add column if not exists linked_account_id uuid references leads(id) on delete set null;
create index if not exists missions_account_idx on missions (linked_account_id) where linked_account_id is not null;
-- allow source='pipeline' for bridged missions
alter table missions drop constraint if exists missions_source_check;
alter table missions add constraint missions_source_check
  check (source in ('manual','voice','chat','auto','pipeline'));
