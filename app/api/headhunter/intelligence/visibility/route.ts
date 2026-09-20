import {NextRequest,NextResponse} from 'next/server';
import {serviceClient,withServiceDeadline} from '@/lib/supabase/server';
import {intelligenceUiAuthorized,isUuid} from '@/lib/intelligence/http';
import {summarizeVisibility,type VisibilityObservation} from '@/lib/intelligence/visibility';
export const dynamic='force-dynamic';export const maxDuration=30;
export async function GET(req:NextRequest){
 if(!intelligenceUiAuthorized(req))return NextResponse.json({error:'unauthorized'},{status:401});
 const after=req.nextUrl.searchParams.get('after');const limit=Number(req.nextUrl.searchParams.get('limit')??200);
 if((after&&!isUuid(after))||!Number.isInteger(limit)||limit<1||limit>200)return NextResponse.json({error:'invalid_page'},{status:400});
 try{return await withServiceDeadline(Date.now()+20000,async()=>{
  const {data,error}=await serviceClient().rpc('intelligence_visibility_sample',{p_after:after,p_limit:limit});if(error||!data)throw new Error('visibility_unavailable');
  return NextResponse.json({...summarizeVisibility(data.observations as VisibilityObservation[]),asOf:data.asOf,hasMore:data.hasMore,nextCursor:data.nextCursor,
   scope:'Bounded page of current, non-excluded interpreted evidence from the eligible TAM; not a random or complete sample.'},{headers:{'Cache-Control':'no-store'}});
 });}catch{return NextResponse.json({error:'visibility_unavailable'},{status:503});}
}
