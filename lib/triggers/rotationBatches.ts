/** Leave one minute for the final source batch, publication, and parent receipt. */
export const SOURCE_WORK_BUDGET_MS = 240_000;

/**
 * The reservation RPC stamps selected rows immediately. Reserve only the small
 * batch we are about to attempt, so a deadline cannot stamp hundreds of untouched
 * companies as checked. Positive-offset recovery keeps a fixed snapshot because
 * advancing its timestamps would otherwise change subsequent offset ordering.
 */
export async function* rotationBatches<T>(
  load: (limit: number, offset: number) => Promise<T[]>,
  options: { limit: number; batchSize: number; offset?: number; budgetMs?: number; snapshot?: T[] },
): AsyncGenerator<T[]> {
  const { limit, batchSize, offset = 0, budgetMs = SOURCE_WORK_BUDGET_MS } = options;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("rotation batch sizes must be positive integers");
  }
  const deadline = Date.now() + budgetMs;
  const snapshot = options.snapshot ?? (offset > 0 ? await load(limit, offset) : null);
  let attempted = 0;
  while (attempted < limit && Date.now() < deadline) {
    const size = Math.min(batchSize, limit - attempted);
    const rows = snapshot ? snapshot.slice(attempted, attempted + size) : await load(size, 0);
    if (!rows.length) break;
    // A batch reserved before the deadline is always attempted, even if the
    // reservation itself was slow. Do not abandon it after stamping its cursor.
    yield rows;
    attempted += rows.length;
    if (rows.length < size) break;
  }
}
