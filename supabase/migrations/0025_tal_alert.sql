-- 0025: in-app alert flag for TAL (claimed) accounts. The daily TAL news sweep sets
-- this true when a claimed account gets a NEW signal, so the app can flag the AE
-- (the only in-app notification he wants). Cleared when he views it.
alter table companies add column if not exists tal_alert boolean not null default false;
