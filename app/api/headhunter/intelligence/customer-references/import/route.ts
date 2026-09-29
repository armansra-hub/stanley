import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized, sameOriginMutation } from "@/lib/intelligence/http";
import { customerReferenceImportResponse } from "@/lib/intelligence/customerReferenceImportHttp";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  return customerReferenceImportResponse(req);
}
