import { NextRequest, NextResponse } from "next/server";
import { setThumbsDown } from "@/lib/db/companies";

export async function POST(req: NextRequest) {
  let body: { ids?: string[]; value?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  await setThumbsDown(ids, Boolean(body.value));
  return NextResponse.json({ ok: true, count: ids.length, value: Boolean(body.value) });
}
