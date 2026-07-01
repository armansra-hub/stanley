-- 0013: patch for 0012 — adds the block/reminder toggle column + the 'system'
-- activity-log author (auto timeline). Idempotent: safe whether or not 0012 already
-- included these.
alter table lead_tasks add column if not exists block_time bool not null default false;

alter table lead_notes drop constraint if exists lead_notes_author_check;
alter table lead_notes add constraint lead_notes_author_check
  check (author in ('manual','chatbot','system'));
