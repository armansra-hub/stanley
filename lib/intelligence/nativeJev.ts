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
  /** Internal public-customer transport allowance; never sent to the provider. */
  requestProfile?: "customer-reference-full-source-v1";
};
export type NativeAnswer = { type: "noul" | "choice" | "score"; noul?: number; choice?: string; score?: number;
  confidence?: number; probabilities?: Record<string, number>; legend?: Record<string, string> };
export type NativeProviderResult = { model: string; answers: Record<string, NativeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number }; [key: string]: unknown };
export type NativeContextLimitEvidence = { kind: "provider_error_code"; code: string };
export type NativeJevFailureDiagnostics = {
  version: 1;
  stage: "awaiting_headers" | "http_response" | "reading_response" | "validating_response";
  elapsedMs: number;
  timeoutMs: number;
  requestBytes: number;
  questionCount: number;
  httpStatus?: number;
  requestId?: string;
  cfRay?: string;
  retryAfterSeconds?: number;
  timeoutSignalAborted?: boolean;
};
export type NativeJevResult =
  | { ok: true; provider_result: NativeProviderResult; usage: EvaluationUsage }
  | { ok: false; error: { code: string; retryable: boolean; contextLimit?: NativeContextLimitEvidence;
      diagnostics?: NativeJevFailureDiagnostics }; usage: EvaluationUsage | null };
const VERSION = "stanley-native-jev-v1";
const REQUEST_TIMEOUT_MS = 25_000;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const probability = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const CONTEXT_LIMIT_CODES = new Set(["context_length_exceeded", "max_context_length_exceeded", "context_window_exceeded", "too_many_tokens", "input_token_limit_exceeded"]);

/** Correlation metadata only: never preserve arbitrary error bodies or headers.
 * Retry-After is diagnostic advice, not authorization to replay a paid call. */
function failureHeaders(headers: Headers): Pick<NativeJevFailureDiagnostics, "requestId" | "cfRay" | "retryAfterSeconds"> {
  const result: ReturnType<typeof failureHeaders> = {};
  for (const name of ["x-request-id", "request-id"]) {
    const value = headers.get(name);
    if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) { result.requestId = value; break; }
  }
  const ray = headers.get("cf-ray");
  if (ray && /^[a-fA-F0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray)) result.cfRay = ray;
  const retry = headers.get("retry-after");
  let seconds: number | undefined;
  if (retry && /^\d{1,9}$/.test(retry)) seconds = Number(retry);
  else if (retry && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))
    seconds = Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000));
  if (seconds !== undefined && Number.isFinite(seconds)) result.retryAfterSeconds = seconds;
  return result;
}

/** Retain only an unambiguous structured rejection code, never provider text
 * that could echo a source. An arbitrary 400 is not evidence of a token limit.
 * Bounded reading is customer-only and never causes an inference retry. */
async function customerContextLimitEvidence(response: Response): Promise<NativeContextLimitEvidence | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_384) { await reader.cancel(); return; }
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(parsed)) return;
    const nested = object(parsed.error) ? parsed.error : {};
    for (const code of [nested.code, nested.type, parsed.code, parsed.type]) {
      if (typeof code === "string" && CONTEXT_LIMIT_CODES.has(code)) return { kind: "provider_error_code", code };
    }
  } catch { /* Unknown diagnostics leave the original explicit provider hold. */ }
  finally { reader.releaseLock(); }
}
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
  if (input.requestProfile !== undefined && (input.requestProfile !== "customer-reference-full-source-v1" || input.privacy !== "public"))
    throw new Error("invalid_native_request_profile");
  // 48KB is Stanley's ordinary transport guard, not Jev's context window.
  // A customer-only overflow request may retain up to 192KB verbatim instead
  // of truncating it or paying for another semantic mapping pass. This byte
  // allowance is NOT a tokenizer or a promise of context acceptance. Jev 1.13
  // enforces 64k total / 32k state+longest-question tokens; any provider rejection
  // remains one exact persisted failure, with no automatic inference replay.
  // Official limits: https://docs.typesafe.ai/models (checked 2026-09-29).
  if (!serialized || Buffer.byteLength(serialized) > (input.requestProfile ? 192_000 : 48_000)) throw new Error("native_request_too_large");
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
  let startedAt: number | undefined;
  let signal: AbortSignal | undefined;
  let stage: NativeJevFailureDiagnostics["stage"] = "awaiting_headers";
  let responseMetadata: Partial<NativeJevFailureDiagnostics> = {};
  const serialized = JSON.stringify(body);
  const diagnostics = (): NativeJevFailureDiagnostics | undefined => startedAt === undefined ? undefined : ({
    version: 1, stage, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    timeoutMs: REQUEST_TIMEOUT_MS, requestBytes: Buffer.byteLength(serialized), questionCount: Object.keys(body.questions).length,
    ...responseMetadata,
  });
  try {
    await authorizeJevDispatch(JEV_MODEL, nativeJevFingerprint(input));
    startedAt = performance.now();
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (deps.fetch ?? fetch)(TYPESAFE_EVALUATION_URL, {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: serialized, signal, cache: "no-store", redirect: "error",
    });
    stage = "http_response";
    responseMetadata = { httpStatus: response.status, ...failureHeaders(response.headers) };
    if (!response.ok) {
      // Preserve the exact HTTP code: the durable receipt's global provider
      // circuit recognizes 402, while 429 remains ordinary rate-limit pressure.
      // For customer context recovery, retain only a whitelisted structured
      // context-limit code. Never store an error message or assume zero usage.
      const contextLimit = input.requestProfile && [400, 413, 422].includes(response.status)
        ? await customerContextLimitEvidence(response) : undefined;
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
      return { ok: false, error: { code: "typesafe_http_" + response.status,
        retryable: response.status === 429 || response.status >= 500, ...(contextLimit ? { contextLimit } : {}), diagnostics: diagnostics() }, usage };
    }
    stage = "reading_response";
    const raw = await response.text();
    stage = "validating_response";
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
    if (timeout) responseMetadata.timeoutSignalAborted = signal?.aborted ?? false;
    return { ok: false, error: { code: timeout ? "typesafe_timeout" : "native_response_unavailable", retryable: timeout,
      ...(startedAt === undefined ? {} : { diagnostics: diagnostics() }) }, usage };
  }
}

export async function evaluateNativeCached(input: NativeJevInput, context: JevSpendContext) {
  if (input.privacy === "private_excerpt") throw new Error("Private input must not enter the public response cache");
  if (input.requestProfile && (context.purpose !== "operating_catalog" || context.sourceKind !== "customer_reference"))
    throw new Error("customer_reference_profile_scope_required");
  return durableJevRequest({ fingerprint: nativeJevFingerprint(input), context, execute: () => evaluateNativeQuestions(input) });
}
