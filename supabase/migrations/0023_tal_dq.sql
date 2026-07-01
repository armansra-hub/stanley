-- 0023: TAL diff state. On a new TAL upload, accounts that were on the PREVIOUS TAL
-- but are missing from the new one (the AE dropped them) get flagged "previously
-- disqualified" so he knows he already looked and passed. Reclaiming (appearing on a
-- later TAL) clears it.
alter table companies add column if not exists tal_dq boolean not null default false;
