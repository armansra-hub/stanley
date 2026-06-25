import { NextRequest, NextResponse } from "next/server";
import { initSalesSearch, fetchSalesPage, mapPeopleLeads, mapCompanyLeads } from "@/lib/apify/salesNav";
import {
  recordSalesRequest, getReadySalesRequests, markSalesRequestDone, markSalesRequestError,
  searchInitedRecently, salesNavTableReady,
} from "@/lib/db/salesNav";
import { salesSearchesDueToday, salesSearchByKey } from "@/config/salesNav";
import { ingestCandidates } from "@/lib/ingest/orchestrator";

/**
 * Daily Sales Navigator cron. The actor is two-phase (init → wait ~10 min →
 * fetch by request_id + page), which can't fit one 60s function, so each run:
 *   1) FETCHES results for any pending request init'd on a previous run (now
 *      ready), paginating until exhausted, and ingests them; then
 *   2) INITS the searches due today (weekday in initDays), saving the request_id
 *      for the next run to fetch.
 * Dedupe is automatic downstream (company by name/domain, signal by profile URL),
 * so re-runs never create duplicates and the <1yr tenure window keeps surfacing
 * fresh hires. ?key=<search> forces an init now (manual).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Guard: without the table (migration 0007) we can't persist request_ids, so
  // an init would waste the $0.50 fee. Bail clearly until it's applied.
  if (!(await salesNavTableReady())) {
    return NextResponse.json({ ok: false, error: "run migration 0007_sales_nav.sql first (sales_nav_requests table missing)" });
  }

  const fetched: Record<string, unknown>[] = [];
  const inited: Record<string, unknown>[] = [];

  // ── Phase 1: fetch + ingest ready requests ──
  const ready = await getReadySalesRequests(10);
  for (const reqRow of ready) {
    const search = salesSearchByKey(reqRow.search_key);
    if (!search) {
      await markSalesRequestError(reqRow.id, "unknown search_key");
      continue;
    }
    // Cap how many we ENRICH per run so fetch+enrich fits the 60s function cap
    // (enrichment is the bottleneck — ~50 candidates is the ceiling). Sales Nav
    // orders by relevance, so the top N are the freshest/most relevant.
    const INGEST_CAP = 40;
    const maxPages = Math.max(1, Math.ceil(search.limit / 100));
    const rawItems: Record<string, unknown>[] = [];
    try {
      for (let page = 1; page <= maxPages && rawItems.length < INGEST_CAP; page++) {
        const leads = await fetchSalesPage(reqRow.request_id, page);
        if (leads.length === 0) break;
        rawItems.push(...leads);
        if (leads.length < 100) break; // last page
      }
      const capped = rawItems.slice(0, INGEST_CAP);
      const candidates = search.type === "people" ? mapPeopleLeads(capped) : mapCompanyLeads(capped);
      const result = candidates.length > 0 ? await ingestCandidates(candidates) : null;
      await markSalesRequestDone(reqRow.id, capped.length, maxPages);
      fetched.push({ key: reqRow.search_key, leads: capped.length, upserted: result?.upserted ?? 0, new: result?.new_companies ?? 0 });
    } catch (e) {
      await markSalesRequestError(reqRow.id, e instanceof Error ? e.message : String(e));
      fetched.push({ key: reqRow.search_key, error: true });
    }
  }

  // ── Phase 2: init searches due today ──
  const forceKey = url.searchParams.get("key");
  const weekday = new Date().getUTCDay();
  const due = forceKey
    ? [salesSearchByKey(forceKey)].filter((s): s is NonNullable<typeof s> => !!s && !!s.url)
    : salesSearchesDueToday(weekday);

  for (const search of due) {
    if (!forceKey && (await searchInitedRecently(search.key))) {
      inited.push({ key: search.key, skipped: "already init'd recently" });
      continue;
    }
    try {
      const requestId = await initSalesSearch(search.url, search.limit);
      if (!requestId) {
        inited.push({ key: search.key, error: "init rejected (invalid filters?)" });
        continue;
      }
      await recordSalesRequest(search.key, requestId);
      inited.push({ key: search.key, request_id: requestId });
    } catch (e) {
      inited.push({ key: search.key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ok: true, weekday, fetched, inited });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
