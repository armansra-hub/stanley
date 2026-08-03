import "server-only";
import { fetchJson } from "./http";
import { normalizeDomain } from "./identity";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ENTITY_API = "https://api.sam.gov/entity-information/v4/entities";
const OPPORTUNITIES_API = "https://api.sam.gov/opportunities/v2/search";

function apiKey(): string {
  const value = process.env.SAM_API_KEY ?? process.env.SAM_GOV_API_KEY;
  if (!value) throw new Error("SAM_API_KEY is not configured");
  return value;
}

export async function searchSamEntities(query: { uei?: string; legalBusinessName?: string }): Promise<any[]> {
  const params = new URLSearchParams({ api_key: apiKey(), includeSections: "entityRegistration,coreData,assertions,repsAndCerts", size: "10" });
  if (query.uei) params.set("ueiSAM", query.uei);
  else if (query.legalBusinessName) params.set("legalBusinessName", query.legalBusinessName);
  const data = await fetchJson<any>(`${ENTITY_API}?${params.toString()}`, {}, 25_000);
  return data.entityData ?? [];
}

export function compactSamEntity(row: any) {
  const reg = row.entityRegistration ?? {}, core = row.coreData ?? {}, info = core.entityInformation ?? {};
  const address = core.physicalAddress ?? {}, goods = row.assertions?.goodsAndServices ?? {};
  const naics = Array.isArray(goods.naicsList) ? goods.naicsList : [];
  const psc = Array.isArray(goods.pscList) ? goods.pscList : [];
  return {
    uei: reg.ueiSAM ?? null, cageCode: reg.cageCode ?? null, legalName: reg.legalBusinessName ?? "", dbaName: reg.dbaName ?? core.generalInformation?.entityDivisionName ?? info.entityDivisionName ?? null,
    registrationStatus: reg.registrationStatus ?? null, registrationDate: reg.registrationDate ?? reg.activationDate ?? null,
    expirationDate: reg.registrationExpirationDate ?? reg.expirationDate ?? null, entityStartDate: info.entityStartDate ?? null,
    website: info.entityURL ?? null, domain: normalizeDomain(info.entityURL), address: address.addressLine1 ?? null,
    city: address.city ?? null, state: address.stateOrProvinceCode ?? null, postalCode: address.zipCode ?? null, countryCode: address.countryCode ?? null,
    parentUei: core.entityHierarchyInformation?.immediateParentEntity?.ueiSAM ?? core.entityHierarchyInformation?.ultimateParentEntity?.ueiSAM ?? null,
    parentName: core.entityHierarchyInformation?.immediateParentEntity?.legalBusinessName ?? core.entityHierarchyInformation?.ultimateParentEntity?.legalBusinessName ?? null,
    lastUpdateDate: reg.lastUpdateDate ?? reg.updatedDate ?? info.submissionDate ?? null,
    naics: naics.map((n: any) => ({ code: String(n.naicsCode ?? ""), name: n.naicsName ?? n.naicsDescription ?? null, isPrimary: /^(y|yes|true|1)$/i.test(String(n.isPrimary ?? "")), isSmallBusiness: n.isSmallBusiness ?? n.sbaSmallBusiness, hasSizeChanged: /^(y|yes|true|1)$/i.test(String(n.hasSizeChanged ?? "")), hasSbaProtest: /^(y|yes|true|1)$/i.test(String(n.hasSBAProtest ?? "")), exceptionCounter: String(n.exceptionCounter ?? n.naicsException ?? "") })).filter((n: any) => n.code),
    psc: psc.map((p: any) => String(p.pscCode ?? p.code ?? p)).filter(Boolean),
    businessTypes: core.businessTypes ?? row.assertions?.businessTypes ?? row.repsAndCerts?.certifications ?? [],
  };
}

export function sbaProfileUrl(uei: string | null, cageCode: string | null): string {
  if (uei && cageCode) return `https://search.certifications.sba.gov/profile/${encodeURIComponent(uei)}/${encodeURIComponent(cageCode)}`;
  return "https://search.certifications.sba.gov/advanced";
}

const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;

export async function searchSamOpportunities(args: { postedFrom: Date; postedTo: Date; offset?: number; limit?: number; ptype?: string[] }) {
  const params = new URLSearchParams({ api_key: apiKey(), postedFrom: mmddyyyy(args.postedFrom), postedTo: mmddyyyy(args.postedTo), offset: String(args.offset ?? 0), limit: String(Math.min(1000, args.limit ?? 1000)) });
  for (const ptype of args.ptype ?? ["a", "p", "o", "k", "r"]) params.append("ptype", ptype);
  const data = await fetchJson<any>(`${OPPORTUNITIES_API}?${params.toString()}`, {}, 30_000);
  return { total: Number(data.totalRecords ?? 0), rows: (data.opportunitiesData ?? []).map(compactSamOpportunity) };
}

export function compactSamOpportunity(row: any) {
  const data = row.data ?? row, award = data.award ?? {}, awardee = award.awardee ?? {};
  const path = String(row.fullParentPathName ?? data.fullParentPathName ?? "").split(".").map((x) => x.trim()).filter(Boolean);
  const noticeId = String(row.noticeId ?? data.noticeId ?? "");
  return {
    noticeId, solicitationNumber: row.solicitationNumber ?? data.solicitationNumber ?? null,
    awardNumber: award.number ?? null, noticeType: row.type ?? data.type ?? null,
    status: String(row.active ?? data.active ?? "").toLowerCase() === "yes" ? "active" : "archived",
    title: String(row.title ?? data.title ?? "Untitled opportunity"), description: typeof row.description === "string" ? row.description : null,
    agency: path[0] ?? row.department ?? data.department ?? null, subagency: path[1] ?? row.subTier ?? data.subTier ?? null,
    office: path.at(-1) ?? row.office ?? data.office ?? null, naicsCode: row.naicsCode ?? data.naicsCode ?? null,
    pscCode: row.classificationCode ?? data.classificationCode ?? null, setAside: row.typeOfSetAsideDescription ?? row.setAside ?? data.setAside ?? null,
    postedDate: String(row.postedDate ?? data.postedDate ?? "").slice(0, 10) || null,
    responseDeadline: row.responseDeadLine ?? data.responseDeadLine ?? null, archiveDate: String(row.archiveDate ?? data.archiveDate ?? "").slice(0, 10) || null,
    placeOfPerformance: row.placeOfPerformance ?? data.placeOfPerformance ?? {}, awardeeName: awardee.name ?? null,
    awardeeUei: awardee.ueiSAM ?? null, awardAmount: award.amount == null ? null : Number(award.amount),
    sourceUrl: row.uiLink ?? data.uiLink ?? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`, evidence: row,
  };
}
