-- 0032: weekly TAM refresh — 'removed_from_tam' status
-- Leads pulled out of the territory by the weekly update are HIDDEN, never deleted:
-- the row keeps its grade/digest/PDF history and is restored if the lead returns.
-- (Until this is applied, the weekly updater falls back to status='dismissed' +
--  a 'tam_removed' list tag; after applying, it uses this status natively.)
alter table companies drop constraint if exists companies_status_check;
alter table companies add constraint companies_status_check
  check (status in ('new','reviewed','dismissed','exported_csv','exported_sql','removed_from_tam'));

-- normalize any fallback-mode rows written before this migration
update companies
   set status = 'removed_from_tam'
 where status = 'dismissed' and 'tam_removed' = any(lists);
