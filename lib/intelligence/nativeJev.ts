import "server-only";
import { createHash } from "node:crypto";
import { JEV_MODEL, TYPESAFE_EVALUATION_URL, hasPrivateExcerptAuthorization } from "./jev";
import { durableJevRequest, type JevSpendContext } from "./jevRequests";
import type { EvaluationUsage } from "./evaluation";
import { authorizeJevDispatch, JevBudgetDeferredError } from "./budget";

export type NativeQuestion =
  | { type: "noul"; instructions: string; criteria?: Record<string, string> }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type NativeJevInput = {
  state: unknown;
  questions: Record<string, NativeQuestion>;
  privacy?: "public" | "private_excerpt";
};
export type NativeAnswer = { type: "noul" | "choice" | "score"; noul?: number; choice?: string; score?: number;
  confidence?: number; probabilities?: Record<string, number>; legend?: Record<string, string> };
export type NativeProviderResult = { model: string; answers: Record<string, NativeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number }; [key: string]: unknown };
export type NativeJevResult =
  | { ok: true; provider_result: NativeProviderResult; usage: EvaluationUsage }
  | { ok: false; error: { code: string; retryable: boolean }; usage: EvaluationUsage | null };
const VERSION = "stanley-native-jev-v1";
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const probability = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** Validate shape and size only. No truncation, extra questions, or semantic judge. */
export function nativeJevBody(input: NativeJevInput) {
  if (!object(input) || input.state === undefined || input.state === null || !object(input.questions)) throw new Error("invalid_native_request");
  const entries = Object.entries(input.questions);
  if (!entries.length || entries.length > 32) throw new Error("invalid_question_count");
  for (const [id, q] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) || !object(q) || typeof q.instructions !== "string" || !q.instructions.trim()
      || Buffer.byteLength(q.instructions) > 8000) throw new Error("invalid_native_question");
    if (!["noul", "choice", "score"].includes(q.type)) throw new Error("invalid_question_type");
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10
        || q.criteria.some(v => typeof v !== "string" || !v.trim())) throw new Error("invalid_score_criteria");
    } else if (q.type === "choice" || q.criteria !== undefined) {
      if (!object(q.criteria) || Object.keys(q.criteria).length < (q.type === "choice" ? 2 : 1)
        || Object.keys(q.criteria).length > 255
        || Object.entries(q.criteria).some(([key, val]) => !key || typeof val !== "string"
          || (q.type === "noul" && !["true", "false"].includes(key)))) throw new Error("invalid_choice_criteria");
    }
  }
  const body = { model: JEV_MODEL, state: input.state, questions: input.questions };
  const serialized = JSON.stringify(body);
  if (!serialized || Buffer.byteLength(serialized) > 48_000) throw new Error("native_request_too_large");
  return body;
}

export function nativeJevFingerprint(input: NativeJevInput): string {
  return createHash("sha256").update(JSON.stringify(stable([VERSION, input.privacy ?? "public", nativeJevBody(input)]))).digest("hex");
}

export async function evaluateNativeQuestions(input: NativeJevInput, deps: { fetch?: typeof fetch } = {}): Promise<NativeJevResult> {
  const zeroUsage = { inputTokens: 0, outputTokens: 0 };
  let body: ReturnType<typeof nativeJevBody>;
  try { body = nativeJevBody(input); }
  catch (error) { return { ok: false, error: { code: error instanceof Error ? error.message : "invalid_request", retryable: false }, usage: zeroUsage }; }
  if (input.privacy === "private_excerpt" && !hasPrivateExcerptAuthorization())
    return { ok: false, error: { code: "privacy_not_authorized", retryable: false }, usage: zeroUsage };
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { ok: false, error: { code: "typesafe_not_configured", retryable: false }, usage: zeroUsage };
  let usage: EvaluationUsage | null = null;
  try {
    await authorizeJevDispatch(JEV_MODEL, nativeJevFingerprint(input));
    const response = await (deps.fetch ?? fetch)(TYPESAFE_EVALUATION_URL, {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25_000), cache: "no-store", redirect: "error",
    });
    if (!response.ok) return { ok: false, error: { code: "typesafe_http_" + response.status,
      retryable: response.status === 429 || response.status >= 500 }, usage };
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 524_288) throw new Error("response_too_large");
    const result: unknown = JSON.parse(raw);
    if (!object(result) || !object(result.answers) || typeof result.model !== "string") throw new Error("invalid_native_response");
    const tokens = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
    usage = { inputTokens: object(result.usage) ? tokens(result.usage.input_tokens) : null,
      outputTokens: object(result.usage) ? tokens(result.usage.output_tokens) : null };
    for (const [id, question] of Object.entries(body.questions)) {
      const answer = result.answers[id];
      if (!object(answer) || answer.type !== question.type) throw new Error("invalid_native_response");
      if (question.type === "noul" && !probability(answer.noul)) throw new Error("invalid_native_response");
      if (question.type === "choice" && (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)))
        throw new Error("invalid_native_response");
      if (question.type === "score" && (typeof answer.score !== "number" || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > question.criteria.length - 1)) throw new Error("invalid_native_response");
    }
    return { ok: true, provider_result: result as NativeProviderResult, usage };
  } catch (error) {
    if (error instanceof JevBudgetDeferredError) throw error;
    const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
    return { ok: false, error: { code: timeout ? "typesafe_timeout" : "native_response_unavailable", retryable: timeout }, usage };
  }
}

export async function evaluateNativeCached(input: NativeJevInput, context: JevSpendContext) {
  if (input.privacy === "private_excerpt") throw new Error("Private input must not enter the public response cache");
  return durableJevRequest({ fingerprint: nativeJevFingerprint(input), context, execute: () => evaluateNativeQuestions(input) });
}
