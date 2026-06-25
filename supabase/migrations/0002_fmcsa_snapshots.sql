-- Fleet-size snapshots so FMCSA discovery can detect run-over-run GROWTH
-- (a carrier expanding its fleet → a real fleet_expansion signal, not just a
-- firmographic). Run this in the Supabase SQL editor to activate deltas; until
-- then the FMCSA adapter falls back to baseline (no deltas, still works).
create table if not exists fmcsa_snapshots (
  dot_number     text primary key,
  legal_name     text,
  nbr_power_unit int,
  driver_total   int,
  captured_at    timestamptz not null default now()
);
