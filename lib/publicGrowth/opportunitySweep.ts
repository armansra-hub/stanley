import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { reheatCompanyForFreshSignal } from "@/lib/db/reheat";
import { compactSamBulkRow, fetchSamOpportunityRange, parseSamOpportunityCursor, samQueueHash, samQueuedNoticeHash, SAM_QUEUE_MAX_BYTES, SAM_QUEUE_MAX_ENTRIES, type SamQueuedNotice, type SamOpportunityCursor } from "./samOpportunitySource";
import { PublicGrowthDeadlineError, requirePublicGrowthTime } from "./http";
import { recordPublicGrowthTrigger, saveOpportunityMatch, saveSamOpportunity, stableHash } from "./storage";
import type { DerivedGrowthEvent } from "./types";
import { verifySamDeliveryRelationship } from "./samOpportunityDelivery";
/* eslint-disable @typescript-eslint/no-explicit-any */
async function boundedQuery(query: any, deadlineMs: number) {
    requirePublicGrowthTime(deadlineMs);
    return await query.abortSignal(AbortSignal.timeout(Math.min(15000, Math.max(1, deadlineMs - Date.now()))));
}
interface SamSweepOptions {
    cursor?: unknown;
    deadlineMs: number;
    checkpoint: (cursor: SamOpportunityCursor) => Promise<void>;
}
export async function sweepSamOpportunities(days: number, offset: number, limit: number, options: SamSweepOptions) {
    if (!options || typeof options.checkpoint !== "function")
        throw new Error("SAM opportunities requires a fenced source checkpoint");
    return withServiceDeadline(options.deadlineMs, () => sweepSamOpportunitiesWithinDeadline(days, offset, limit, options));
}
async function sweepSamOpportunitiesWithinDeadline(days: number, offset: number, limit: number, options: SamSweepOptions) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("SAM matched-notice limit must be between 1 and 1000");
    const deadlineMs = options.deadlineMs;
    let cursor = parseSamOpportunityCursor(options.cursor);
    const db = serviceClient();
    const frozenDelivery = Boolean(cursor && cursor.nextByte === cursor.totalBytes);
    let stored = 0, matches = 0, triggers = 0, checked = 0, scanned = 0, sourceBytesRead = 0, rangesRead = 0, errors = 0;
    let issue: string | null = null;
    const currentIds: string[] = [];
    let afterId: string | null = null;
    for (let page = 0; !frozenDelivery && page < 20; page++) {
        let query = db.from("companies").select("id").contains("lists", ["netsuite_tam"]).or("status.is.null,status.neq.removed_from_tam").order("id").limit(1000);
        if (afterId)
            query = query.gt("id", afterId);
        const { data, error } = await boundedQuery(query, deadlineMs);
        if (error)
            throw new Error("SAM current-TAM index failed");
        for (const row of data ?? []) {
            if (afterId && row.id <= afterId)
                throw new Error("SAM TAM index failed to advance");
            currentIds.push(row.id);
            afterId = row.id;
        }
        if ((data?.length ?? 0) < 1000)
            break;
        if (page === 19)
            throw new Error("SAM current-TAM index exceeded its bounded population");
    }
    const current = new Set(currentIds);
    const entityLinks: any[] = [];
    afterId = null;
    for (let page = 0; !frozenDelivery && page < 50; page++) {
        let query = db.from("company_government_matches")
            .select("id,company_id,government_entity_id,government_entities!inner(uei,legal_name,dba_name,city,state),companies!inner(lists,status)")
            .eq("match_status", "verified").contains("companies.lists", ["netsuite_tam"])
            .or("status.is.null,status.neq.removed_from_tam", { referencedTable: "companies" }).order("id").limit(1000);
        if (afterId)
            query = query.gt("id", afterId);
        const { data, error } = await boundedQuery(query, deadlineMs);
        if (error)
            throw new Error(`SAM bulk entity index failed: ${error.message}`);
        for (const row of data ?? []) {
            if ((afterId && row.id <= afterId) || !current.has(String(row.company_id)))
                throw new Error("SAM verified identity scope changed or failed to advance");
            afterId = row.id;
            entityLinks.push(row);
        }
        if ((data?.length ?? 0) < 1000)
            break;
        if (page === 49)
            throw new Error("SAM verified identity index exceeded its bounded population");
    }
    const entityCompanies = new Map<string, string[]>(), namesByFirst = new Map<string, Array<{
        name: string;
        companyId: string;
        city: string;
        state: string;
        verifiedMatchId: string;
        governmentEntityId: string;
        sourceIdentity: Record<string, unknown>;
    }>>();
    const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
    for (const link of entityLinks) {
        const companyId = String(link.company_id), entity = link.government_entities ?? {};
        if (entity.uei)
            entityCompanies.set(String(entity.uei).toUpperCase(), [...(entityCompanies.get(String(entity.uei).toUpperCase()) ?? []), companyId]);
        for (const rawName of [entity.legal_name, entity.dba_name]) {
            const name = norm(rawName);
            if (!name)
                continue;
            const first = name.split(" ")[0];
            namesByFirst.set(first, [...(namesByFirst.get(first) ?? []), { name, companyId, city: norm(entity.city), state: norm(entity.state), verifiedMatchId: String(link.id), governmentEntityId: String(link.government_entity_id), sourceIdentity: { legal_name: entity.legal_name ?? null, dba_name: entity.dba_name ?? null, city: entity.city ?? null, state: entity.state ?? null } }]);
        }
    }
    const companyByEntity = new Map<string, string[]>();
    for (const link of entityLinks)
        companyByEntity.set(String(link.government_entity_id), [...(companyByEntity.get(String(link.government_entity_id)) ?? []), String(link.company_id)]);
    const awardsByKey = new Map<string, any[]>();
    const awardFacts: any[] = [];
    const entityIds = [...companyByEntity.keys()].sort();
    for (let entityStart = 0; entityStart < entityIds.length; entityStart += 200) {
        afterId = null;
        for (let page = 0; page < 100; page++) {
            let query = db.from("federal_awards")
                .select("id,government_entity_id,awarding_agency,awarding_office,naics_code,psc_code,end_date")
                .in("government_entity_id", entityIds.slice(entityStart, entityStart + 200)).not("naics_code", "is", null).order("id").limit(1000);
            if (afterId)
                query = query.gt("id", afterId);
            const { data, error } = await boundedQuery(query, deadlineMs);
            if (error)
                throw new Error(`SAM bulk incumbent index failed: ${error.message}`);
            for (const award of data ?? []) {
                if (afterId && award.id <= afterId)
                    throw new Error("SAM incumbent index failed to advance");
                afterId = award.id;
                awardFacts.push(award);
                if (awardFacts.length > 100000)
                    throw new Error("SAM incumbent index exceeded its bounded population");
                const companies = companyByEntity.get(String(award.government_entity_id)) ?? [];
                if (!companies.length)
                    continue;
                const key = `${norm(award.awarding_agency)}|${String(award.naics_code)}`;
                awardsByKey.set(key, [...(awardsByKey.get(key) ?? []), { ...award, companies }]);
            }
            if ((data?.length ?? 0) < 1000)
                break;
            if (page === 99)
                throw new Error("SAM incumbent index exceeded its bounded population");
        }
    }
    const identityScopeHash = frozenDelivery ? cursor!.identityScopeHash : samQueueHash({ currentIds, links: entityLinks.map(({ company_id, government_entity_id, government_entities }) => ({ company_id, government_entity_id, government_entities })), awards: awardFacts.sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    if (!frozenDelivery && cursor && cursor.identityScopeHash !== identityScopeHash)
        throw new Error("SAM opportunity matching scope changed; preserve and review the existing checkpoint");
    function matchNotice(row: SamQueuedNotice["row"]) {
        const candidates = new Map<string, SamQueuedNotice["candidates"][number][1]>();
        if (row.awardeeUei) {
            for (const companyId of entityCompanies.get(String(row.awardeeUei).toUpperCase()) ?? []) {
                const link = entityLinks.find((entry) => entry.company_id === companyId && String(entry.government_entities?.uei ?? "").toUpperCase() === String(row.awardeeUei).toUpperCase());
                if (!link)
                    throw new Error("SAM exact UEI candidate lost its verified relationship");
                candidates.set(companyId, { relationship: "awardee", confidence: 1, evidence: { method: "exact_awardee_uei", uei: String(row.awardeeUei).toUpperCase(), verifiedMatchId: String(link.id), governmentEntityId: String(link.government_entity_id) } });
            }
        }
        else if (row.awardeeName) {
            const awardee = norm(row.awardeeName), first = awardee.split(" ")[0];
            const matching = (namesByFirst.get(first) ?? []).filter((entry) => awardee === entry.name || awardee.startsWith(`${entry.name} `));
            const uniqueCompanies = [...new Set(matching.map((entry) => entry.companyId))];
            if (uniqueCompanies.length === 1) {
                const evidence = matching.find((entry) => entry.companyId === uniqueCompanies[0])!;
                const locationMatch = (!evidence.city || awardee.includes(` ${evidence.city} `)) && (!evidence.state || awardee.includes(` ${evidence.state} `));
                if (locationMatch)
                    candidates.set(uniqueCompanies[0], { relationship: "awardee", confidence: 0.97, evidence: { method: "verified_legal_name_and_location", awardee: row.awardeeName, verifiedMatchId: evidence.verifiedMatchId, governmentEntityId: evidence.governmentEntityId, sourceIdentity: evidence.sourceIdentity } });
            }
        }
        if (/^(p|o|k|r)$|solicitation|presolicitation|sources sought|combined synopsis/i.test(String(row.noticeType ?? "")) && row.naicsCode && row.agency) {
            for (const award of awardsByKey.get(`${norm(row.agency)}|${String(row.naicsCode)}`) ?? []) {
                const office = row.office && award.awarding_office && norm(row.office) === norm(award.awarding_office);
                const psc = row.pscCode && award.psc_code && row.pscCode === award.psc_code;
                if (!office && !psc)
                    continue;
                for (const companyId of award.companies) {
                    const link = entityLinks.find((entry) => entry.company_id === companyId && entry.government_entity_id === award.government_entity_id);
                    if (!link)
                        throw new Error("SAM incumbent candidate lost its verified relationship");
                    const incumbentAward = { id: award.id, government_entity_id: award.government_entity_id, awarding_agency: award.awarding_agency, awarding_office: award.awarding_office, naics_code: award.naics_code, psc_code: award.psc_code };
                    candidates.set(String(companyId), { relationship: "incumbent_recompete", confidence: office && psc ? 0.92 : 0.82, evidence: { method: "verified_incumbent_agency_naics_plus_office_or_psc", officeMatch: Boolean(office), pscMatch: Boolean(psc), priorAwardEnd: award.end_date, verifiedMatchId: String(link.id), governmentEntityId: String(link.government_entity_id), incumbentAward } });
                }
            }
        }
        return [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b));
    }
    // A complete source scan is separate from delivery. The immutable matched
    // queue is at most 512 KiB, so an exact company checkpoint never rewrites
    // megabytes. A larger source match set fails closed instead of truncating.
    try {
        while ((!cursor || cursor.nextByte < cursor.totalBytes) && rangesRead < 64 && scanned < 500000 && Date.now() < deadlineMs) {
            const range = await fetchSamOpportunityRange({ cursor, days, identityScopeHash, deadlineMs });
            rangesRead++;
            sourceBytesRead += range.bytesRead;
            cursor = range.cursor;
            for (const sourceRow of range.rows) {
                requirePublicGrowthTime(deadlineMs);
                if (scanned >= 500000)
                    break;
                const row = compactSamBulkRow(sourceRow.values, cursor.headers, cursor);
                if (row) {
                    const candidates = matchNotice(row);
                    if (candidates.length) {
                        if (cursor.notices.some((notice) => notice.row.noticeId === row.noticeId))
                            throw new Error("Duplicate SAM notice in the frozen source; checkpoint requires review");
                        const contents = { row, candidates, sourceRowHash: stableHash(sourceRow.values), candidateIdsHash: samQueueHash(candidates) };
                        const notice: SamQueuedNotice = { ...contents, queueEntryHash: samQueuedNoticeHash(contents) };
                        const nextNotices = [...cursor.notices, notice];
                        if (nextNotices.length > SAM_QUEUE_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(nextNotices), "utf8") > SAM_QUEUE_MAX_BYTES)
                            throw new Error("SAM frozen notice queue exceeds its bounded entries or bytes; preserve the source boundary for review");
                        // Validate new source evidence before admitting it to the queue,
                        // including the final source range that may be delivered now.
                        parseSamOpportunityCursor({ ...cursor, notices: [notice], deliveryIndex: 0 });
                        cursor.notices = nextNotices;
                    }
                }
                cursor.nextByte = sourceRow.endByte;
                cursor.scanned++;
                scanned++;
            }
            // One source-range checkpoint, including all compact matched notices.
            // No company publication occurs until the complete source reaches EOF.
            cursor = parseSamOpportunityCursor(cursor)!;
            await options.checkpoint(structuredClone(cursor));
        }
        if (cursor && cursor.nextByte === cursor.totalBytes) {
            while (cursor.deliveryIndex < cursor.notices.length && checked < limit && Date.now() < deadlineMs) {
                const notice = cursor.notices[cursor.deliveryIndex];
                const row = notice.row, orderedCandidates = notice.candidates;
                const { sourceRowHash, candidateIdsHash, queueEntryHash } = notice;
                // Validate the exact immutable entry again at every delivery boundary.
                if (samQueuedNoticeHash(notice) !== queueEntryHash || samQueueHash(orderedCandidates) !== candidateIdsHash)
                    throw new Error("SAM frozen notice changed before delivery");
                cursor.pendingNotice ??= { noticeId: row.noticeId, sourceRowHash, candidateIdsHash, queueEntryHash, lastCompanyId: null };
                await options.checkpoint(structuredClone(cursor));
                const opportunityId = await saveSamOpportunity(row);
                stored++;
                for (const [companyId, candidate] of orderedCandidates) {
                    if (cursor.pendingNotice.lastCompanyId && companyId <= cursor.pendingNotice.lastCompanyId)
                        continue;
                    requirePublicGrowthTime(deadlineMs);
                    const live = await boundedQuery(db.from("companies").select("id").eq("id", companyId).contains("lists", ["netsuite_tam"]).or("status.is.null,status.neq.removed_from_tam").maybeSingle(), deadlineMs);
                    if (live.error || live.data?.id !== companyId)
                        throw new Error("SAM candidate is no longer in the exact current TAM");
                    await verifySamDeliveryRelationship(companyId, candidate);
                    await saveOpportunityMatch(companyId, opportunityId, candidate.relationship, candidate.confidence, candidate.evidence);
                    matches++;
                    const awarded = candidate.relationship === "awardee";
                    const event: DerivedGrowthEvent = { family: "federal_opportunity", type: awarded ? "sam_award_notice" : "sam_incumbent_recompete", dedupeKey: `sam-opportunity:${row.noticeId}:${candidate.relationship}`, strength: awarded ? 88 : 78, summary: awarded ? `SAM award notice posted ${row.postedDate ?? "date unavailable"}: ${row.awardAmount == null ? "amount not reported" : `${Math.round(row.awardAmount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} awarded`} — ${row.title}.` : `Possible incumbent recompete posted ${row.postedDate ?? "date unavailable"}${row.responseDeadline ? `, response due ${String(row.responseDeadline).slice(0, 10)}` : ""}: ${row.title} (${row.agency}${row.naicsCode ? `, NAICS ${row.naicsCode}` : ""}).`, signalDate: row.postedDate, metadata: { noticeId: row.noticeId, relationship: candidate.relationship, awardAmount: row.awardAmount, agency: row.agency, office: row.office, naics: row.naicsCode, psc: row.pscCode, postedDate: row.postedDate, responseDeadline: row.responseDeadline, matchEvidence: candidate.evidence } };
                    if (await recordPublicGrowthTrigger(companyId, event, "SAM.gov Contract Opportunities", row.sourceUrl, candidate.confidence))
                        triggers++;
                    // A prior insert can have committed just before an interrupted request.
                    // Reapply the existing conditional reheat gate before acknowledging it.
                    const signalUrl = `${row.sourceUrl}${row.sourceUrl.includes("#") ? "&" : "#"}stanley-signal=${encodeURIComponent(event.dedupeKey)}`;
                    await reheatCompanyForFreshSignal(companyId, event.type, signalUrl, event.signalDate, { strict: true });
                    await recomputePriority(companyId);
                    cursor.pendingNotice.lastCompanyId = companyId;
                    if (companyId !== orderedCandidates.at(-1)?.[0])
                        await options.checkpoint(structuredClone(cursor));
                }
                delete cursor.pendingNotice;
                cursor.deliveryIndex++;
                checked++;
                await options.checkpoint(structuredClone(cursor));
            }
        }
    }
    catch (error) {
        if (!(error instanceof PublicGrowthDeadlineError)) {
            errors++;
            issue = error instanceof Error ? error.message : "SAM opportunity operation failed";
        }
    }
    const sourceComplete = Boolean(cursor && cursor.nextByte === cursor.totalBytes);
    const done = Boolean(sourceComplete && cursor && cursor.deliveryIndex === cursor.notices.length && !cursor.pendingNotice && !errors);
    const opportunityProgress = { sourceBytesRead, rangesRead, scanned, totalSourceRowsProcessed: cursor?.scanned ?? 0,
        nextByte: cursor?.nextByte ?? 0, totalBytes: cursor?.totalBytes ?? null, sourceSnapshotComplete: sourceComplete, publicationComplete: done,
        queueEntries: cursor?.notices.length ?? 0, queueBytes: Buffer.byteLength(JSON.stringify(cursor?.notices ?? []), "utf8"),
        queueHash: samQueueHash(cursor?.notices ?? []), deliveredNotices: cursor?.deliveryIndex ?? 0,
        noticeDeliveriesThisRun: checked, companyActionsThisRun: matches,
        remainingNotices: cursor ? cursor.notices.length - cursor.deliveryIndex : 0,
        identityScopeHash, sourceEtag: cursor?.etag ?? null, pendingNotice: Boolean(cursor?.pendingNotice), issue,
        stopReason: issue ? "explicit_source_or_delivery_hold" : done ? "source_and_delivery_complete" : Date.now() >= deadlineMs ? "deadline" : sourceComplete ? "delivery_limit" : "source_range_or_row_limit" };
    return { source: "sam-opportunities", mode: "public_bulk_bounded", offset, checked, scanned, nextOffset: offset, done, errors, stored, matches, triggers,
        advanceCursor: false, cursorPatch: { samOpportunityCursor: done ? null : cursor, ...(done ? { samOpportunityLastComplete: { ...opportunityProgress, completedAt: new Date().toISOString() } } : {}) },
        opportunityProgress, bulkEtag: cursor?.etag ?? null, bulkLastModified: cursor?.lastModified ?? null };
}
