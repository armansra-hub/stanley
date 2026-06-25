import { NextRequest, NextResponse } from "next/server";
import { fetchDatasetItems } from "@/lib/apify/run";
import { SCHEDULED } from "@/lib/apify/scheduled";
import { ingestCandidates } from "@/lib/ingest/orchestrator";
import { addToPool, markPoolPromoted } from "@/lib/db/leadPool";
import { normalizeDomain } from "@/lib/domain";

// Apify calls this when a scheduled actor run SUCCEEDS. We pull the finished
// dataset and ingest it (fast) — the long actor run already happened on Apify,
// so this fits inside the serverless limit. Secret-guarded via ?secret=.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const actorKey = url.searchParams.get("actor") ?? "";
  const actor = SCHEDULED[actorKey];
  if (!actor) return NextResponse.json({ error: `unknown actor ${actorKey}` }, { status: 400 });

  let datasetId = "";
  try {
    const body = await req.json();
    datasetId = String(body?.resource?.defaultDatasetId ?? "");
  } catch {
    /* ignore */
  }
  if (!datasetId) return NextResponse.json({ error: "no datasetId" }, { status: 400 });

  const items = await fetchDatasetItems(datasetId, actor.maxItems);
  const candidates = actor.map(items);

  // Google Maps → park in the lead pool (no enrichment); the qualifier promotes.
  if (actor.toPool) {
    const pooled = await addToPool(candidates);
    return NextResponse.json({ actor: actorKey, datasetId, pooled });
  }

  const result = await ingestCandidates(candidates);

  // Qualifier hit: these pooled companies now have a signal — mark them promoted.
  if (actor.promotePool) {
    const domains = candidates.map((c) => normalizeDomain(c.website)).filter(Boolean);
    await markPoolPromoted(domains);
  }
  return NextResponse.json({ actor: actorKey, datasetId, candidates: candidates.length, ...result });
}
