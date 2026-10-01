/** Build a reviewable atomic migration artifact only. Never connects to a DB. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
const names = ["0134_jev_classifier_purpose_policy.sql", "0135_customer_research_profiles.sql",
  "0140_customer_catalog_runtime.sql", "0141_customer_criteria_readers.sql", "0142_customer_business_scope_proofs.sql"];
const sha = data => createHash("sha256").update(data).digest("hex");
const out = resolve(process.argv[2] ?? "work/customer-catalog-release");
const sources = await Promise.all(names.map(async name => {
  const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
  const sql = bytes.toString("utf8");
  if ((sql.match(/^begin;\s*$/gmi) ?? []).length !== 1 || (sql.match(/^commit;\s*$/gmi) ?? []).length !== 1) throw new Error("unexpected_transaction_shape:" + name);
  return { name, sha256: sha(bytes), sql: sql.replace(/^begin;\s*$/mi, "").replace(/^commit;\s*$/mi, "") };
}));
const sql = `-- Exact missing foundation plus new customer catalog migrations; review before execution.
-- No provider requests, catalog registration/selection, queue admission or activation.
begin;
set local lock_timeout='15s';
lock table public.intelligence_config,public.intelligence_jev_budget_policy in share row exclusive mode;
create temporary table customer_catalog_release_before on commit drop as
 select c.enabled processing_enabled,c.catalog_mode,c.catalog_pilot_company_id,p.enabled paid_enabled
 from public.intelligence_config c cross join public.intelligence_jev_budget_policy p
 where c.id=1 and p.id='jev-rollout-2026-09-24';
do $$ begin
 if not exists(select 1 from customer_catalog_release_before where paid_enabled=false) then raise exception 'paid_pause_required';end if;
 if to_regprocedure('public.intelligence_jev_classifier_allowed(text,text)') is not null
  or to_regclass('public.intelligence_customer_research_profiles') is not null
  or to_regclass('public.intelligence_catalog_dictionaries') is not null then raise exception 'migration_preflight_changed';end if;
end $$;
${sources.map(s => `-- BEGIN ${s.name}; original SHA256 ${s.sha256}\n${s.sql}\n-- END ${s.name}`).join("\n")}
do $$ begin
 if not exists(select 1 from customer_catalog_release_before b cross join public.intelligence_config c
  cross join public.intelligence_jev_budget_policy p where c.id=1 and p.id='jev-rollout-2026-09-24'
  and c.enabled=b.processing_enabled and c.catalog_mode=b.catalog_mode
  and c.catalog_pilot_company_id is not distinct from b.catalog_pilot_company_id
  and p.enabled=false and c.selected_catalog_version is null) then raise exception 'release_changed_activation_state';end if;
end $$;
commit;
`;
await mkdir(out, { recursive: true });
const path = resolve(out, "customer-catalog-atomic.sql");
await writeFile(path, sql);
const manifest = { schema: "customer-catalog-sql-release-v1", generatedAt: new Date().toISOString(),
  bundle: { file: basename(path), sha256: sha(sql), bytes: Buffer.byteLength(sql) },
  migrations: sources.map(({ name, sha256 }) => ({ name, sha256 })),
  preconditions: ["Production readback confirms 0134/0135 and 0140/0141/0142 absent", "Existing dependencies through0133 present as separately verified", "Paid policy remains false"],
  execution: "One atomic transaction. Do not replay unrelated/uncertain ledger migrations. Root owns reviewed production execution and migration ledger reconciliation.",
  effects: "Installs functions/schema/history only; no dictionary registration, selection, work admission or paid activation.", providerCalls: 0 };
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256: manifest.bundle.sha256, migrationCount: names.length }));
