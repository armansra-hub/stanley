import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";

/**
 * Resurface a hidden lead after a newly accepted signal lands. The conditional
 * status update prevents this writer from undoing a human action that races the
 * signal insert. Exported leads retain the existing 14-day cooling policy.
 */
export async function reheatCompanyForFreshSignal(
  companyId: string,
  triggerType: string,
  sourceUrl: string | null,
): Promise<boolean> {
  const db = serviceClient();
  const { data: company } = await db.from("companies")
    .select("status,exported_at,lists")
    .eq("id", companyId)
    .maybeSingle();
  const status = company?.status as string | undefined;
  const lists = Array.isArray(company?.lists) ? company.lists.map(String) : [];
  if (!lists.includes("netsuite_tam")) return false;
  let eligible = status === "reviewed" || status === "dismissed";
  if (status === "exported_csv" || status === "exported_sql") {
    const exportedAt = company?.exported_at ? Date.parse(String(company.exported_at)) : 0;
    eligible = exportedAt > 0 && Date.now() - exportedAt > 14 * 86_400_000;
  }
  if (!eligible || !status) return false;

  const { data: reheated } = await db.from("companies")
    .update({ status: "new", has_new_signal: true })
    .eq("id", companyId)
    .eq("status", status)
    .select("id")
    .maybeSingle();
  if (!reheated) return false;
  await logEvent("headhunter", "lead.signal_reheated", {
    summary: `Fresh ${triggerType} signal reheated a ${status} lead`,
    entity_type: "companies",
    entity_id: companyId,
    meta: { status: "new", ids: [companyId], prior_status: status, trigger_type: triggerType, source_url: sourceUrl },
  }).catch(() => {});
  return true;
}
