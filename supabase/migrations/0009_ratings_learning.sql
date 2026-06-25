-- 0009: lead quality ratings + the learning loop's storage.
--   • companies.rating         — 1..5 stars the AE gives a lead (quality).
--   • companies.rating_comment — optional note on why.
--   • companies.rated_at       — when rated.
--   • app_config.signal_quality — jsonb {signal_type: multiplier}. Learned from
--     ratings (lib/learn/feedback.ts): signal types that correlate with high
--     ratings get a >1 multiplier, low-rated ones <1, applied on top of the
--     scoring weights so the bot continuously tunes toward what the AE values.

alter table companies add column if not exists rating int;
alter table companies add column if not exists rating_comment text;
alter table companies add column if not exists rated_at timestamptz;
alter table companies add constraint companies_rating_range check (rating is null or (rating >= 1 and rating <= 5));

alter table app_config add column if not exists signal_quality jsonb not null default '{}'::jsonb;

create index if not exists companies_rating_idx on companies (rating) where rating is not null;
