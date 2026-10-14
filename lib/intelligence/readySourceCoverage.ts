import type { serviceClient } from "@/lib/supabase/server";
import { membershipFilter, pick, UUID, type CoverageQuery } from "./manualCoverage";
import { registryCompanyInScope } from "./retainedRegistryCapture";
import { completeCodexSource, type NewsPacket } from "./codexNews";

type Row = Record<string, unknown>;
type SourceKind = "news" | "website" | "job";
type Cursor = { observedAt: string; id: string; sourceKind?: SourceKind };
export type ReadySourceQuery = { scope: CoverageQuery["scope"]; limit: number; observedThrough: string; eventStart: string;
  sourceKind: SourceKind | null; cursor: Cursor | null; excludeObservationIds: string[] };
export const READY_SCAN_LIMIT = 256;
const JOB_LIMIT = 1024;
const SCALAR_FIELDS = "id,company_id,observed_at";
const COMPANY_FIELDS = "id,name,domain,website_raw,netsuite_internal_id,status,lists,tal_claimed,record_dead";
// Original text is inspected internally for completeness only; it is never included in this view's response.
const SOURCE_FIELDS = "id,company_id,source_kind,source_url,title,evidence_text,content_hash,event_date,observed_at,is_current,feedback_excluded,metadata,attributes,interpreted_at";
// Project the pending blocker instead of arbitrary provider results. It is never returned.
const JOB_FIELDS = "id,observation_id,kind,status,attempts,due_at,lease_token,lease_until,codex_news_request_id,pending_request:result->pendingRequest";
const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const invalid = (): never => { throw new Error("invalid_ready_source_query"); };
/** Preserve PostgreSQL sub-millisecond timestamps in both cursor validation and comparisons. UTC only. */
export function readyTimestamp(value: unknown): bigint {
  if (typeof value !== "string") return invalid();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(value);
  if (!m) return invalid();
  const whole = `${m[1]}T${m[2]}Z`, ms = Date.parse(whole);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== whole.slice(0, 19)) return invalid();
  return BigInt(ms) * 1_000_000n + BigInt((m[3] ?? "").padEnd(9, "0"));
}
export function parseReadySourceQuery(params: URLSearchParams): ReadySourceQuery {
  const allowed = new Set(["view", "scope", "limit", "observedThrough", "eventStart", "sourceKind", "cursorObservedAt", "cursorId", "cursorSourceKind", "excludeObservationIds"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) invalid();
  const scope = params.get("scope") ?? "all", limit = params.get("limit") ?? "12";
  if (params.get("view") !== "ready-sources" || !["all", "tam", "tal"].includes(scope) || !/^[1-9][0-9]*$/.test(limit) || Number(limit) > 12) invalid();
  const sourceKind = params.get("sourceKind") as SourceKind | null;
  if (sourceKind !== null && !["news", "website", "job"].includes(sourceKind)) invalid();
  const observedThrough = params.get("observedThrough")!, eventStart = params.get("eventStart")!;
  const through = readyTimestamp(observedThrough);
  if (readyTimestamp(eventStart) > through || through > BigInt(Date.now()) * 1_000_000n) invalid();
  const cursorDate = params.get("cursorObservedAt"), cursorId = params.get("cursorId"), cursorSourceKind = params.get("cursorSourceKind");
  if ((cursorDate === null) !== (cursorId === null)) invalid();
  // Old unfiltered timestamp/ID cursors remain valid. A filtered cursor must explicitly
  // bind its family; switching or dropping that filter with the binding fails closed.
  if (cursorDate === null ? cursorSourceKind !== null
    : (sourceKind !== null || cursorSourceKind !== null) && cursorSourceKind !== (sourceKind ?? "news+website")) invalid();
  const cursor = cursorDate !== null && cursorId !== null ? { observedAt: cursorDate, id: cursorId.toLowerCase(), ...(sourceKind ? { sourceKind } : {}) } : null;
  if (cursor && (!UUID.test(cursor.id) || readyTimestamp(cursor.observedAt) > through)) invalid();
  const excluded = params.get("excludeObservationIds");
  const excludeObservationIds = excluded === null ? [] : excluded.split(",").map(id => id.toLowerCase());
  // Canonical job gates already exclude prior work. Carry only this window's necessary local exclusions.
  if (excludeObservationIds.length > READY_SCAN_LIMIT || excludeObservationIds.some(id => !UUID.test(id)) || new Set(excludeObservationIds).size !== excludeObservationIds.length) invalid();
  return { scope: scope as ReadySourceQuery["scope"], limit: Number(limit), observedThrough, eventStart, sourceKind, cursor, excludeObservationIds };
}
const assert = (ok: unknown): void => { if (!ok) throw new Error("ready_source_read_inconsistent"); };
function uniqueRows(data: unknown, ids?: Set<string>): Map<string, Row> {
  assert(Array.isArray(data));
  const map = new Map<string, Row>();
  for (const row of data as Row[]) {
    assert(row && typeof row.id === "string" && UUID.test(row.id) && !map.has(row.id) && (!ids || ids.has(row.id)));
    map.set(row.id as string, row);
  }
  return map;
}
function compareCursor(a: Cursor, b: Cursor): number {
  const at = readyTimestamp(a.observedAt), bt = readyTimestamp(b.observedAt);
  return at === bt ? a.id.localeCompare(b.id) : at > bt ? -1 : 1;
}
const cursorOf = (r: Row): Cursor => ({ observedAt: r.observed_at as string, id: r.id as string });
const sourceKinds = (q: ReadySourceQuery): SourceKind[] => q.sourceKind ? [q.sourceKind] : ["news", "website"];
function gates(source: Row, company: Row | undefined, jobs: Row[], q: ReadySourceQuery, asOf: string): Record<string, boolean> {
  const m = object(source.metadata), text = typeof source.evidence_text === "string" ? source.evidence_text : "";
  let recent = false;
  try { const t = readyTimestamp(source.event_date); recent = t >= readyTimestamp(q.eventStart) && t <= readyTimestamp(q.observedThrough); } catch { /* Unknown source date is not publication evidence. */ }
  const job = jobs.length === 1 ? jobs[0] : {};
  let due = false;
  try { due = readyTimestamp(job.due_at) <= readyTimestamp(asOf); } catch { /* Missing/invalid due date stays ineligible. */ }
  // These are the existing document completeness branches, not a claim or full-read attestation.
  const supported = sourceKinds(q).includes(source.source_kind as SourceKind);
  // ATS event_date is the provider's j.date, never local first-seen. Greenhouse
  // supplies updated_at; Ashby's published_or_created label can also use updatedAt.
  // Keep those collected labels without claiming publication or an actual hire.
  const jobDateProvenance = object(m.discovery).collector === "job"
    && m.jobDateKind === (m.atsType === "greenhouse" ? "updated" : "published_or_created");
  const complete = supported && completeCodexSource({ snapshot: { observation: {
    source_kind: source.source_kind, evidence_text: text, metadata: m,
  } } } as NewsPacket) && (source.source_kind === "news"
    ? ["feed_publication", "source_publication", "page_publication"].includes(String(m.eventDateBasis))
    : source.source_kind === "job" ? jobDateProvenance : m.eventDateBasis === "page_publication");
  return { companyInScope: !!company && registryCompanyInScope(company, q.scope), current: source.is_current === true,
    sourceKindSupported: supported, feedbackClear: source.feedback_excluded === false,
    sourceDateInWindow: recent, notInterpreted: source.interpreted_at === null && source.attributes === null,
    notExcluded: !q.excludeObservationIds.includes(String(source.id)), completeSource: !!complete && text.trim().length > 0,
    oneInterpretJob: jobs.length === 1, queued: job.kind === "interpret" && job.status === "queued",
    unattempted: job.attempts === 0, unleased: job.lease_token === null && job.lease_until === null,
    unclaimed: job.codex_news_request_id === null, due,
    noPendingRequest: job.pending_request === null, noCodexReview: job.codex_review_absent === true };
}
function candidate(source: Row, company: Row, job: Row, checked: Record<string, boolean>) {
  const m = object(source.metadata);
  const text = (v: unknown) => typeof v === "string" && v.length <= 4096 ? v : null;
  const bool = (v: unknown) => typeof v === "boolean" ? v : null;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const strings = (v: unknown, fields: string[]) => Object.fromEntries(fields.map(key => [key, text(object(v)[key])]));
  return { observationId: source.id, jobId: job.id, companyId: source.company_id, company: pick(company, COMPANY_FIELDS),
    sourceKind: source.source_kind, sourceUrl: source.source_url, title: source.title, eventDate: source.event_date,
    observedAt: source.observed_at, contentHash: source.content_hash, retainedTextCharacters: (source.evidence_text as string).length,
    provenance: { eventDateBasis: text(m.eventDateBasis),
      sourceDates: Array.isArray(m.sourceDates) ? m.sourceDates.slice(0, 20).map(v => strings(v, ["kind", "value", "source"])) : null,
      sourceDatesPartial: Array.isArray(m.sourceDates) && m.sourceDates.length > 20,
      articleBodyAvailable: bool(m.articleBodyAvailable), evidenceKind: text(m.evidenceKind),
      textTruncated: bool(m.textTruncated), sourceTruncated: bool(m.sourceTruncated),
      sourceCharacters: count(m.sourceCharacters), retainedCharacters: count(m.retainedCharacters),
       discovery: strings(m.discovery, ["url", "title", "collector", "eventDate"]),
       ...(source.source_kind === "job" ? { atsType: text(m.atsType), jobDateKind: text(m.jobDateKind),
         listingChange: text(m.listingChange), isClientPlacement: bool(m.isClientPlacement),
         jobDateMeaning: "Provider listing timestamp; not proof of first publication or an actual hire. published_or_created may include an updated timestamp." } : {}) },
    gates: checked, admissionVerified: false, bodyReturned: false,
    nextStep: "Exact jobs/evidence/identity/dedupe read, then canonical claim and full independent source review." };
}
/** Read-only discovery: a finite scalar window first, then exact-ID reads. No global body ranking/count. */
export async function readySourceCoverage(db: ReturnType<typeof serviceClient>, q: ReadySourceQuery) {
  const asOf = new Date().toISOString();
  let scan = db.from("intelligence_observations").select(SCALAR_FIELDS).eq("is_current", true)
    .in("source_kind", sourceKinds(q)).lte("observed_at", q.observedThrough);
  if (q.cursor) scan = scan.or(`observed_at.lt.${q.cursor.observedAt},and(observed_at.eq.${q.cursor.observedAt},id.gt.${q.cursor.id})`);
  const scanned = await scan.order("observed_at", { ascending: false }).order("id", { ascending: true }).limit(READY_SCAN_LIMIT + 1);
  if (scanned.error) throw new Error("ready_source_scan_unavailable");
  const all = [...uniqueRows(scanned.data).values()];
  assert(all.length <= READY_SCAN_LIMIT + 1);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    assert(typeof r.company_id === "string" && UUID.test(r.company_id) && readyTimestamp(r.observed_at) <= readyTimestamp(q.observedThrough));
    assert(!q.cursor || compareCursor(cursorOf(r), q.cursor) > 0);
    assert(!i || compareCursor(cursorOf(all[i - 1]), cursorOf(r)) < 0);
  }
  const window = all.slice(0, READY_SCAN_LIMIT), ids = window.map(r => r.id as string), requested = new Set(ids);
  const companyIds = [...new Set(window.map(r => r.company_id as string))];
  const sourceById = new Map<string, Row>(), companyById = new Map<string, Row>(), jobsByObservation = new Map<string, Row[]>();
  if (ids.length) {
    const [sources, companies, jobs] = await Promise.all([
      db.from("intelligence_observations").select(SOURCE_FIELDS, { count: "exact" }).in("id", ids).limit(READY_SCAN_LIMIT),
      db.from("companies").select(COMPANY_FIELDS, { count: "exact" }).in("id", companyIds).or(membershipFilter(q.scope)).limit(READY_SCAN_LIMIT),
      db.from("intelligence_jobs").select(JOB_FIELDS, { count: "exact" }).in("observation_id", ids).eq("kind", "interpret").limit(JOB_LIMIT),
    ]);
    for (const result of [sources, companies, jobs]) assert(!result.error && Array.isArray(result.data) && Number.isSafeInteger(result.count) && result.count === result.data.length);
    for (const [id, row] of uniqueRows(sources.data, requested)) sourceById.set(id, row);
    for (const [id, row] of uniqueRows(companies.data, new Set(companyIds))) {
      assert(registryCompanyInScope(row, q.scope)); companyById.set(id, row);
    }
    const jobRows = uniqueRows(jobs.data);
    const unreviewed = new Set<string>();
    if (jobRows.size) {
      // SQL NULL (absent key) and JSON null must not be conflated by the JSON response decoder.
      // This bounded ID-only read proves the exact canonical result->codexNews IS NULL predicate.
      const clear = await db.from("intelligence_jobs").select("id", { count: "exact" }).in("id", [...jobRows.keys()])
        .is("result->codexNews", null).limit(JOB_LIMIT);
      assert(!clear.error && Array.isArray(clear.data) && Number.isSafeInteger(clear.count) && clear.count === clear.data.length);
      for (const id of uniqueRows(clear.data, new Set(jobRows.keys())).keys()) unreviewed.add(id);
    }
    for (const row of jobRows.values()) {
      assert(typeof row.observation_id === "string" && requested.has(row.observation_id) && row.kind === "interpret");
      const key = row.observation_id as string;
      jobsByObservation.set(key, [...(jobsByObservation.get(key) ?? []), { ...row, codex_review_absent: unreviewed.has(row.id as string) }]);
    }
  }
  const eligible: ReturnType<typeof candidate>[] = [], unresolvedObservationIds: string[] = [];
  const scannedRows = window.map(scalar => {
    const id = scalar.id as string, source = sourceById.get(id);
    if (!source || source.company_id !== scalar.company_id || source.is_current !== true || !sourceKinds(q).includes(source.source_kind as SourceKind)
      || readyTimestamp(source.observed_at) !== readyTimestamp(scalar.observed_at)) {
      unresolvedObservationIds.push(id); return { observationId: id, companyId: scalar.company_id, observedAt: scalar.observed_at, eligible: false, failedGates: ["observation_changed_or_missing"], currentnessVerified: false };
    }
    const company = companyById.get(source.company_id as string), jobs = jobsByObservation.get(id) ?? [];
    const checked = gates(source, company, jobs, q, asOf), failedGates = Object.keys(checked).filter(key => !checked[key]);
    if (!failedGates.length) eligible.push(candidate(source, company!, jobs[0], checked));
    return { observationId: id, companyId: scalar.company_id, observedAt: scalar.observed_at, eligible: !failedGates.length, failedGates, currentnessVerified: true };
  });
  const concrete = (v: unknown) => /\b(acquir\w*|acquisition|merger|funding|financing|raises?|series [a-f]|investment|expan\w*|new facilit\w*|appoint\w*|chief financial|CFO|launch\w*|partners?\w*|Oracle)\b/i.test(String(v));
  eligible.sort((a, b) => Number(concrete(b.title)) - Number(concrete(a.title)) ||
    compareCursor({ observedAt: a.eventDate as string, id: a.observationId as string }, { observedAt: b.eventDate as string, id: b.observationId as string }));
  const rows = eligible.slice(0, q.limit), overflow = eligible.slice(q.limit).map(r => ({ observationId: r.observationId, jobId: r.jobId }));
  // A short nonempty response may be a backend row cap. Only an empty read closes this frontier.
  const hasOlder = all.length > READY_SCAN_LIMIT ? true : window.length ? null : false;
  const repeatWindow = overflow.length > 0 || unresolvedObservationIds.length > 0;
  const nextCursor = repeatWindow ? q.cursor : window.length ? { ...cursorOf(window[window.length - 1]), ...(q.sourceKind ? { sourceKind: q.sourceKind } : {}) } : null;
  return { view: "ready-sources", scope: q.scope, sourceKind: q.sourceKind, observedThrough: q.observedThrough, eventStart: q.eventStart, asOf,
    rows, scanned: scannedRows, unreturnedEligible: overflow, unresolvedObservationIds,
    page: { scanLimit: READY_SCAN_LIMIT, scannedCount: window.length, limit: q.limit, eligibleInWindow: eligible.length,
      hasOlder, partial: window.length > 0 || repeatWindow, repeatWindow, inputCursor: q.cursor,
      nextCursor, cursorSourceKind: q.sourceKind ?? "news+website",
      continuation: repeatWindow ? "Retain overflow IDs; resolve missing/changed IDs. Repeat this cursor excluding processed IDs before advancing."
        : window.length ? "Continue with nextCursor and the same sourceKind/observedThrough/eventStart; pass cursorSourceKind with filtered cursors. A short page does not prove exhaustion."
          : "Empty bounded frontier; this is not account or workflow completion." },
    admissionVerified: false, coverageVerified: false, bodyReturned: false,
    consistency: "Live multi-read metadata, not an atomic snapshot. Exact canonical claim must revalidate membership, currentness, lease, pending work and completeness.",
    ranking: "Announcement-title heuristic, then recorded source event_date; full review must resolve actual event/publication dates." };
}
