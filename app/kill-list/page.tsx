import KillListBoard from "@/components/KillListBoard";
import { listStages, listLeads } from "@/lib/db/killlist";
import { getPrefs } from "@/lib/db/missions";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import { SAMPLE_STAGES, SAMPLE_LEADS, SAMPLE_NOTES, SAMPLE_TASKS } from "@/lib/killlist/sampleLeads";
import type { PipelineStage, Lead } from "@/lib/killlist/types";

export const dynamic = "force-dynamic";

export default async function KillListPage() {
  let stages: PipelineStage[] = SAMPLE_STAGES;
  let leads: Lead[] = SAMPLE_LEADS;
  let usingSample = true;
  let timezone = "America/Los_Angeles";

  if (hasSupabaseEnv()) {
    try {
      timezone = (await getPrefs()).timezone;
      const [s, l] = await Promise.all([listStages(), listLeads()]);
      if (s.length > 0) {
        stages = s;
        leads = l;
        usingSample = false;
      }
    } catch (e) {
      console.error("kill-list load failed, using sample:", e);
    }
  }

  return (
    <KillListBoard
      initialStages={stages}
      initialLeads={leads}
      usingSample={usingSample}
      timezone={timezone}
      sampleNotes={usingSample ? SAMPLE_NOTES : {}}
      sampleTasks={usingSample ? SAMPLE_TASKS : {}}
    />
  );
}
