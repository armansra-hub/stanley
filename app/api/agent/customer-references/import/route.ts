import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { customerReferenceImportResponse } from "@/lib/intelligence/customerReferenceImportHttp";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return customerReferenceImportResponse(req);
}
