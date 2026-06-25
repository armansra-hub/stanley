import { NextRequest, NextResponse } from "next/server";
import { setCompanyNote } from "@/lib/db/companies";

export async function POST(req: NextRequest) {
  let body: { id?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await setCompanyNote(body.id, body.notes ?? "");
  return NextResponse.json({ ok: true });
}
