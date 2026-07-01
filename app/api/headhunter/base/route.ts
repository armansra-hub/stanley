import { NextRequest, NextResponse } from "next/server";
import { listBaseCompanies, listBaseTags, type BaseFilter } from "@/lib/db/companies";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET → distinct list-tags + the subindustry labels the data actually uses. */
export async function GET() {
  try {
    return NextResponse.json(await listBaseTags());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST { tags, matchAll, claimable, erp, state, q, limit, offset } → a page of the TAM Base. */
export async function POST(req: NextRequest) {
  let f: BaseFilter;
  try { f = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    return NextResponse.json(await listBaseCompanies(f ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
