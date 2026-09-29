import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { customerReferenceProgressResponse, customerReferenceRunResponse } from "@/lib/intelligence/customerReferenceHttp";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return customerReferenceProgressResponse();
}
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return customerReferenceRunResponse(req);
}
