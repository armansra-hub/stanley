import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recordTrigger, recomputePriority } from "@/lib/db/triggers";

export interface Inc5000MatchInput {
  companyId: string;
  companyName: string;
  incName: string;
  profileUrl: string;
  incWebsite?: string | null;
  incCity?: string | null;
  incState?: string | null;
  rank?: number | null;
  growthPct?: number | null;
}

type TamCompany = {
  id: string;
  name: string;
  domain?: string | null;
  website_raw?: string | null;
  city?: string | null;
  state?: string | null;
};

const LEGAL_SUFFIX = /\b(the|and|co|company|corp|corporation|inc|incorporated|llc|ltd|limited|lp|llp|pllc|pc|group|holdings?)\b/g;

export function normalizeIncCompanyName(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

export function normalizeIncDomain(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").replace(/\.$/, "");
    return host || null;
  } catch {
    return raw.split("/")[0].replace(/^www\./, "").replace(/\.$/, "") || null;
  }
}

export function validateInc5000Match(company: TamCompany, row: Inc5000MatchInput): { ok: boolean; method?: string; reason?: string } {
  if (!/^https:\/\/(?:www\.)?inc\.com\/profile\/[a-z0-9-]+\/?(?:[?#].*)?$/i.test(row.profileUrl)) {
    return { ok: false, reason: "invalid_inc_profile_url" };
  }
  const tamDomain = normalizeIncDomain(company.domain ?? company.website_raw);
  const incDomain = normalizeIncDomain(row.incWebsite);
  if (tamDomain && incDomain && tamDomain === incDomain) return { ok: true, method: "official_website_domain" };

  const tamName = normalizeIncCompanyName(company.name);
  const incName = normalizeIncCompanyName(row.incName);
  if (!tamName || tamName !== incName) return { ok: false, reason: "name_or_domain_mismatch" };

  const stateMatches = Boolean(company.state && row.incState && company.state.trim().toLowerCase() === row.incState.trim().toLowerCase());
  const cityMatches = Boolean(company.city && row.incCity && normalizeIncCompanyName(company.city) === normalizeIncCompanyName(row.incCity));
  const nonGenericName = tamName.split(" ").length >= 2 && tamName.length >= 7;
  if (stateMatches || cityMatches) return { ok: true, method: "exact_name_and_location" };
  if (nonGenericName) return { ok: true, method: "unique_exact_name" };
  return { ok: false, reason: "generic_name_without_domain_or_location" };
}

function summary(row: Inc5000MatchInput): string {
  const details: string[] = [];
  if (Number.isFinite(Number(row.rank)) && Number(row.rank) > 0) details.push(`No. ${Number(row.rank).toLocaleString("en-US")}`);
  if (Number.isFinite(Number(row.growthPct)) && Number(row.growthPct) >= 0) details.push(`${Number(row.growthPct).toLocaleString("en-US", { maximumFractionDigits: 1 })}% 3-year growth`);
  return `Named to the 2026 Inc. 5000${details.length ? ` — ${details.join(" · ")}` : ""}.`;
}

export async function ingestInc5000Matches(rows: Inc5000MatchInput[]) {
  const db = serviceClient();
  const ids = [...new Set(rows.map((row) => row.companyId))];
  const { data, error } = await db.from("companies")
    .select("id,name,domain,website_raw,city,state")
    .in("id", ids).contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam");
  if (error) throw new Error(`TAM validation failed: ${error.message}`);
  const companies = new Map((data ?? []).map((company) => [String(company.id), company as TamCompany]));
  let inserted = 0, duplicates = 0, rejected = 0;
  const receipts: Array<{ companyId: string; status: string; method?: string; reason?: string }> = [];
  const touched = new Set<string>();
  for (const row of rows) {
    const company = companies.get(row.companyId);
    if (!company) { rejected++; receipts.push({ companyId: row.companyId, status: "rejected", reason: "not_current_netsuite_tam" }); continue; }
    const validation = validateInc5000Match(company, row);
    if (!validation.ok) { rejected++; receipts.push({ companyId: row.companyId, status: "rejected", reason: validation.reason }); continue; }
    const added = await recordTrigger(row.companyId, {
      type: "2026_inc_5000",
      summary: summary(row),
      source_name: "Inc. 5000",
      source_url: row.profileUrl,
      signal_date: "2026-08-12",
    });
    if (added) { inserted++; touched.add(row.companyId); }
    else duplicates++;
    receipts.push({ companyId: row.companyId, status: added ? "inserted" : "duplicate", method: validation.method });
  }
  for (const companyId of touched) await recomputePriority(companyId);
  return { received: rows.length, inserted, duplicates, rejected, companies: touched.size, receipts };
}
