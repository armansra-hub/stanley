-- 0046: preserve every company field mutated by the score bridge.
--
-- Historical score_snapshots retained only the three scores and note even though
-- the same write could also change status, dead-state evidence, digest, Old Gold
-- class/reasons, revisit date, and provisional state. Store one complete JSONB
-- before-image for every new write so recovery is evidence-complete.

alter table score_snapshots
  add column if not exists prior_values jsonb not null default '{}'::jsonb;

comment on column score_snapshots.prior_values is
  'Complete pre-write values for every companies field the score bridge may mutate; restoration remains an explicit reviewed operation.';

notify pgrst, 'reload schema';
