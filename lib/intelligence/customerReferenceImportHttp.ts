import "server-only";
import { NextResponse } from "next/server";
import { smallJson } from "./http";
import { importCustomerReferenceRegistry, normalizeCustomerReferenceImport } from "./customerReferenceRegistry";
import { withServiceDeadline } from "@/lib/supabase/server";

/** Called only after the route's existing app or dedicated-agent auth gate. */
export async function customerReferenceImportResponse(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  let records;
  try { records = normalizeCustomerReferenceImport(await smallJson(req, 2_000_000)); }
  catch (error) {
    const detail = error instanceof Error && /^invalid_registry_record:\d+$/.test(error.message) ? error.message : "invalid_registry_import";
    return NextResponse.json({ error: detail }, { status: 400, headers });
  }
  try {
    const receipt = await withServiceDeadline(Date.now() + 20_000, () => importCustomerReferenceRegistry(records));
    return NextResponse.json(receipt, { headers });
  } catch {
    return NextResponse.json({ error: "customer_registry_import_unavailable", action: "Read registry progress before retrying; imports preserve stable identities and announcement IDs." }, { status: 503, headers });
  }
}
