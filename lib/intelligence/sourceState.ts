import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "./observations";

export type CoverageStatus = "complete" | "partial" | "empty" | "unavailable" | "unsupported" | "unknown";
export async function readSourceState(companyId: string, sourceKey: string): Promise<{ cursor: Record<string, unknown> | null; lastSuccessAt: string | null }> {
  if (!intelligenceEnabled()) return { cursor: null, lastSuccessAt: null };
  const { data, error } = await serviceClient().from("intelligence_source_state")
    .select("cursor,last_success_at").eq("company_id", companyId).eq("source_key", sourceKey).maybeSingle();
  if (error) throw new Error(`Source state read failed: ${error.code ?? "database_error"}`);
  return { cursor: data?.cursor ?? null, lastSuccessAt: data?.last_success_at ?? null };
}

export async function writeSourceState(companyId: string, sourceKey: string,
  value: { cursor: Record<string, unknown> | null; complete: boolean; error?: string | null;
    status?: CoverageStatus; successful?: boolean; details?: Record<string, unknown>; nextAttemptAt?: string | null }): Promise<void> {
  if (!intelligenceEnabled()) return;
  const now = new Date().toISOString();
  const { error } = await serviceClient().from("intelligence_source_state").upsert({
    company_id: companyId, source_key: sourceKey, cursor: value.cursor, complete: value.complete,
    last_attempt_at: now, last_error: value.error?.slice(0, 200) ?? null,
    coverage_status: value.status ?? (value.error ? "unavailable" : value.complete ? "complete" : "partial"),
    error_details: value.details ?? {}, next_attempt_at: value.nextAttemptAt ?? null,
    ...((value.successful ?? !value.error) ? { last_success_at: now } : {}),
  }, { onConflict: "company_id,source_key" });
  if (error) throw new Error(`Source state write failed: ${error.code ?? "database_error"}`);
}
