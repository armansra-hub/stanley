import "server-only";

/**
 * Colorado Secretary of State business-entity registry (FREE — Socrata, no key;
 * optional SOCRATA_APP_TOKEN raises limits). Used to catch when a TAM company
 * spins up a NEW entity (subsidiary / new LLC / holdco) — a multi-entity
 * consolidation trigger, exactly NetSuite's sweet spot vs QuickBooks. We look up
 * RECENTLY-FORMED entities whose name carries the company's brand. CO is the pilot
 * state (clean open data); the same shape extends to other Socrata SoS feeds.
 */
const DATASET = "https://data.colorado.gov/resource/4ykn-tg5h.json";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

export interface SosEntity { name: string; id: string; formed: string; type: string; status: string; city: string }

// Light normalization for SoS matching: lowercase, drop punctuation + ONLY legal-form
// tokens. Crucially KEEPS "holdings/group/enterprises" so "Acme Holdings LLC" stays a
// detectable new holdco (the full normalizeCompanyName would strip those → false self-match).
const LEGAL = /\b(llc|l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|pc|the)\b/g;
export function lightNorm(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
}

// Every brand token is a common word → too generic to prefix-match safely.
const COMMON = new Set(["growth", "partners", "transaction", "transactions", "solutions", "services", "service", "action", "capital", "management", "group", "consulting", "advisors", "advisory", "ventures", "holdings", "global", "national", "american", "colorado", "associates", "professional", "professionals", "enterprises", "systems", "technologies", "industries", "resources"]);

/** Distinctive multi-word brand for a company, or null if too generic to match on. */
export function brandKey(name: string): { tokens: string[]; upper: string } | null {
  const toks = lightNorm(name).split(" ").filter(Boolean);
  if (toks.length < 2) return null; // single-token brands prefix-match too loosely → skip
  if (toks.every((t) => COMMON.has(t))) return null; // e.g. "growth partners"
  return { tokens: toks, upper: toks.join(" ").toUpperCase() };
}

/** Recently-formed CO entities whose name contains `coreUpper`. */
export async function fetchNewCoEntities(coreUpper: string, sinceISO: string, max = 10): Promise<SosEntity[]> {
  if (coreUpper.replace(/[^A-Z0-9]/g, "").length < 6) return []; // too short → skip
  const esc = coreUpper.replace(/'/g, "''");
  const where = `upper(entityname) like '%${esc}%' AND entityformdate > '${sinceISO}' AND entitystatus = 'Good Standing'`;
  const params = new URLSearchParams({
    $select: "entityname,entityid,entityformdate,entitytype,entitystatus,principalcity",
    $where: where, $order: "entityformdate DESC", $limit: String(max),
  });
  try {
    const res = await fetch(`${DATASET}?${params}`, { headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
    if (!res.ok) return [];
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map((r: Record<string, unknown>) => ({
      name: String(r.entityname ?? ""), id: String(r.entityid ?? ""), formed: String(r.entityformdate ?? ""),
      type: String(r.entitytype ?? ""), status: String(r.entitystatus ?? ""), city: String(r.principalcity ?? ""),
    }));
  } catch { return []; }
}
