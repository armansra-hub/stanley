import "server-only";
import { pickSosCompaniesForRotation, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { fetchNewCoEntities, brandKey, lightNorm } from "@/lib/sources/coSos";

/**
 * Secretary-of-State NEW-ENTITY watch (FREE) — pilot state Colorado. For each CO
 * claimable company, look up recently-formed registry entities whose name carries
 * the company's brand but ISN'T its existing entity → that's a NEW subsidiary /
 * holdco / LLC = multi-entity consolidation, a strong NetSuite trigger. Boost-only;
 * never creates a company. Deduped by the entity's registry id (source_url).
 */
const LOOKBACK_DAYS = 150;

export async function sweepCoSos(limit = 200, opts: { offset?: number } = {}): Promise<{ checked: number; matched: number; triggered: number }> {
  const companies = await pickSosCompaniesForRotation("CO", limit, opts.offset ?? 0);
  const stats = { checked: companies.length, matched: 0, triggered: 0 };
  const sinceISO = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  const touched = new Set<string>();

  const BATCH = 6; // unauthenticated Socrata — keep concurrency modest
  for (let i = 0; i < companies.length; i += BATCH) {
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        const brand = brandKey(c.name); // distinctive ≥2-token brand, or null
        if (!brand) return;
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
      } catch { /* per-company isolated */ }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  return stats;
}
