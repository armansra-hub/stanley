import Dashboard from "@/components/Dashboard";
import { SAMPLE_COMPANIES } from "@/lib/sampleData";
import { getCompanies } from "@/lib/db/companies";
import { getAppConfig, getActorOverrides } from "@/lib/db/settings";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import type { SqlExportConfig } from "@/lib/export/sql";

export const dynamic = "force-dynamic"; // always read fresh from the DB

export default async function Page() {
  let companies = SAMPLE_COMPANIES;
  let usingSample = true;
  let exportConfig: SqlExportConfig | undefined;
  let actorOverrides: Record<string, { enabled?: boolean }> = {};

  if (hasSupabaseEnv()) {
    try {
      const fromDb = await getCompanies();
      if (fromDb.length > 0) {
        companies = fromDb;
        usingSample = false;
      }
    } catch (e) {
      console.error("Falling back to sample data:", e);
    }
    try {
      const app = await getAppConfig();
      exportConfig = {
        chunkSize: app.chunk_size,
        urlField: app.sql_url_field,
        stage: app.ns_stage,
        salesRep: app.ns_sales_rep,
      };
      actorOverrides = await getActorOverrides();
    } catch (e) {
      console.error("config load failed:", e);
    }
  }

  return (
    <Dashboard
      initial={companies}
      usingSample={usingSample}
      exportConfig={exportConfig}
      actorOverrides={actorOverrides}
    />
  );
}
