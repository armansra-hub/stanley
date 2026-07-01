-- 0019: persistent toggle for cross-tagging discovered leads (esp. domain-less
-- Sales Nav Growth results) against the TAM base BY COMPANY NAME — so a Growth
-- lead that's already in NetSuite/ZoomInfo TAM inherits its lists + claimable +
-- NetSuite Internal ID. Default ON. The ingest pipeline reads this; it also
-- works (defaults true) before this migration is applied.
alter table app_config add column if not exists cross_tag_base boolean not null default true;
