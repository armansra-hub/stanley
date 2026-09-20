import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { fetchRegionalPage, normalizeRegionalRow, regionalCandidateIndex, confirmRegionalCandidate, REGIONAL_SOURCES, type RegionalWebsiteEvidence, type RegionalAccount, type RegionalSourceId, type RegionalCandidate } from "./sources";

export type RegionalLease = { id: RegionalSourceId; lease_token: string; next_offset: number; snapshot_version: string | null; snapshot_complete: boolean };
export interface RegionalStore {
  accounts(): Promise<RegionalAccount[]>;
  identityEvidence?(companyIds: string[]): Promise<RegionalWebsiteEvidence[]>;
  claim(source: RegionalSourceId): Promise<RegionalLease | null>;
  finish(lease: RegionalLease, result: { offset: number; version: string | null; complete: boolean; scanned: number; candidates: RegionalCandidate[]; error?: string }): Promise<void>;
}
function databaseStore(): RegionalStore {
  const db = serviceClient();
  return {
    async identityEvidence(companyIds) {
      const { data, error } = await db.rpc("regional_contract_identity_evidence", { p_companies: companyIds });
      if (error) throw new Error("regional_identity_evidence_unavailable");
      return data ?? [];
    },
    async accounts() {
      const accounts: RegionalAccount[] = []; let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        let query = db.from("companies").select("id,name,domain,city,state,netsuite_internal_id").contains("lists", ["netsuite_tam"])
          .neq("status", "removed_from_tam").not("lists", "cs", "{tam_duplicate}").order("id").limit(1000);
        if (after) query = query.gt("id", after);
        const { data, error } = await query;
        if (error) throw new Error("regional_accounts_unavailable");
        accounts.push(...(data ?? []).filter(row => /^[0-9]+$/.test(row.netsuite_internal_id ?? "")));
        if ((data?.length ?? 0) < 1000) return accounts;
        after = data![data!.length - 1].id;
      }
      throw new Error("regional_account_capacity");
    },
    async claim(source) { const { data, error } = await db.rpc("regional_contract_claim", { p_source: source }); if (error) throw new Error("regional_claim_failed"); return data; },
    async finish(lease, result) {
      const { error } = await db.rpc("regional_contract_finish", { p_source: lease.id, p_lease: lease.lease_token,
        p_offset: result.offset, p_version: result.version, p_complete: result.complete, p_scanned: result.scanned, p_candidates: result.candidates, p_error: result.error ?? null });
      if (error) throw new Error("regional_checkpoint_failed");
    },
  };
}

export async function runRegionalContracts(deps: { store?: RegionalStore; fetchPage?: typeof fetchRegionalPage; now?: () => number } = {}) {
  const result = { enabled: intelligenceEnabled(), pages: 0, scanned: 0, candidates: 0, confirmed: 0, identityLookupFailed: 0, failed: 0, unchanged: 0 };
  if (!result.enabled) return result;
  const store = deps.store ?? databaseStore(), fetchPage = deps.fetchPage ?? fetchRegionalPage, now = deps.now ?? Date.now;
  const accounts = await store.accounts(), match = regionalCandidateIndex(accounts), deadline = now() + 180000;
  const ids = Object.keys(REGIONAL_SOURCES) as RegionalSourceId[];
  // Each source gets one page per round; one large archive cannot starve the other.
  for (let round = 0; round < 4 && now() < deadline - 20000; round++) for (const source of ids) {
    const lease = await store.claim(source); if (!lease) continue;
    try {
      const page = await fetchPage(source, { offset: lease.next_offset, version: lease.snapshot_version, complete: lease.snapshot_complete });
      let candidates = match(page.rows.flatMap(row => normalizeRegionalRow(source, row)));
      if (candidates.length > 5000) throw new Error("regional_match_capacity");
      if (candidates.length && store.identityEvidence) {
        try {
          const rows = await store.identityEvidence([...new Set(candidates.map(row => row.companyId))].slice(0, 40));
          const accountsById = new Map(accounts.map(account => [account.id, account]));
          candidates = candidates.map(candidate => confirmRegionalCandidate(candidate, accountsById.get(candidate.companyId)!, rows));
        } catch { result.identityLookupFailed++; /* Keep useful unverified candidates if evidence lookup is unavailable. */ }
      }
      await store.finish(lease, { offset: page.offset, version: page.version, complete: page.complete, scanned: page.rows.length, candidates });
      result.pages++; result.scanned += page.rows.length; result.candidates += candidates.length;
      result.confirmed += candidates.filter(candidate => candidate.identityEvidence).length;
      if (page.unchanged) result.unchanged++;
    } catch (error) {
      result.failed++;
      // Keep the previous exact offset/version on network, parse or storage failure.
      await store.finish(lease, { offset: lease.next_offset, version: lease.snapshot_version, complete: lease.snapshot_complete, scanned: 0, candidates: [],
        error: error instanceof Error && /^regional_[a-z_]+$/.test(error.message) ? error.message : "regional_source_unavailable" }).catch(() => {});
    }
  }
  return result;
}
