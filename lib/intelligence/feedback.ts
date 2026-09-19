import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export type FeedbackReason = "useful" | "wrong_company" | "old_event" | "irrelevant" | "not_now";
type FeedbackRow = { reason: FeedbackReason; note: string; intelligence_observations: {
  title: string; evidence_text: string; attributes: Record<string, unknown> | null;
} | null };

function utf8Prefix(value: string, bytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > bytes) break;
    result += character;
  }
  return result;
}

/** A correction is paired with the source it corrects, never substituted for it. */
export function feedbackExamples(rows: FeedbackRow[]) {
  return rows.flatMap(row => {
    const source = row.intelligence_observations;
    if (!source?.evidence_text.trim()) return [];
    const excerpt = typeof source.attributes?.evidenceExcerpt === "string" && source.evidence_text.includes(source.attributes.evidenceExcerpt)
      ? source.attributes.evidenceExcerpt : source.evidence_text;
    return [{ text: utf8Prefix(`${source.title.slice(0, 160)}\n${excerpt}`, 950),
      correction: utf8Prefix(`${row.reason}${row.note.trim() ? `: ${row.note.trim()}` : ""}`, 480) }];
  }).slice(0, 3);
}

export async function loadFeedbackExamples(companyId: string) {
  const { data, error } = await serviceClient().from("intelligence_feedback")
    .select("reason,note,intelligence_observations!inner(title,evidence_text,attributes)")
    .eq("company_id", companyId).order("updated_at", { ascending: false }).limit(3);
  if (error) throw new Error("feedback_examples_unavailable");
  return feedbackExamples((data ?? []) as unknown as FeedbackRow[]);
}

/** Public event ordering only: neutral prior four, maximum ±10%, never a TAM grade. */
export async function getPublicFeedbackWeight(companyId: string): Promise<number> {
  const { data, error } = await serviceClient().rpc("intelligence_public_feedback_weight", { p_company: companyId });
  if (error) throw new Error("feedback_weight_unavailable");
  const weight = Number(data);
  return Number.isFinite(weight) && weight >= .9 && weight <= 1.1 ? weight : 1;
}

export async function getSourceAttentionWeights(): Promise<Record<string, number>> {
  const { data, error } = await serviceClient().rpc("intelligence_source_feedback_weights");
  if (error) throw new Error("source_feedback_unavailable");
  return Object.fromEntries((Array.isArray(data) ? data : []).flatMap(row => {
    const weight = Number(row.weight);
    return typeof row.source_id === "string" && Number.isFinite(weight) && weight >= .9 && weight <= 1.1
      ? [[row.source_id, weight]] : [];
  }));
}
