import "server-only";

/**
 * Compatibility no-op for the retired legacy structured-signal endpoint.
 *
 * The former implementation attached USAspending awards by name substring and
 * could not prove recipient identity. Verified federal signals now flow only
 * through `/api/cron/public-growth`, which binds a stable government entity.
 */
export async function sweepSignals(
  _limit = 150,
  _opts: { offset?: number } = {},
): Promise<{ checked: number; gov: number; funding: number }> {
  return { checked: 0, gov: 0, funding: 0 };
}
