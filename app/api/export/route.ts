import { NextRequest, NextResponse } from "next/server";
import { recordExport } from "@/lib/db/companies";

// Persists an export: records the payload in `exports` and marks the companies
// exported (status exported_sql/exported_csv + exported_at) so they never
// resurface as new. The client builds the payload with the tested export engine
// (lib/export) and sends it here to persist atomically.
export async function POST(req: NextRequest) {
  let body: { ids?: string[]; type?: string; payload?: string; origin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = body?.ids ?? [];
  const type = body?.type ?? "";
  const origin = body?.origin === "net_new" ? "net_new" : "discovered";
  if (!Array.isArray(ids) || ids.length === 0 || (type !== "sql" && type !== "csv")) {
    return NextResponse.json({ error: "ids[] and type sql|csv required" }, { status: 400 });
  }
  await recordExport(type, ids, body.payload ?? "", origin);
  return NextResponse.json({ ok: true, count: ids.length });
}
