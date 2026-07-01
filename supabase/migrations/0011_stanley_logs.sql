-- 0011: Stanley conversation log (for debugging — not shown in the UI). Captures
-- the exact words the user said, Stanley's reply, and the proposed action plan.
create table if not exists stanley_logs (
  id         uuid primary key default gen_random_uuid(),
  user_text  text,
  reply      text,
  plan       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists stanley_logs_created_idx on stanley_logs (created_at desc);
