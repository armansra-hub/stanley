import "server-only";
import { pickSosCompaniesForRotation, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { fetchNewCoEntities, fetchRecentUccFilings, brandKey, lightNorm } from "@/lib/sources/coSos";

/**
 * Colorado state-registry watch (FREE) over the whole CO base (claimable first), two
 * signals per company in one pass:
 *  1) NEW ENTITY — a recently-formed SoS entity that LEADS with the company's brand
 *     and adds a qualifier → new subsidiary/holdco = multi-entity consolidation.
 *  2) UCC FINANCING — a new UCC-1 financing statement with the company as debtor →
 *     took secured debt (equipment/LOC) = growth investment + asset accounting.
 * Boost-only; never creates a company. Deduped by registry id / filing date.
 */
const LOOKBACK_DAYS = 150;
const UCC_LOOKBACK_DAYS = 365;

export async function sweepCoSos(limit = 200, opts: { offset?: number } = {}): Promise<{ checked: number; matched: number; triggered: number; ucc: number }> {
  const companies = await pickSosCompaniesForRotation("CO", limit, opts.offset ?? 0);
  const stats = { checked: 0, matched: 0, triggered: 0, ucc: 0 };
  const sinceISO = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  const uccSinceISO = new Date(Date.now() - UCC_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  const touched = new Set<string>();

  // Time-boxed; unauthenticated Socrata → modest concurrency.
  const deadline = Date.now() + 48_000;
  const BATCH = 6;
  for (let i = 0; i < companies.length; i += BATCH) {
    if (Date.now() > deadline) break;
    const slice = companies.slice(i, i + BATCH);
    stats.checked += slice.length;
    await Promise.all(slice.map(async (c) => {
      try {
        const brand = brandKey(c.name); // distinctive ≥2-token brand, or null
        if (!brand) return;

        // 1) new-entity (subsidiary/holdco) watch
        const ents = await fetchNewCoEntities(brand.upper, sinceISO);
        for (const e of ents) {
          const enToks = lightNorm(e.name).split(" ").filter(Boolean);
          // NEW subsidiary pattern: entity name LEADS with the full brand token
          // sequence (token-boundary prefix) AND adds ≥1 qualifier ("West", "Holdings",
          // "II", "Logistics"…). Excludes the company's own re-registration.
          const isPrefix = brand.tokens.every((t, idx) => enToks[idx] === t);
          if (!isPrefix || enToks.length <= brand.tokens.length) continue;
          stats.matched++;
          const url = `https://www.sos.state.co.us/biz/BusinessEntityDetail.do?masterFileId=${e.id}&entityId2=${e.id}`;
          if (await recordTrigger(c.id, {
            type: "new_entity",
            summary: `New CO entity "${e.name}" (${e.type}) formed ${e.formed.slice(0, 10)}${e.city ? `, ${e.city}` : ""} — likely a new subsidiary/holdco (multi-entity consolidation)`,
            source_name: "CO Secretary of State", source_url: url, signal_date: e.formed.slice(0, 19) || new Date().toISOString(),
          })) { stats.triggered++; touched.add(c.id); }
        }

        // 2) UCC financing-statement watch (debtor = this company, exact-normalized)
        for (const f of await fetchRecentUccFilings(c.name, uccSinceISO)) {
          const day = f.filed.slice(0, 10);
          if (await recordTrigger(c.id, {
            type: "ucc_financing",
            summary: `New UCC financing statement filed ${day} (CO) — took secured financing (equipment/line of credit) = growth investment`,
            source_name: "CO Secretary of State (UCC)",
            source_url: `https://data.colorado.gov/resource/wffy-3uut.json#${encodeURIComponent(lightNorm(c.name))}-${day}`,
            signal_date: f.filed.slice(0, 19) || new Date().toISOString(),
          })) { stats.ucc++; touched.add(c.id); }
        }
      } catch { /* per-company isolated */ }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  return stats;
}
