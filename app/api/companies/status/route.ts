import { NextRequest, NextResponse } from "next/server";
import { setCompaniesStatus } from "@/lib/db/companies";

const ALLOWED = new Set(["new", "reviewed", "dismissed"]);

export async function POST(req: NextRequest) {
  let body: { ids?: string[]; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = body?.ids ?? [];
  const status = body?.status ?? "";
  if (!Array.isArray(ids) || ids.length === 0 || !ALLOWED.has(status)) {
    return NextResponse.json({ error: "ids[] and a valid status required" }, { status: 400 });
  }
  await setCompaniesStatus(ids, status as "new" | "reviewed" | "dismissed");
  return NextResponse.json({ ok: true, count: ids.length });
}
