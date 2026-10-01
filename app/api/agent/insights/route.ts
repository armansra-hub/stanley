import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { TRIGGER_SPEC } from "@/lib/triggers/config";
import { loadCompanyIdentityContext } from "@/lib/companyIdentity";
import { parseRegistryFinding, registryContentHash, verifyRegistryIdentity, type RegistryProfile } from "@/lib/agent/registryProfiles";
import { verifyRegistrySam } from "@/lib/agent/registrySam";
import { verifyRegistryOfficialHistory } from "@/lib/agent/registryOfficialHistory";
import { parseRegistryIrsFilingCorroboration, registryIrsFilingVerifier } from "@/lib/agent/registryIrsFiling";
import { parseRegistryWebsiteCorroboration, registryWebsiteVerifier, RegistryWebsiteMismatchError, RegistryWebsiteAvailabilityError } from "@/lib/agent/registryWebsite";

/**
 * Findings from the LinkedIn/website FULL-TEXT reading pass (2026-07-30).
 *
 * Arman's rule: no finding without a verbatim quote. A reading agent reads a lead's
 * entire LinkedIn description, every company post, and every decision-maker post —
 * never keyword-matched — and reports what it found. This endpoint is the only way
 * those findings reach Stanley, and it enforces the rule structurally: `evidence`
 * (a real quote) is required on every row, or the whole batch is rejected.
 *
 * Two kinds of finding, two different fates:
 *   trigger      — a dated event (hiring, expansion, launch). The reading agent
 *                  already resolved company attribution unambiguously (it read THIS
 *                  company's own page), unlike the news-headline queue, so it writes
 *                  straight to `triggers` and feeds priority like any other signal.
 *   netsuite_fit /
 *   ops_profile  — a standing operating-model characteristic. Tag only, per Arman's
 *                  explicit call: never reorders the Triggered tab. Written to
 *                  lead_insights and rendered as a badge everywhere the lead appears.
 *
 * POST { agent, findings: [{ internalId, kind, label, detail?, evidence, sourceUrl?, confidence?, postedAt? }] }
 * sourceUrl should always be the LinkedIn post/page URL the finding was read from — it's
 * what the badge/trigger's "View source" link points at on the lead record.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FINDINGS = 300;
const KINDS = new Set(["trigger", "netsuite_fit", "ops_profile"]);
const COMPANY_FIELDS = "id,netsuite_internal_id,name,domain,website_raw,city,state,lists";
type RegistryCompany = { id: string; netsuite_internal_id: string; name: string; domain: string | null; website_raw?: string | null; city?: string | null; state?: string | null; lists: string[] | null };
const canonical = (company: RegistryCompany) => !(company.lists ?? []).includes("tam_duplicate");
type RegistryStoredRow = { id: string; company_id: string; netsuite_internal_id: string; label: string; registry_profile: RegistryProfile };
async function registryReceipts(rows: RegistryStoredRow[]) {
  const eventIds = [...new Set(rows.map(row => row.registry_profile?.publication?.eventId).filter((id): id is string => Boolean(id)))];
  if (!rows.length) return [];
  const { data: events, error } = eventIds.length ? await serviceClient().from("app_events").select("id,kind,meta").in("id", eventIds) : { data: [], error: null };
  return rows.map(row => {
    const publication = row.registry_profile?.publication;
    const event = (events ?? []).find(event => event.id === publication?.eventId && event.kind === "registry.profiles_recorded");
    const verified = !error && Boolean(publication && Array.isArray(event?.meta?.receipts) && event.meta.receipts.some((receipt: Record<string, unknown>) => receipt.id === row.id
      && receipt.companyId === row.company_id && receipt.internalId === row.netsuite_internal_id && receipt.profileKey === row.label && receipt.contentHash === publication.contentHash));
    return { id: row.id, companyId: row.company_id, internalId: row.netsuite_internal_id, profileKey: row.label, ...publication, eventVerified: verified };
  });
}

async function registryPost(req: Request, body: { agent?: unknown; findings?: unknown; dryRun?: unknown }) {
  const findings = body.findings as unknown[];
  if (findings.length > 50) return NextResponse.json({ error: "registry findings capped at 50 per request" }, { status: 400 });
  let parsed;
  try { parsed = findings.map(row => parseRegistryFinding(row)); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid registry profile" }, { status: 422 }); }
  const keys = parsed.map(row => `${row.companyId}:${row.label}`);
  if (new Set(keys).size !== keys.length) return NextResponse.json({ error: "duplicate registry profile keys in batch" }, { status: 422 });
  if (parsed.some(row => [row.samCorroboration, row.officialWebsiteCorroboration, row.officialRegistrationHistoryCorroboration, row.officialIrsFilingCorroboration].filter(proof => proof !== undefined).length > 1))
    return NextResponse.json({ error: "registry corroboration methods cannot be mixed on one finding" }, { status: 422 });
  let websiteProofs;
  try { websiteProofs = parsed.map(row => row.officialWebsiteCorroboration === undefined ? null : parseRegistryWebsiteCorroboration(row.officialWebsiteCorroboration, row)); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid registry website evidence" }, { status: 422 }); }
  let irsProofs;
  try { irsProofs = parsed.map(row => row.officialIrsFilingCorroboration === undefined ? null : parseRegistryIrsFilingCorroboration(row.officialIrsFilingCorroboration, row)); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid IRS filing evidence" }, { status: 422 }); }
  // Sum independent request-local caches conservatively, including website root delegation.
  const websiteUrls = new Set(websiteProofs.flatMap(proof => proof ? [proof.sourceUrl, ...(proof.canonicalRedirect ? [proof.canonicalRedirect.requestedUrl] : [])] : []));
  const irsUrls = new Set(irsProofs.flatMap(proof => proof?.redirect ? [proof.redirect.requestedUrl] : []));
  if (websiteUrls.size + irsUrls.size > 3)
    return NextResponse.json({ error: "registry website requests capped at three distinct pages" }, { status: 422 });
  const verifyWebsite = registryWebsiteVerifier();
  const verifyIrsFiling = registryIrsFilingVerifier();
  const db = serviceClient();
  const ids = [...new Set(parsed.map(row => row.internalId))];
  const { data: companies, error } = await db.from("companies").select(COMPANY_FIELDS).in("netsuite_internal_id", ids);
  if (error) return NextResponse.json({ error: "registry company lookup failed" }, { status: 503 });
  const rows: Record<string, unknown>[] = [];
  const contexts = new Map<string, Awaited<ReturnType<typeof loadCompanyIdentityContext>>>();
  const { data: existing, error: priorError } = await db.from("lead_insights").select("*").in("company_id", parsed.map(row => row.companyId)).eq("source", "registry");
  if (priorError) return NextResponse.json({ error: "registry prior profiles unavailable" }, { status: 503 });
  for (const [index, row] of parsed.entries()) {
    const matches = ((companies ?? []) as RegistryCompany[]).filter(c => c.netsuite_internal_id === row.internalId && canonical(c));
    if (matches.length !== 1 || matches[0].id !== row.companyId) return NextResponse.json({ error: "registry exact company identity is missing or ambiguous", internalId: row.internalId }, { status: 422 });
    const company = matches[0];
    let context = contexts.get(company.id);
    if (!context) {
      try { context = await loadCompanyIdentityContext(company); contexts.set(company.id, context); }
      catch { return NextResponse.json({ error: "registry company identity context unavailable", internalId: row.internalId }, { status: 503 }); }
    }
    const prior = (existing ?? []).filter(old => old.company_id === company.id && old.netsuite_internal_id === row.internalId && old.registry_profile).map(old => old.registry_profile as RegistryProfile);
    let verification = verifyRegistryIdentity(row.profile, company, context, prior);
    const proof = websiteProofs[index];
    if (proof) {
      try { verification = await verifyWebsite(row, proof, company, context); }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "registry website corroboration unavailable", internalId: row.internalId,
        ...(e instanceof RegistryWebsiteMismatchError ? { profileKey: row.label, websiteMismatch: e.diagnostic } : {}),
        ...(e instanceof RegistryWebsiteAvailabilityError ? { profileKey: row.label, websiteAvailability: e.diagnostic } : {}) }, { status: 422 }); }
    }
    if (row.samCorroboration !== undefined) {
      try { verification = verifyRegistrySam(row, row.samCorroboration, company, context); }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "registry SAM corroboration unavailable", internalId: row.internalId }, { status: 422 }); }
    }
    if (row.officialRegistrationHistoryCorroboration !== undefined) {
      try { verification = verifyRegistryOfficialHistory(row, row.officialRegistrationHistoryCorroboration, company, context); }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "registry official history corroboration unavailable", internalId: row.internalId }, { status: 422 }); }
    }
    if (irsProofs[index]) {
      try { verification = await verifyIrsFiling(row, irsProofs[index], company, context); }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "registry IRS filing corroboration unavailable", internalId: row.internalId }, { status: 422 }); }
    }
    if (!verification) return NextResponse.json({ error: "registry identity requires corroborated legal name and full street/postal/state, or an unchanged verified binding", internalId: row.internalId }, { status: 422 });
    row.profile.verification = verification;
    rows.push({ company_id: company.id, netsuite_internal_id: row.internalId, source: "registry", kind: "ops_profile", label: row.label,
      detail: row.detail, evidence: row.evidence, evidence_url: row.sourceUrl, registry_profile: row.profile, content_hash: registryContentHash(row.profile, row.sourceUrl, row.detail) });
  }
  if (body.dryRun === true) return NextResponse.json({ dryRun: true, wouldWriteInsights: rows.length, wouldWriteTriggers: 0,
    profiles: rows.map(row => ({ companyId: row.company_id, internalId: row.netsuite_internal_id, profileKey: row.label, contentHash: row.content_hash, verification: (row.registry_profile as RegistryProfile).verification })) });
  // One transaction rechecks canonical rows, saves profiles and their event.
  // On any uncertain response the caller must inspect GET, never blind-repeat.
  const { data: published, error: publishError } = await db.rpc("registry_profiles_publish", { p_rows: rows, p_agent: callerAgent(req, body.agent) });
  if (publishError || !published || !Array.isArray(published.rows) || published.rows.length !== rows.length) return NextResponse.json({ state: "verification_pending", error: "registry publication receipt unavailable; inspect exact profiles before another write" }, { status: 502 });
  const receiptIds = published.rows.map((row: { id: string }) => row.id);
  const { data: readback, error: readError } = await db.from("lead_insights").select("*").in("id", receiptIds);
  const verified = !readError && readback?.length === rows.length && rows.every(row => readback.some(saved => saved.company_id === row.company_id
    && saved.netsuite_internal_id === row.netsuite_internal_id && saved.source === "registry" && saved.kind === "ops_profile" && saved.label === row.label
    && saved.evidence === row.evidence && saved.evidence_url === row.evidence_url && saved.registry_profile?.publication?.contentHash === row.content_hash));
  const receipts = await registryReceipts(readback ?? []);
  const eventVerified = receipts.length === rows.length && receipts.every(receipt => receipt.eventVerified);
  if (!verified || !eventVerified) return NextResponse.json({ state: "verification_pending", error: "registry exact row/event readback did not verify; inspect GET before another write", receiptIds, eventId: published.eventId }, { status: 502 });
  return NextResponse.json({ state: published.changed ? "published" : "unchanged", insightsWritten: published.changed, triggersWritten: 0, eventId: published.eventId,
    receipts, profiles: readback });
}

async function registryGet(internalIds: string[]) {
  if (!internalIds.length || internalIds.length > 50 || internalIds.some(id => !/^\d+$/.test(id)) || new Set(internalIds).size !== internalIds.length)
    return NextResponse.json({ error: "registry inspection requires 1–50 distinct exact internalIds" }, { status: 400 });
  const db = serviceClient();
  const { data: companies, error } = await db.from("companies").select(COMPANY_FIELDS).in("netsuite_internal_id", internalIds);
  if (error) return NextResponse.json({ error: "registry identity lookup failed" }, { status: 503 });
  const identities = [], missingInternalIds = [], ambiguousInternalIds = [];
  for (const internalId of internalIds) {
    const matches = ((companies ?? []) as RegistryCompany[]).filter(c => c.netsuite_internal_id === internalId && canonical(c));
    if (!matches.length) { missingInternalIds.push(internalId); continue; }
    if (matches.length !== 1) { ambiguousInternalIds.push(internalId); continue; }
    const company = matches[0];
    let context;
    try { context = await loadCompanyIdentityContext(company); }
    catch { return NextResponse.json({ error: "registry identity context unavailable", internalId }, { status: 503 }); }
    const { data: profiles, error: profileError } = await db.from("lead_insights").select("*").eq("company_id", company.id).eq("source", "registry").order("created_at", { ascending: false });
    if (profileError) return NextResponse.json({ error: "registry profile inspection failed", internalId }, { status: 503 });
    identities.push({ companyId: company.id, internalId, name: company.name, domain: company.domain, legalNames: context.aliases, addresses: context.addresses, profiles: profiles ?? [] });
  }
  const receipts = await registryReceipts(identities.flatMap(row => row.profiles));
  return NextResponse.json({ identities, missingInternalIds, ambiguousInternalIds, receipts });
}

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: { agent?: unknown; findings?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.findings) || !body.findings.length) {
    return NextResponse.json({ error: "findings must be a non-empty array" }, { status: 400 });
  }
  if (body.findings.length > MAX_FINDINGS) {
    return NextResponse.json({ error: `findings capped at ${MAX_FINDINGS} per request` }, { status: 400 });
  }
  if (body.findings.some(row => row && typeof row === "object" && row.source === "registry")) return registryPost(req, body);

  const agent = callerAgent(req, body.agent);
  const dryRun = body.dryRun === true;
  const errors: { index: number; problem: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const triggerRows: { internalId: string; type: string; label: string; evidence: string; sourceUrl?: string; postedAt?: string }[] = [];

  (body.findings as Record<string, unknown>[]).forEach((f, i) => {
    const internalId = String(f.internalId ?? "").trim().replace(/\.0$/, "");
    const kind = String(f.kind ?? "").trim();
    const label = String(f.label ?? "").trim();
    const evidence = String(f.evidence ?? "").trim();
    if (!internalId || !/^\d+$/.test(internalId)) return void errors.push({ index: i, problem: "missing/invalid internalId" });
    if (!KINDS.has(kind)) return void errors.push({ index: i, problem: `kind must be one of ${[...KINDS].join(", ")}` });
    if (!label) return void errors.push({ index: i, problem: "label is required" });
    // The whole point of this endpoint: no quote, no finding.
    if (evidence.length < 10) return void errors.push({ index: i, problem: "evidence must be a real verbatim quote (>=10 chars) — no finding without a quote" });

    if (kind === "trigger") {
      // The reading agent classifies the event (finance_hire/new_entity/ma/press/…) —
      // falls back to "news" (the generic/lowest-weight type) rather than silently
      // mislabeling an expansion or launch as a finance hire.
      const type = String(f.type ?? "").trim();
      if (!(type in TRIGGER_SPEC)) return void errors.push({ index: i, problem: `trigger kind requires a valid type (one of ${Object.keys(TRIGGER_SPEC).join(", ")})`, });
      triggerRows.push({ internalId, type, label, evidence, sourceUrl: f.sourceUrl ? String(f.sourceUrl) : undefined, postedAt: f.postedAt ? String(f.postedAt) : undefined });
    } else {
      rows.push({
        netsuite_internal_id: internalId, source: f.source === "website" || f.source === "record" ? f.source : "linkedin", kind, label,
        detail: f.detail ? String(f.detail).slice(0, 500) : null,
        evidence: evidence.slice(0, 600),
        evidence_url: f.sourceUrl ? String(f.sourceUrl) : null,
        confidence: ["high", "medium", "low"].includes(String(f.confidence)) ? f.confidence : "medium",
        posted_at: f.postedAt ? String(f.postedAt).slice(0, 10) : null,
      });
    }
  });

  if (!rows.length && !triggerRows.length) {
    return NextResponse.json({ error: "no usable findings", errors }, { status: 422 });
  }

  const db = serviceClient();
  const allIds = [...new Set([...rows.map((r) => String(r.netsuite_internal_id)), ...triggerRows.map((t) => t.internalId)])];
  const { data: companies, error: lookupErr } = await db.from("companies").select("id, netsuite_internal_id, lists").in("netsuite_internal_id", allIds);
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  const eligible = (companies ?? []).filter(c => !(c.lists ?? []).includes("tam_duplicate"));
  const byNsid = new Map(eligible.filter(c => eligible.filter(other => other.netsuite_internal_id === c.netsuite_internal_id).length === 1).map(c => [String(c.netsuite_internal_id), String(c.id)]));
  const missing = allIds.filter((id) => !byNsid.has(id));

  if (dryRun) {
    return NextResponse.json({
      dryRun: true, wouldWriteInsights: rows.filter((r) => byNsid.has(String(r.netsuite_internal_id))).length,
      wouldWriteTriggers: triggerRows.filter((t) => byNsid.has(t.internalId)).length,
      missingInternalIds: missing, errorCount: errors.length, rowErrors: errors.slice(0, 30),
    });
  }

  for (const r of rows) {
    const cid = byNsid.get(String(r.netsuite_internal_id));
    if (cid) r.company_id = cid;
  }
  const insightRows = rows.filter((r) => r.company_id);
  if (insightRows.length) {
    for (let i = 0; i < insightRows.length; i += 200) {
      const { error } = await db.from("lead_insights").upsert(insightRows.slice(i, i + 200), {
        onConflict: "company_id,source,kind,label", ignoreDuplicates: false,
      });
      if (error) return NextResponse.json({ error: error.message, writtenBefore: i }, { status: 500 });
    }
  }

  let triggersWritten = 0;
  for (const t of triggerRows) {
    const cid = byNsid.get(t.internalId);
    if (!cid) continue;
    const ok = await recordTrigger(cid, {
      type: t.type,
      summary: `LinkedIn: ${t.label} — “${t.evidence.slice(0, 150)}”`,
      source_name: "LinkedIn", source_url: t.sourceUrl ?? null, signal_date: t.postedAt ?? null,
    });
    if (ok) { triggersWritten++; await recomputePriority(cid); }
  }

  await logEvent("headhunter", "linkedin.insights_recorded", {
    summary: `${agent} recorded ${insightRows.length} LinkedIn insights + ${triggersWritten} triggers (${errors.length} bad rows, ${missing.length} unmatched)`,
    entity_type: "agent_bridge", meta: { agent, insights: insightRows.length, triggers: triggersWritten, errors: errors.length, missing: missing.length },
  });

  return NextResponse.json({
    insightsWritten: insightRows.length, triggersWritten, missingInternalIds: missing.slice(0, 30),
    missingCount: missing.length, errorCount: errors.length, rowErrors: errors.slice(0, 30),
  });
}

/** GET ?internalId=123 — a lead's recorded insights, for review or re-reading decisions. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const params = new URL(req.url).searchParams;
  if (params.has("internalIds") || params.get("registry") === "1") return registryGet((params.get("internalIds") ?? params.get("internalId") ?? "").split(",").map(v => v.trim()));
  const internalId = params.get("internalId");
  if (!internalId) return NextResponse.json({ error: "internalId is required" }, { status: 400 });
  const { data, error } = await serviceClient().from("lead_insights").select("*").eq("netsuite_internal_id", internalId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ internalId, count: data?.length ?? 0, insights: data ?? [] });
}
