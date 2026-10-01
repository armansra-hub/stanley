import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { withServiceDeadline } from "@/lib/supabase/server";
import { smallJson } from "@/lib/intelligence/http";
import { CustomerResearchError, getApprovedCustomerCatalogStatus, registerApprovedCustomerCatalog, selectApprovedCustomerCatalog } from "@/lib/intelligence/customerResearchServer";
export const dynamic="force-dynamic";
export const maxDuration=60;
/** Bounded readback for uncertain publication; never replays a write. */
export async function GET(req:Request) {
  if(!agentAuthOk(req)) return unauthorized();
  const headers={"Cache-Control":"no-store"},query=new URL(req.url).searchParams;
  if([...query.keys()].some(key=>key!=="version") || query.getAll("version").length>1
    || (query.has("version") && !/^customer-catalog-v1-[a-f0-9]{64}$/.test(query.get("version")!))) {
    return NextResponse.json({error:"invalid_query"},{status:400,headers});
  }
  try {
    const result=await withServiceDeadline(Date.now()+10_000,()=>getApprovedCustomerCatalogStatus(query.get("version")??undefined));
    return NextResponse.json(result,{headers});
  } catch(error) {
    return NextResponse.json({error:error instanceof CustomerResearchError?error.code:"customer_catalog_unavailable"},
      {status:error instanceof CustomerResearchError?error.status:503,headers});
  }
}
/** Publishing a dictionary and selecting it never changes either paid switch. */
export async function POST(req:Request) {
  if(!agentAuthOk(req)) return unauthorized();
  const headers={"Cache-Control":"no-store"};
  try {
    const body=await smallJson(req,4*1024*1024);
    const allowed=body.action==="register"?["action","dictionary"]:body.action==="select"?["action","version"]:[];
    if(!allowed.length||Object.keys(body).some(k=>!allowed.includes(k)) || (body.action==="register"?!body.dictionary:typeof body.version!=="string")) return NextResponse.json({error:"invalid_body"},{status:400,headers});
    const result=await withServiceDeadline(Date.now()+50_000,async()=>body.action==="register"
      ?await registerApprovedCustomerCatalog(body.dictionary):await selectApprovedCustomerCatalog(body.version as string));
    return NextResponse.json(result,{headers});
  } catch(error) {
    const known=error instanceof CustomerResearchError;
    return NextResponse.json({error:known?error.code:error instanceof Error&&error.message==="body_too_large"?"body_too_large":"customer_catalog_unavailable"},
      {status:known?error.status:error instanceof Error&&error.message==="body_too_large"?413:503,headers});
  }
}
