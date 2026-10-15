-- Run this statement outside a transaction. Keep collectors writable while the
-- index builds. The retained-job selector orders by this exact date/ID pair.
create index concurrently intelligence_current_job_review
  on public.intelligence_observations (observed_at desc, id asc)
  include (company_id)
  where is_current and source_kind = 'job';
