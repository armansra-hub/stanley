import { NextResponse } from "next/server";
import { listStarred } from "@/lib/db/companies";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every starred lead across the whole database (any tab/source/status). */
export async function GET() {
  try {
    return NextResponse.json({ companies: await listStarred() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
