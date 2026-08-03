import { NextRequest, NextResponse } from "next/server";
import { ingestForm5500Observations, type Form5500ObservationInput } from "@/lib/publicGrowth/form5500Ingest";

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
  const url = new URL(req.url), offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0), limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
  const { data, error } = await serviceClient().from("companies").select("id,name,city,state,domain,website_raw,netsuite_internal_id").contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam").order("id").range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ companies: data ?? [], offset, nextOffset: offset + (data?.length ?? 0), done: (data?.length ?? 0) < limit });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json() as { observations?: Form5500ObservationInput[] };
  const rows = Array.isArray(body.observations) ? body.observations.slice(0, 250) : [];
  if (!rows.length) return NextResponse.json({ error: "observations required" }, { status: 400 });
  return NextResponse.json(await ingestForm5500Observations(rows));
}
