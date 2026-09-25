/** Fixed metric names and standard database codes only. Never log query values,
 * response bodies, connection details or provider messages. */
export function logMetricFailure(metric: "cost" | "research_progress", error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  console.error("intelligence.metrics_unavailable", { metric,
    code: typeof code === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code) ? code : "unknown" });
}
