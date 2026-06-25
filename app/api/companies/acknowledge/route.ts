import { NextRequest, NextResponse } from "next/server";
import { acknowledgeCompany } from "@/lib/db/companies";

export async function POST(req: NextRequest) {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await acknowledgeCompany(body.id);
  return NextResponse.json({ ok: true });
}
