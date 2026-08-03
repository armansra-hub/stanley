import { NextRequest, NextResponse } from "next/server";
import { ingestSamExtractObservations, type SamExtractObservationInput } from "@/lib/publicGrowth/samSweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function suppliedSecret(req: NextRequest) {
  const auth = req.headers.get("authorization");
  return req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
}

function authorized(req: NextRequest) {
  const supplied = suppliedSecret(req);
  return Boolean(supplied && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
  ));
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { serviceClient } = await import("@/lib/supabase/server");
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "companies";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
  const db = serviceClient();
  if (kind === "links") {
    const { data, error } = await db.from("company_government_matches")
      .select("company_id,government_entities(uei,cage_code)")
      .eq("match_status", "verified")
      .order("company_id")
      .range(offset, offset + limit - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ links: data ?? [], offset, nextOffset: offset + (data?.length ?? 0), done: (data?.length ?? 0) < limit });
  }
  const { data, error } = await db.from("companies")
    .select("id,name,city,state,domain,website_raw,netsuite_internal_id")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ companies: data ?? [], offset, nextOffset: offset + (data?.length ?? 0), done: (data?.length ?? 0) < limit });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json() as { observations?: SamExtractObservationInput[] };
  const rows = Array.isArray(body.observations) ? body.observations.slice(0, 50) : [];
  if (!rows.length) return NextResponse.json({ error: "observations required" }, { status: 400 });
  return NextResponse.json(await ingestSamExtractObservations(rows));
}
