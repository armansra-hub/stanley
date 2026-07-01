-- 0020: ERP-readiness signals on a company.
--   erp_incumbent  — accounting/ERP system detected from their own job posts:
--                    'quickbooks' (ready to upgrade → boost) | 'erp' (already on
--                    NetSuite/Intacct/etc → not a prospect, suppress) | null
--   pe_owned       — PE/portfolio-backed (standardize on ERP → high propensity)
--   ats_type/token — the company's job board (greenhouse/lever/ashby/…) + its slug,
--                    detected once from the careers page, then polled free for
--                    finance-hiring + JD ERP-pain language (the ATS engine, next).
--   ats_checked_at — last time we tried to detect/poll the ATS (rotation).
alter table companies add column if not exists erp_incumbent text;
alter table companies add column if not exists pe_owned boolean not null default false;
alter table companies add column if not exists ats_type text;
alter table companies add column if not exists ats_token text;
alter table companies add column if not exists ats_checked_at timestamptz;
