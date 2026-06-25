-- 0007: Sales Navigator two-phase scraping state.
-- The bestscrapers actor is async-by-design: an INIT call returns a request_id
-- and the results are ready ~5–10 min later, fetched by request_id + page. We
-- can't wait inline (Vercel 60s cap), so we persist each init here and fetch on
-- the NEXT cron run (init today → fetch tomorrow). One row per init.

create table if not exists sales_nav_requests (
  id          uuid primary key default gen_random_uuid(),
  search_key  text not null,                 -- which configured search (e.g. 'bs_tam_new_hires')
  request_id  text not null,                 -- the actor's request id for fetching pages
  status      text not null default 'pending', -- pending | done | error
  pages_fetched int not null default 0,
  results     int not null default 0,
  note        text,
  created_at  timestamptz not null default now(),
  fetched_at  timestamptz
);

create index if not exists sales_nav_requests_status_idx on sales_nav_requests (status, created_at);
create index if not exists sales_nav_requests_key_idx on sales_nav_requests (search_key, created_at desc);
