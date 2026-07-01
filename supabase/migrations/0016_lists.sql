-- 0016: Silo/list membership model. Each base CSV is its OWN list (silo) with its
-- own update cycle — NEVER cross-deduped. A company is ONE row tagged with every
-- list it appears on (lists[]). "Claimable" = it carries the netsuite_tam tag (the
-- NetSuite TAM = available-to-claim leads). A company in more lists = more validated.
-- Re-uploading a list refreshes ONLY that list's membership; nothing else is touched.
alter table companies add column if not exists lists     text[] not null default '{}';  -- silos this company is a member of
alter table companies add column if not exists claimable bool   not null default false; -- member of the netsuite_tam list

create index if not exists companies_claimable_idx on companies (claimable) where claimable = true;
create index if not exists companies_lists_idx     on companies using gin (lists);

-- Retag the NetSuite TAM already imported as the 'netsuite_tam' list (claimable).
update companies set lists = array['netsuite_tam'], claimable = true
where lead_vendor = 'netsuite' and is_base = true and (lists is null or lists = '{}');
