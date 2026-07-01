-- 0024: per-lead thumbs-down flag (a negative counterpart to `starred`). Toggled
-- from the worklist next to the star; persists; has no dedicated tab.
alter table companies add column if not exists thumbs_down boolean not null default false;
