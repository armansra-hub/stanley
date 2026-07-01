import { NextRequest, NextResponse } from "next/server";
import { getLead, listLeadNotes, listLeadTasks } from "@/lib/db/killlist";

/** Lazy-load one lead's detail (notes + tasks) when its drawer opens. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const [lead, notes, tasks] = await Promise.all([getLead(id), listLeadNotes(id), listLeadTasks(id)]);
    if (!lead) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ lead, notes, tasks });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
