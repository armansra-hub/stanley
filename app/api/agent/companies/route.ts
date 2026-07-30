import { NextResponse } from "next/server";
import { normalizeDomain } from "@/lib/domain";
import { logEvent } from "@/lib/db/events";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 500;
const TAM_LIST = "netsuite_tam";
const REMOVED_LIST = "tam_removed";

interface CompanyInput {
  internalId: string;
  name: string;
  website: string | null;
  industry: string | null;
  subindustry: string | null;
  state: string | null;
  revenueBand: string | null;
}

interface ExistingCompany {
  id: string;
  name: string;
  domain: string | null;
  website_raw: string | null;
  subindustry: string | null;
  ns_industry: string | null;
  state: string | null;
  revenue_band: string | null;
  source: string | null;
  status: string | null;
  sources: unknown;
  lists: unknown;
  claimable: boolean | null;
  is_base: boolean | null;
  lead_vendor: string | null;
  netsuite_internal_id: string | null;
  tam_score: number | null;
  record_digest: string | null;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeInput(raw: Record<string, unknown>, index: number): CompanyInput {
  const internalId = text(raw.internalId ?? raw.netsuiteInternalId ?? raw["Internal ID"]);
  const name = text(raw.name ?? raw.company ?? raw.Company);
  if (!internalId || !/^\d+$/.test(internalId)) {
    throw new Error(`row ${index + 1}: invalid NetSuite Internal ID`);
  }
  if (!name) throw new Error(`row ${index + 1}: company name is required`);
  return {
    internalId,
    name,
    website: text(raw.website ?? raw.Website),
    industry: text(raw.industry ?? raw.Industry),
    subindustry: text(raw.subindustry ?? raw["Industry Subgroup"]),
    state: text(raw.state ?? raw["State/Province"]),
    revenueBand: text(raw.revenueBand ?? raw.revenue ?? raw["Annual Revenue"]),
  };
}

function currentLists(value: unknown): string[] {
  const lists = Array.isArray(value) ? value.map(String) : [];
  return [...new Set([
    ...lists.filter((item) => item !== REMOVED_LIST && item !== "tam_duplicate"),
    TAM_LIST,
  ])];
}

function historicalLists(value: unknown, duplicate = false): string[] {
  const lists = Array.isArray(value) ? value.map(String) : [];
  return [...new Set([
    ...lists.filter((item) => item !== TAM_LIST),
    duplicate ? "tam_duplicate" : REMOVED_LIST,
  ])];
}

function canonicalCompany(matches: ExistingCompany[]): ExistingCompany {
  return [...matches].sort((left, right) => {
    const rank = (company: ExistingCompany) => {
      const lists = Array.isArray(company.lists) ? company.lists.map(String) : [];
      return Number(company.claimable === true)
        + Number(lists.includes(TAM_LIST))
        + Number(company.status !== "removed_from_tam")
        + Number(company.record_digest != null)
        + Number(company.tam_score != null);
    };
    return rank(right) - rank(left) || left.id.localeCompare(right.id);
  })[0];
}

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();

  let body: {
    action?: unknown;
    internalIds?: unknown;
    status?: unknown;
    fromStatuses?: unknown;
    rows?: unknown;
    dryRun?: unknown;
    note?: unknown;
    agent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.action === "set_current_tam_status") {
    if (!Array.isArray(body.internalIds) || body.internalIds.length === 0) {
      return NextResponse.json({ error: "internalIds must be a non-empty array" }, { status: 400 });
    }
    if (body.internalIds.length > MAX_ROWS) {
      return NextResponse.json({ error: `internalIds capped at ${MAX_ROWS}` }, { status: 400 });
    }
    const internalIds = [...new Set(
      body.internalIds.map(text).filter((value): value is string => Boolean(value)),
    )];
    if (
      internalIds.length !== body.internalIds.length
      || internalIds.some((internalId) => !/^\d+$/.test(internalId))
    ) {
      return NextResponse.json({ error: "internalIds must be unique numeric strings" }, { status: 422 });
    }
    const status = text(body.status);
    if (status !== "new" && status !== "reviewed") {
      return NextResponse.json({ error: "status must be new or reviewed" }, { status: 422 });
    }
    const fromStatuses = Array.isArray(body.fromStatuses)
      ? [...new Set(body.fromStatuses.map(text).filter((value): value is string => Boolean(value)))]
      : [];
    const allowedPriorStatuses = new Set([
      "new", "reviewed", "dismissed", "exported_csv", "exported_sql",
    ]);
    if (fromStatuses.some((value) => !allowedPriorStatuses.has(value))) {
      return NextResponse.json({ error: "fromStatuses contains an unsupported status" }, { status: 422 });
    }

    const db = serviceClient();
    const { data, error } = await db
      .from("companies")
      .select("id,name,status,lists,claimable,netsuite_internal_id")
      .in("netsuite_internal_id", internalIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const eligible = (data ?? []).filter((company) => {
      const lists = Array.isArray(company.lists) ? company.lists.map(String) : [];
      return company.claimable === true
        && lists.includes(TAM_LIST)
        && (!fromStatuses.length || fromStatuses.includes(String(company.status ?? "new")));
    });
    const now = new Date().toISOString();
    const updates = eligible.map((company) => ({
      id: company.id,
      name: company.name,
      status,
      last_updated_at: now,
    }));
    const priorStatusCounts = eligible.reduce<Record<string, number>>((counts, company) => {
      const prior = String(company.status ?? "new");
      counts[prior] = (counts[prior] ?? 0) + 1;
      return counts;
    }, {});
    const foundIds = new Set(eligible.map((company) => String(company.netsuite_internal_id)));
    const summary = {
      action: "set_current_tam_status",
      received: internalIds.length,
      eligibleCurrentTamRows: eligible.length,
      targetStatus: status,
      priorStatusCounts,
      skippedInternalIds: internalIds.filter((internalId) => !foundIds.has(internalId)),
    };
    if (body.dryRun === true) return NextResponse.json({ dryRun: true, ...summary });

    if (updates.length) {
      const { error: writeError } = await db.from("companies").upsert(updates, { onConflict: "id" });
      if (writeError) {
        return NextResponse.json({ error: writeError.message, ...summary }, { status: 500 });
      }
    }

    const agent = callerAgent(req, body.agent);
    await logEvent("headhunter", "agent.tam_status_reconciled", {
      summary: `${agent} changed ${updates.length} current TAM rows to ${status}`,
      entity_type: "agent_bridge",
      meta: {
        agent,
        note: text(body.note),
        ...summary,
        priorStatuses: eligible.map((company) => ({
          id: company.id,
          internalId: company.netsuite_internal_id,
          status: company.status,
        })),
      },
    });
    return NextResponse.json({ written: updates.length, ...summary });
  }

  if (body.action === "retire_membership") {
    if (!Array.isArray(body.internalIds) || body.internalIds.length === 0) {
      return NextResponse.json({ error: "internalIds must be a non-empty array" }, { status: 400 });
    }
    if (body.internalIds.length > MAX_ROWS) {
      return NextResponse.json({ error: `internalIds capped at ${MAX_ROWS}` }, { status: 400 });
    }
    const internalIds = [...new Set(
      body.internalIds.map(text).filter((value): value is string => Boolean(value)),
    )];
    if (
      internalIds.length !== body.internalIds.length
      || internalIds.some((internalId) => !/^\d+$/.test(internalId))
    ) {
      return NextResponse.json({ error: "internalIds must be unique numeric strings" }, { status: 422 });
    }

    const db = serviceClient();
    const { data, error } = await db
      .from("companies")
      .select("id,name,lists,netsuite_internal_id")
      .in("netsuite_internal_id", internalIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const now = new Date().toISOString();
    const updates = (data ?? []).map((company) => ({
      id: company.id,
      name: company.name,
      status: "removed_from_tam",
      lists: historicalLists(company.lists),
      claimable: false,
      is_base: true,
      last_updated_at: now,
    }));
    const foundIds = new Set((data ?? []).map((company) => String(company.netsuite_internal_id)));
    const missingInternalIds = internalIds.filter((internalId) => !foundIds.has(internalId));
    const summary = {
      action: "retire_membership",
      received: internalIds.length,
      companyRowsToRetire: updates.length,
      missingInternalIds,
    };
    if (body.dryRun === true) return NextResponse.json({ dryRun: true, ...summary });

    if (updates.length) {
      const { error: writeError } = await db.from("companies").upsert(updates, { onConflict: "id" });
      if (writeError) {
        return NextResponse.json({ error: writeError.message, ...summary }, { status: 500 });
      }
    }

    const agent = callerAgent(req, body.agent);
    await logEvent("headhunter", "agent.tam_membership_retired", {
      summary: `${agent} retired ${internalIds.length} stale exact NetSuite IDs without deleting history`,
      entity_type: "agent_bridge",
      meta: { agent, note: text(body.note), ...summary },
    });
    return NextResponse.json({ written: updates.length, ...summary });
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows must be a non-empty array" }, { status: 400 });
  }
  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `rows capped at ${MAX_ROWS}` }, { status: 400 });
  }

  let rows: CompanyInput[];
  try {
    rows = body.rows.map((row, index) => normalizeInput(row as Record<string, unknown>, index));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
  const duplicateIds = rows
    .map((row) => row.internalId)
    .filter((internalId, index, all) => all.indexOf(internalId) !== index);
  if (duplicateIds.length) {
    return NextResponse.json(
      { error: "duplicate NetSuite Internal IDs", duplicateIds: [...new Set(duplicateIds)] },
      { status: 422 },
    );
  }

  const db = serviceClient();
  const ids = rows.map((row) => row.internalId);
  const { data: exactData, error: exactError } = await db
    .from("companies")
    .select("id,name,domain,website_raw,subindustry,ns_industry,state,revenue_band,source,status,sources,lists,claimable,is_base,lead_vendor,netsuite_internal_id,tam_score,record_digest")
    .in("netsuite_internal_id", ids);
  if (exactError) return NextResponse.json({ error: exactError.message }, { status: 500 });

  const exactById = new Map<string, ExistingCompany[]>();
  for (const company of (exactData ?? []) as ExistingCompany[]) {
    const key = String(company.netsuite_internal_id);
    exactById.set(key, [...(exactById.get(key) ?? []), company]);
  }

  const missing = rows.filter((row) => !exactById.has(row.internalId));
  const missingDomains = [...new Set(
    missing.map((row) => normalizeDomain(row.website ?? "")).filter(Boolean),
  )];
  const { data: domainData, error: domainError } = missingDomains.length
    ? await db
      .from("companies")
      .select("id,name,domain,website_raw,subindustry,ns_industry,state,revenue_band,source,status,sources,lists,claimable,is_base,lead_vendor,netsuite_internal_id,tam_score,record_digest")
      .in("domain", missingDomains)
    : { data: [], error: null };
  if (domainError) return NextResponse.json({ error: domainError.message }, { status: 500 });
  const byDomain = new Map(
    ((domainData ?? []) as ExistingCompany[]).map((company) => [String(company.domain), company]),
  );

  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const adopted: string[] = [];
  const canonicalizedInternalIds: string[] = [];
  let duplicateRowsRetired = 0;
  const domainConflicts: { internalId: string; domain: string; boundTo: string }[] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const domain = normalizeDomain(row.website ?? "");
    let matches = exactById.get(row.internalId) ?? [];
    if (!matches.length && domain) {
      const domainMatch = byDomain.get(domain);
      if (domainMatch && !domainMatch.netsuite_internal_id) {
        matches = [domainMatch];
        adopted.push(row.internalId);
      } else if (domainMatch && String(domainMatch.netsuite_internal_id) !== row.internalId) {
        domainConflicts.push({
          internalId: row.internalId,
          domain,
          boundTo: String(domainMatch.netsuite_internal_id),
        });
      }
    }

    if (matches.length) {
      const company = canonicalCompany(matches);
      const duplicatesForId = matches.filter((match) => match.id !== company.id);
      if (duplicatesForId.length) canonicalizedInternalIds.push(row.internalId);
      for (const duplicate of duplicatesForId) {
        updates.push({
          id: duplicate.id,
          name: duplicate.name,
          domain: duplicate.domain,
          website_raw: duplicate.website_raw,
          subindustry: duplicate.subindustry,
          ns_industry: duplicate.ns_industry,
          state: duplicate.state,
          revenue_band: duplicate.revenue_band,
          source: duplicate.source === "discovered" ? "discovered" : "imported",
          status: "removed_from_tam",
          sources: Array.isArray(duplicate.sources) ? duplicate.sources.map(String) : [],
          lists: historicalLists(duplicate.lists, true),
          claimable: false,
          is_base: true,
          lead_vendor: duplicate.lead_vendor ?? "netsuite",
          netsuite_internal_id: row.internalId,
          last_updated_at: now,
        });
        duplicateRowsRetired++;
      }
      updates.push({
        id: company.id,
        name: row.name,
        domain: company.domain,
        website_raw: row.website ?? company.website_raw,
        subindustry: row.subindustry ?? company.subindustry,
        ns_industry: row.industry ?? company.ns_industry,
        state: row.state ?? company.state,
        revenue_band: row.revenueBand ?? company.revenue_band,
        source: company.source === "discovered" ? "discovered" : "imported",
        status: company.status === "removed_from_tam" ? "new" : (company.status ?? "new"),
        sources: [...new Set([
          ...(Array.isArray(company.sources) ? company.sources.map(String) : []),
          "netsuite",
        ])],
        lists: currentLists(company.lists),
        claimable: true,
        is_base: true,
        lead_vendor: "netsuite",
        netsuite_internal_id: row.internalId,
        last_updated_at: now,
      });
      continue;
    }

    const conflictingDomain = domain && byDomain.has(domain);
    inserts.push({
      name: row.name,
      domain: conflictingDomain ? null : (domain || null),
      website_raw: row.website,
      subindustry: row.subindustry,
      ns_industry: row.industry,
      state: row.state,
      revenue_band: row.revenueBand,
      source: "imported",
      status: "new",
      sources: ["netsuite"],
      lists: [TAM_LIST],
      claimable: true,
      is_base: true,
      lead_vendor: "netsuite",
      netsuite_internal_id: row.internalId,
      in_territory: true,
      first_seen_at: now,
      last_updated_at: now,
    });
  }

  const summary = {
    received: rows.length,
    exactMatches: rows.length - missing.length,
    companyRowsToUpdate: updates.length,
    companyRowsToInsert: inserts.length,
    adoptedByUnboundDomain: adopted,
    domainConflicts,
    canonicalizedInternalIds,
    duplicateRowsRetired,
    internalIds: ids,
  };
  if (body.dryRun === true) return NextResponse.json({ dryRun: true, ...summary });

  if (updates.length) {
    const { error } = await db.from("companies").upsert(updates, { onConflict: "id" });
    if (error) {
      return NextResponse.json({ error: error.message, phase: "update", ...summary }, { status: 500 });
    }
  }
  if (inserts.length) {
    const { error } = await db.from("companies").insert(inserts);
    if (error) {
      return NextResponse.json({ error: error.message, phase: "insert", ...summary }, { status: 500 });
    }
  }

  const linkIds = [
    ...new Set([
      ...adopted,
      ...inserts.map((company) => String(company.netsuite_internal_id)),
    ]),
  ];
  const { data: linkedCompanies } = linkIds.length
    ? await db
      .from("companies")
      .select("id,netsuite_internal_id")
      .in("netsuite_internal_id", linkIds)
    : { data: [] };
  const firstCompanyById = new Map<string, string>();
  for (const company of linkedCompanies ?? []) {
    const internalId = String(company.netsuite_internal_id);
    if (!firstCompanyById.has(internalId)) {
      firstCompanyById.set(internalId, String(company.id));
    }
  }
  for (const [internalId, companyId] of firstCompanyById) {
    await db
      .from("lead_documents")
      .update({ company_id: companyId })
      .eq("netsuite_internal_id", internalId);
  }

  const agent = callerAgent(req, body.agent);
  await logEvent("headhunter", "agent.companies_upserted", {
    summary: `${agent} ensured ${ids.length} exact NetSuite company IDs (${inserts.length} inserted, ${updates.length} rows updated)`,
    entity_type: "agent_bridge",
    meta: { agent, note: text(body.note), ...summary },
  });
  return NextResponse.json({ written: updates.length + inserts.length, ...summary });
}
