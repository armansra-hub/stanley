-- Preserve the latest reported end-of-year active benefit-plan participant count
-- from DOL Form 5500 filings. This is a public headcount proxy, distinct from a
-- vendor-provided employee_count, and supports the Triggered-worklist filter.
alter table companies add column if not exists active_participant_count integer;

