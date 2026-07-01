-- 0027: website-change watch for claimable leads. We store the set of growth phrases
-- last seen on a company's own site (homepage/news/about); when a NEW growth phrase
-- appears (new office/location, new division/subsidiary, an acquisition they made), we
-- fire a trigger. site_hash holds the last phrase-set fingerprint; site_checked_at the
-- last fetch (rotation + baseline marker).
alter table companies add column if not exists site_hash text;
alter table companies add column if not exists site_checked_at timestamptz;
