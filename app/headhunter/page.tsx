import Dashboard from "@/components/Dashboard";
import { SAMPLE_COMPANIES } from "@/lib/sampleData";
import { getCompanies, getExportHistory, type ExportRecord } from "@/lib/db/companies";
import { getAppConfig, getActorOverrides } from "@/lib/db/settings";
import { listEvents } from "@/lib/db/events";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import type { SqlExportConfig } from "@/lib/export/sql";

export const dynamic = "force-dynamic"; // always read fresh from the DB

export default async function HeadhunterPage() {
  let companies = SAMPLE_COMPANIES;
  let usingSample = true;
  let exportConfig: SqlExportConfig | undefined;
  let actorOverrides: Record<string, { enabled?: boolean }> = {};
  let exportHistory: ExportRecord[] = [];
  let lastRefreshAt: string | null = null;

  if (hasSupabaseEnv()) {
    try {
      // Last refresh = the most recent suite activity (cron / import / trigger sweep).
      const ev = await listEvents({ module: "headhunter", limit: 1 });
      lastRefreshAt = ev[0]?.ts ?? null;
    } catch { /* events table may be absent */ }
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
      exportHistory = await getExportHistory();
    } catch (e) {
      console.error("export history load failed:", e);
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
      exportHistory={exportHistory}
      lastRefreshAt={lastRefreshAt}
    />
  );
}
