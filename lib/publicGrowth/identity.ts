import type { GovernmentIdentityCandidate, IdentityDecision, TamIdentity } from "./types";

const LEGAL_SUFFIX = /\b(the|and|co|company|corp|corporation|inc|incorporated|llc|ltd|limited|lp|llp|pllc|pc|group|holdings?)\b/g;
const GENERIC = new Set(["advanced services", "business services", "complete care", "global services", "professional services", "quality services", "total solutions"]);

export function normalizeName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

export function normalizeDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    return host.replace(/^www\./, "").replace(/\.$/, "") || null;
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] || null;
  }
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase(), y = (b ?? "").trim().toLowerCase();
  return Boolean(x && y && x === y);
}

export function decideIdentityMatch(company: TamIdentity, candidate: GovernmentIdentityCandidate): IdentityDecision {
  const companyDomain = normalizeDomain(company.domain ?? company.website_raw);
  const candidateDomain = normalizeDomain(candidate.domain);
  const companyName = normalizeName(company.name);
  const names = [candidate.legalName, candidate.dbaName].map(normalizeName).filter(Boolean);
  const nameMatch = names.includes(companyName);
  const domainMatch = Boolean(companyDomain && candidateDomain && companyDomain === candidateDomain);
  const domainConflict = Boolean(companyDomain && candidateDomain && companyDomain !== candidateDomain);
  const stateMatch = sameText(company.state, candidate.state);
  const cityMatch = sameText(company.city, candidate.city);

  const evidence = { companyDomain, candidateDomain, companyName, candidateNames: names, nameMatch, stateMatch, cityMatch };
  if (domainMatch) return { status: "verified", method: "domain", confidence: nameMatch ? 1 : 0.97, evidence };
  if (domainConflict && nameMatch) return { status: "rejected", method: "conflict", confidence: 0.99, evidence };
  if (nameMatch && cityMatch && stateMatch) return { status: "verified", method: "exact_name_address", confidence: 0.96, evidence };
  if (nameMatch && stateMatch && companyName.length >= 8 && !GENERIC.has(companyName)) {
    return { status: "verified", method: "exact_name_state", confidence: 0.9, evidence };
  }
  if (nameMatch) return { status: "pending", method: "name_only", confidence: GENERIC.has(companyName) ? 0.35 : 0.65, evidence };
  return { status: "rejected", method: "none", confidence: 0, evidence };
}

