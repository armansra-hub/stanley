import "server-only";
import { serviceClient } from "@/lib/supabase/server";
export type ResearchProgress = { available: false } | {
  available: true; asOf: string; scope: "eligible_tam";
  accounts: { total: number; withEvidence: number; withInterpretation: number; caughtUp: number;
    awaitingInterpretation: number; blockedInterpretation: number; researchReady: number; researchRunning: number; sourceRetry: number;
    researchFailed: number; discoveryCheckDue: number };
  processing: { pending: number };
  lastHour: { newInterpretationJobs: number; completedInterpretationJobs: number };
};
const keys = ["total", "withEvidence", "withInterpretation", "caughtUp", "awaitingInterpretation", "blockedInterpretation", "researchReady", "researchRunning", "sourceRetry", "researchFailed", "discoveryCheckDue"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseResearchProgress(value: unknown): ResearchProgress {
  if (!object(value) || value.available !== true || value.scope !== "eligible_tam" || typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf))
    || !object(value.accounts) || !keys.every(key => count((value.accounts as Record<string, unknown>)[key]))
    || !object(value.processing) || !count(value.processing.pending)
    || !object(value.lastHour) || !count(value.lastHour.newInterpretationJobs) || !count(value.lastHour.completedInterpretationJobs)) return { available: false };
  return value as ResearchProgress;
}
export async function readResearchProgress(): Promise<ResearchProgress> {
  try {
    const { data, error } = await serviceClient().rpc("intelligence_research_progress");
    return error ? { available: false } : parseResearchProgress(data);
  } catch { return { available: false }; }
}
