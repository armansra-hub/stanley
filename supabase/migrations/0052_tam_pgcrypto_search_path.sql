-- Supabase installs pgcrypto in the trusted `extensions` schema. These
-- SECURITY DEFINER functions call digest() at runtime, so keep application
-- tables in public while making the extension resolvable ahead of pg_temp.

alter function public.tam_regrade_guard_seeded_run()
  set search_path = public, extensions, pg_temp;

alter function public.seed_tam_regrade_checkpoint_batch(text, text, uuid, jsonb)
  set search_path = public, extensions, pg_temp;

alter function public.finalize_tam_regrade_checkpoint_seed(text, text, uuid)
  set search_path = public, extensions, pg_temp;

alter function public.publish_tam_regrade_final(
  text, text, text, uuid, numeric, text, text, text, timestamptz, jsonb,
  numeric, text, jsonb, boolean, boolean, date, boolean, text, text, text, text
)
  set search_path = public, extensions, pg_temp;

notify pgrst, 'reload schema';
