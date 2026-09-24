import "server-only";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { serviceClient } from "@/lib/supabase/server";
import type { JevSpendContext } from "./jevRequests";

export const JEV_USD_PER_MILLION = 0.042;
export const PRICED_JEV_MODEL = "jev-1.13.0";
export const JEV_MAX_INPUT_TOKENS = 65_536;
export const JEV_RESERVATION_USD = 0.002753;
export function jevCost(inputTokens: number): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error("Invalid token usage");
  return Math.ceil(inputTokens * JEV_USD_PER_MILLION) / 1_000_000;
}

/** Reserve the model's complete documented request ceiling (64k), rather than
 * assuming a characters/token ratio can guarantee a cap. Actual usage refunds
 * the excess at settlement. Unknown/lost usage keeps the entire reservation. */
export async function reserveJev(context?: JevSpendContext): Promise<string | null> {
  // The legacy id-only API cannot authorize a dispatch. Public paid work must
  // use durableJevRequest's fingerprint-bound, one-use ticket.
  void context;
  return null;
}

export type JevBudgetDeferral = { status: "budget_deferred"; reason: string; retryAt: string | null; policyId?: string };
export class JevBudgetDeferredError extends Error {
  readonly preDispatch = true;
  constructor(readonly decision: JevBudgetDeferral) { super(decision.reason); }
}
type DispatchRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
type JevDispatchPermit = { fingerprint: string; rawFingerprint: string; reservationId: string; leaseToken: string; rpc: DispatchRpc; consumed?: boolean };
const dispatchPermit = new AsyncLocalStorage<JevDispatchPermit>();

/** One scope per reserved attempt, never an environment flag or a caller boolean. */
export function withJevDispatchPermit<T>(permit: Omit<JevDispatchPermit, "consumed">, execute: () => Promise<T>): Promise<T> {
  return dispatchPermit.run({ ...permit, consumed: false }, execute);
}

/** Called immediately before HTTP, even when a raw transport is called directly. */
export async function authorizeJevDispatch(model: string, rawFingerprint: string | null): Promise<void> {
  const permit = dispatchPermit.getStore();
  const defer = (reason: string): never => { throw new JevBudgetDeferredError({ status: "budget_deferred", reason, retryAt: null }); };
  if (model !== PRICED_JEV_MODEL) defer("unpriced_model");
  if (!permit || permit.consumed || permit.rawFingerprint !== rawFingerprint) defer("dispatch_ticket_required");
  const ticket = permit!;
  ticket.consumed = true;
  let response;
  try { response = await ticket.rpc("intelligence_jev_dispatch", {
    p_fingerprint: ticket.fingerprint, p_reservation: ticket.reservationId, p_lease: ticket.leaseToken, p_model: model,
  }); } catch { return defer("dispatch_authorization_unavailable"); }
  if (response.error || !response.data || typeof response.data !== "object") defer("dispatch_authorization_unavailable");
  const value = response.data as { status?: string; reason?: string; retryAt?: string | null; expiresAt?: string; model?: string };
  if (value.status !== "authorized") throw new JevBudgetDeferredError({
    status: "budget_deferred", reason: value.reason ?? "dispatch_not_authorized", retryAt: value.retryAt ?? null,
  });
  if (value.model !== model || !value.expiresAt || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.now()) defer("dispatch_ticket_expired");
}

export type JevBudgetSnapshot = { available: false } | {
  available: true; asOf: string; policyId: string; enabled: boolean; policyEnabled: boolean; processingEnabled: boolean;
  phase: "initial" | "maintenance" | "before_start" | "expired"; blockedReason: string | null;
  initialMaxUsd: number; dailyCapUsd: number; maintenanceLimitUsd: number;
  initialUsedUsd: number; maintenanceUsedUsd: number; todayUsedUsd: number;
  inFlightReserveUsd: number; unknownReserveUsd: number; carriedUnknownUsd: number;
  totalRemainingUsd: number; dailyRemainingUsd: number; initialRemainingUsd: number; maintenanceRemainingUsd: number;
  nextResetAt: string | null; initialExpiresAt: string; maintenanceExpiresAt: string;
  fundingConfirmed: boolean; legacyReconciled: boolean; openingLiabilityUsd: number | null;
};
export async function readJevBudgetPolicy(): Promise<JevBudgetSnapshot> {
  try {
    const { data, error } = await serviceClient().rpc("intelligence_jev_budget_status");
    if (error || !data || typeof data !== "object") return { available: false };
    const value = data as Record<string, unknown>;
    const amounts = ["initialMaxUsd","dailyCapUsd","maintenanceLimitUsd","initialUsedUsd","maintenanceUsedUsd","todayUsedUsd",
      "inFlightReserveUsd","unknownReserveUsd","carriedUnknownUsd","totalRemainingUsd","dailyRemainingUsd","initialRemainingUsd","maintenanceRemainingUsd"];
    if (!amounts.every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)
      || !["enabled","policyEnabled","processingEnabled","fundingConfirmed","legacyReconciled"].every(key => typeof value[key] === "boolean")
      || !["initial","maintenance","before_start","expired"].includes(String(value.phase))
      || !["asOf","initialExpiresAt","maintenanceExpiresAt"].every(key => typeof value[key] === "string" && Number.isFinite(Date.parse(value[key] as string)))
      || typeof value.policyId !== "string" || !(value.blockedReason === null || typeof value.blockedReason === "string")
      || !(value.nextResetAt === null || typeof value.nextResetAt === "string" && Number.isFinite(Date.parse(value.nextResetAt)))
      || !(value.openingLiabilityUsd === null || typeof value.openingLiabilityUsd === "number" && Number.isFinite(value.openingLiabilityUsd) && value.openingLiabilityUsd >= 0)) return { available: false };
    return { ...value, available: true } as JevBudgetSnapshot;
  } catch { return { available: false }; }
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
