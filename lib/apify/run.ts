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

/**
 * Fire-and-forget run. Triggers the actor ASYNC and registers a webhook that
 * pings `webhookUrl` when the run succeeds — so the caller (a cron) returns in
 * <2s instead of waiting out the run (no Vercel 60s timeout). Returns the runId.
 */
export async function runActorAsync(
  actorId: string,
  input: Record<string, unknown>,
  webhookUrl: string,
  maxItems = 25,
  maxTotalChargeUsd?: number,
): Promise<string> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const id = actorId.replace("/", "~");
  const webhooks = Buffer.from(
    JSON.stringify([{ eventTypes: ["ACTOR.RUN.SUCCEEDED"], requestUrl: webhookUrl }]),
  ).toString("base64");
  let url = `https://api.apify.com/v2/acts/${id}/runs?token=${TOKEN}&maxItems=${maxItems}&webhooks=${webhooks}`;
  if (maxTotalChargeUsd != null) url += `&maxTotalChargeUsd=${maxTotalChargeUsd}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Apify async ${actorId} ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return String((data as { data?: { id?: string } })?.data?.id ?? "");
}

/** Pull items from a finished run's dataset (used by the webhook ingest). */
export async function fetchDatasetItems(datasetId: string, maxItems = 60): Promise<Record<string, unknown>[]> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${TOKEN}&limit=${maxItems}&clean=true`,
  );
  if (!res.ok) throw new Error(`Apify dataset ${datasetId} ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}
