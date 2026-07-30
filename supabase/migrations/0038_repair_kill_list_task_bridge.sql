-- 0038: repair the Kill List child tables and its Missions bridge.
--
-- Some production environments were left with the board tables but without the
-- complete notes/tasks bridge. Keep this forward-only and idempotent: it is safe
-- to apply whether 0012/0013 completed, partially completed, or were skipped.

create table if not exists lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  body       text not null,
  author     text not null default 'manual',
  created_at timestamptz not null default now()
);
alter table lead_notes add column if not exists author text not null default 'manual';
alter table lead_notes drop constraint if exists lead_notes_author_check;
alter table lead_notes add constraint lead_notes_author_check
  check (author in ('manual', 'chatbot', 'system'));
create index if not exists lead_notes_lead_idx on lead_notes (lead_id, created_at desc);

create table if not exists lead_tasks (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  title        text not null,
  notes        text,
  due_at       timestamptz,
  remind_at    timestamptz,
  block_time   bool not null default false,
  status       text not null default 'open',
  mission_id   uuid references missions(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
alter table lead_tasks add column if not exists notes text;
alter table lead_tasks add column if not exists due_at timestamptz;
alter table lead_tasks add column if not exists remind_at timestamptz;
alter table lead_tasks add column if not exists block_time bool not null default false;
alter table lead_tasks add column if not exists status text not null default 'open';
alter table lead_tasks add column if not exists mission_id uuid references missions(id) on delete set null;
alter table lead_tasks add column if not exists completed_at timestamptz;
alter table lead_tasks drop constraint if exists lead_tasks_status_check;
alter table lead_tasks add constraint lead_tasks_status_check
  check (status in ('open', 'done'));
create index if not exists lead_tasks_lead_idx on lead_tasks (lead_id, status);
create index if not exists lead_tasks_mission_idx on lead_tasks (mission_id) where mission_id is not null;

alter table missions add column if not exists linked_account_id uuid references leads(id) on delete set null;
create index if not exists missions_account_idx on missions (linked_account_id) where linked_account_id is not null;
alter table missions drop constraint if exists missions_source_check;
alter table missions add constraint missions_source_check
  check (source in ('manual', 'voice', 'chat', 'auto', 'pipeline'));
