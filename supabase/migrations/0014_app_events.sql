-- 0014: app_events — one unified activity log for the WHOLE Stanley suite. Every
-- meaningful thing that happens (a lead discovered, a status change, an export, a
-- cron batch, a mission/lead/task write) drops a row here. This is the timeline the
-- assistant reads to understand "that thing that happened in the app" — Headhunter,
-- Missions, and Kill List all funnel into it.
create table if not exists app_events (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  module      text not null,            -- headhunter | missions | killlist | system
  kind        text not null,            -- dotted verb, e.g. lead.discovered, export.created, cron.run
  entity_type text,                     -- companies | mission | lead | task | export | stage | cron
  entity_id   text,
  summary     text not null,            -- human one-liner ("Apify sales_nav: 12 new, 3 updated")
  meta        jsonb,                    -- structured detail for later analysis
  created_at  timestamptz not null default now()
);
create index if not exists app_events_ts_idx     on app_events (ts desc);
create index if not exists app_events_module_idx on app_events (module, ts desc);
create index if not exists app_events_kind_idx   on app_events (kind, ts desc);
