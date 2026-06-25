import "server-only";

/**
 * Generic Apify actor runner. Uses the run-sync-get-dataset-items endpoint:
 * one call runs the actor and returns its dataset items directly. `maxItems`
 * caps results AND spend (these actors are pay-per-result). Source-isolated by
 * the caller — throws on failure so the discovery loop can catch + continue.
 */
const TOKEN = process.env.APIFY_TOKEN;

export async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  maxItems = 25,
  maxTotalChargeUsd?: number,
): Promise<Record<string, unknown>[]> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const id = actorId.replace("/", "~");
  let url =
    `https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items` +
    `?token=${TOKEN}&maxItems=${maxItems}`;
  // Some actors enforce a per-run minimum charge (e.g. BuiltIn = $1.00) and
  // reject runs whose ceiling is below it.
  if (maxTotalChargeUsd != null) url += `&maxTotalChargeUsd=${maxTotalChargeUsd}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Apify ${actorId} ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}
