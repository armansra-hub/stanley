import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { serviceClient } from "@/lib/supabase/server";
import { buildCompanyIdentityContext } from "@/lib/companyIdentity";
import { COMPANY_FIELDS, OBSERVATION_FIELDS, JOB_FIELDS, SOURCE_FIELDS, parseCoverageQuery, membershipFilter,
  evidenceProjection, sourceProjection, jobProjection, pick } from "@/lib/intelligence/manualCoverage";
import { REGISTRY_CAPTURE_FIELDS, RegistryCaptureReadError, registryCompanyInScope, retainedRegistryCapture } from "@/lib/intelligence/retainedRegistryCapture";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** No claims, reservation stamps, provider calls or worker wakeups. Keyset pages are live, not an immutable membership snapshot. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let q;
  try { q = parseCoverageQuery(new URL(req.url).searchParams); } catch { return json({ error: "invalid_coverage_query" }, 400); }
  try {
    const db = serviceClient();
    let companies = db.from("companies").select(COMPANY_FIELDS).or(membershipFilter(q.scope));
    if (q.view === "companies") {
      if (q.after) companies = companies.gt("id", q.after);
      const { data, error } = await companies.order("id").limit(q.limit + 1);
      if (error) throw error;
      const partial = (data ?? []).length > q.limit, rows = (data ?? []).slice(0, q.limit).map(row => pick(row, COMPANY_FIELDS));
      return json({ view: q.view, scope: q.scope, rows, page: { partial, nextAfter: partial ? rows.at(-1)?.id : null, limit: q.limit },
        coverageVerified: false, consistency: "live_keyset_reconcile_membership_at_end", asOf: new Date().toISOString() });
    }
    const { data: accounts, error: accountError } = await companies.eq("id", q.companyId!).limit(2);
    if (accountError) throw accountError;
    if (!accounts?.length) return json({ error: "company_not_in_scope" }, 404);
    if (accounts.length !== 1) throw new Error("ambiguous_company");
    if (q.view === "registry-capture") {
      if (accounts[0].id !== q.companyId) throw new RegistryCaptureReadError("retained_binding_mismatch");
      if (!registryCompanyInScope(accounts[0], q.scope)) return json({ error: "company_not_in_scope" }, 404);
      const { data, error } = await db.from("intelligence_source_state").select(REGISTRY_CAPTURE_FIELDS)
        .eq("company_id", q.companyId!).eq("source_key", q.sourceKey!).limit(2);
      if (error) throw error;
      if (!data?.length) return json({ error: "retained_registry_capture_not_found", coverageVerified: false }, 404);
      if (data.length !== 1) throw new RegistryCaptureReadError("retained_binding_mismatch");
      return json({ view: q.view, scope: q.scope, company: pick(accounts[0], "id,name,domain,website_raw,city,state,netsuite_internal_id,status,lists,tal_claimed"),
        capture: retainedRegistryCapture(data[0], q.companyId!, q.sourceKey!),
        page: { partial: false, nextAfter: null, limit: 1 }, coverageVerified: false, asOf: new Date().toISOString() });
    }
    const company = pick(accounts[0], COMPANY_FIELDS);
    let sourceKind: unknown = null;
    if (q.view === "jobs") {
      const { data: observations, error } = await db.from("intelligence_observations").select("id,source_kind")
        .eq("company_id", q.companyId!).eq("id", q.observationId!).eq("is_current", true).eq("feedback_excluded", false).limit(2);
      if (error) throw error;
      if (observations?.length !== 1) return json({ error: "current_observation_not_in_scope" }, 404);
      sourceKind = observations[0].source_kind;
    }
    const table = q.view === "evidence" ? "intelligence_observations" : q.view === "sources" ? "intelligence_source_state" : "intelligence_jobs";
    const key = q.view === "sources" ? "source_key" : "id";
    // Each branch selects only its explicit projection; avoid Supabase's combinatorial dynamic-select inference.
    let query: any = (db.from(table) as any).select(q.view === "evidence" ? OBSERVATION_FIELDS : q.view === "sources" ? SOURCE_FIELDS : JOB_FIELDS)
      .eq(q.view === "jobs" ? "observation_id" : "company_id", q.view === "jobs" ? q.observationId! : q.companyId!);
    if (q.view === "evidence") query = query.eq("is_current", true).eq("feedback_excluded", false);
    if (q.after) query = query.gt(key, q.after);
    const { data, error } = await query.order(key).limit(q.limit + 1);
    if (error) throw error;
    const partial = (data ?? []).length > q.limit, page: Record<string, unknown>[] = (data ?? []).slice(0, q.limit);
    let identity = null;
    if (q.view === "evidence") {
      const result = await db.rpc("company_identity_source_context", { p_company_id: q.companyId });
      if (result.error) throw new Error("identity_unavailable");
      if (result.data === null) {
        identity = { available: false, complete: false, reason: "canonical_identity_context_unavailable" };
      } else {
        if (typeof result.data !== "object" || Array.isArray(result.data) || !Array.isArray(result.data.websites) || !Array.isArray(result.data.claims)
          || !("record" in result.data)) throw new Error("identity_schema_unavailable");
        identity = { available: true, complete: false,
          ...buildCompanyIdentityContext(accounts[0], result.data),
          provenance: { record: result.data.record ? pick(result.data.record, "id,capturedAt") : null,
            websites: result.data.websites.map((row: Record<string, unknown>) => pick(row, "id,url,capturedAt")),
            claims: result.data.claims.map((row: Record<string, unknown>) => pick(row, "id,name,subjectName,relationship,sourceUrl,capturedAt")) },
          upstreamLimits: { recordHeaderCharacters: 6000, websites: 8, claims: 20 },
          limitations: "Bounded canonical identity context; record header and lists may be incomplete. Builder also bounds aliases/addresses/context; this is not a full record read." };
      }
    }
    const rows = page.map(row => q.view === "evidence" ? evidenceProjection(row) : q.view === "sources" ? sourceProjection(row) : jobProjection(row, sourceKind));
    return json({ view: q.view, scope: q.scope, company, identity, rows,
      page: { partial, nextAfter: partial ? page.at(-1)?.[key] : null, limit: q.limit }, coverageVerified: false,
      consistency: "live_keyset_reconcile_membership_and_source_versions_at_end", asOf: new Date().toISOString() });
  } catch (error) {
    return json({ error: "coverage_read_unavailable", coverageVerified: false,
      ...(error instanceof RegistryCaptureReadError ? { reason: error.reason, retainedCaptureReturned: false } : {}) }, 503);
  }
}
