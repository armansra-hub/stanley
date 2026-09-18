import "server-only";
import { randomUUID } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";

export const JEV_USD_PER_MILLION = 0.042;
export function jevCost(inputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new Error("Invalid token usage");
  return Math.ceil(inputTokens * JEV_USD_PER_MILLION) / 1_000_000;
}

/** Reserve the model's complete documented request ceiling (64k), rather than
 * assuming a characters/token ratio can guarantee a cap. Actual usage refunds
 * the excess at settlement. Unknown/lost usage keeps the entire reservation. */
export async function reserveJev(): Promise<string | null> {
  const id = randomUUID();
  const { data, error } = await serviceClient().rpc("intelligence_reserve", {
    p_id: id, p_category: "jev", p_amount: jevCost(65_536),
  });
  if (error) throw new Error(`Budget reservation failed: ${error.code ?? "database_error"}`);
  return data === true ? id : null;
}

export async function settleJev(id: string, tokens: number | null): Promise<void> {
  const { error } = await serviceClient().rpc("intelligence_settle", {
    p_id: id, p_actual: tokens === null ? null : jevCost(tokens), p_tokens: tokens,
  });
  if (error) throw new Error(`Budget settlement failed: ${error.code ?? "database_error"}`);
}

export interface GenerationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

// Haiku 4.5 standard rates, verified against Anthropic's pricing documentation:
// https://platform.claude.com/docs/en/about-claude/pricing
// The final verifier bounds its complete request to 14k UTF-8 bytes plus framing
// and output to 256 tokens; $0.03 reserves above that conservative token ceiling.
export const GENERATION_RESERVATION_USD = 0.03;
export const generationModelSupported = (model: string) =>
  model === "claude-haiku-4-5" || model === "claude-haiku-4-5-20251001";

export function generationCost(usage: GenerationUsage): number {
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens ?? 0, usage.cacheReadInputTokens ?? 0];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid generation token usage");
  return Math.ceil(counts[0] + counts[1] * 5 + counts[2] * 1.25 + counts[3] * 0.1) / 1_000_000;
}

export async function reserveGeneration(model: string): Promise<string | null> {
  if (!generationModelSupported(model)) return null;
  const id = randomUUID();
  const { data, error } = await serviceClient().rpc("intelligence_reserve", {
    p_id: id, p_category: "generation", p_amount: GENERATION_RESERVATION_USD,
  });
  if (error) throw new Error(`Generation budget reservation failed: ${error.code ?? "database_error"}`);
  return data === true ? id : null;
}

export async function settleGeneration(id: string, usage: GenerationUsage | null): Promise<void> {
  const { error } = await serviceClient().rpc("intelligence_settle", {
    p_id: id, p_actual: usage === null ? null : generationCost(usage),
    p_tokens: usage === null ? null : usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
  });
  if (error) throw new Error(`Generation budget settlement failed: ${error.code ?? "database_error"}`);
}

export function secondsUntilNextMonth(now = new Date()): number {
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000);
}
