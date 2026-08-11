import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0052_tam_pgcrypto_search_path.sql"),
  "utf8",
).toLowerCase();

describe("0052 TAM pgcrypto search path", () => {
  it("makes pgcrypto visible to every digest-using TAM function", () => {
    expect(sql).toContain("alter function public.tam_regrade_guard_seeded_run()\n  set search_path = public, extensions, pg_temp");
    expect(sql).toContain("alter function public.seed_tam_regrade_checkpoint_batch(text, text, uuid, jsonb)\n  set search_path = public, extensions, pg_temp");
    expect(sql).toContain("alter function public.finalize_tam_regrade_checkpoint_seed(text, text, uuid)\n  set search_path = public, extensions, pg_temp");
    expect(sql).toContain("alter function public.publish_tam_regrade_final(");
    expect(sql.match(/set search_path = public, extensions, pg_temp/g)).toHaveLength(4);
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
