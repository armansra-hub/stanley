-- 0026: weekly usage counter for the LLM news classifier, so it self-caps at the
-- $10/week budget and falls back to the free regex classifier when the cap is hit.
-- (If these columns are absent the classifier stays OFF — no untracked spend.)
alter table app_config add column if not exists classifier_week text;
alter table app_config add column if not exists classifier_calls integer not null default 0;
