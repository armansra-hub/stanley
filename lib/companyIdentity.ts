import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export type IdentityAddress = {
  addressLine1: string; city?: string; state?: string; postalCode?: string; countryCode?: string;
  sourceKind: "netsuite_record" | "company_website"; sourceUrl?: string; sourceId: string; capturedAt: string;
};
type Company = { id: string; name: string; domain?: string | null; website_raw?: string | null; city?: string | null; state?: string | null; netsuite_internal_id?: string | null };
export type CompanyIdentityContext = { aliases: string[]; addresses: IdentityAddress[]; context: string };
type SourceContext = {
  record?: { id: string; header: string; capturedAt: string } | null;
  websites?: { id: string; url: string; capturedAt: string; identity: unknown }[];
  claims?: { id: string; name: string; subjectName: string; relationship: string; sourceUrl: string; capturedAt: string }[];
};
const clean = (value: unknown, limit = 180): string | undefined => typeof value === "string" && value.trim() && value.length <= limit
  ? value.replace(/\s+/g, " ").trim() : undefined;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identityName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/(?:\s+(?:inc|incorporated|llc|ltd|limited|corp|corporation|llp|pllc|pc))+$/, "").trim();
function host(value?: string | null): string | null {
  try { const url = new URL(value?.includes("://") ? value : `https://${value ?? ""}`); return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase().replace(/^www\./, "") : null; }
  catch { return null; }
}
export function isCompanyIdentitySource(url: string, domain?: string | null): boolean {
  const source = host(url), target = host(domain);
  return Boolean(source && target && (source === target || source.endsWith(`.${target}`)));
}

/** Read only the labelled business-address block, never addresses in activities,
 * event invitations, signatures, contacts, or arbitrary CRM notes. */
export function parseNetSuiteIdentityHeader(header: string, source: { id: string; capturedAt: string }) {
  const lines = header.slice(0, 6000).replace(/\r/g, "").replace(/\u00a0/g, " ").split("\n").map(line => line.trim());
  const boundary = lines.findIndex(line => /^(Firmographic Information|Lead Qualification|Research Notes|Comments|View\s+Touch Type)\b/.test(line));
  const account = boundary < 0 ? lines : lines.slice(0, boundary);
  const index = account.findIndex(line => /^Address(?:\s|$)/.test(line));
  if (index < 0) return { aliases: [] as string[], addresses: [] as IdentityAddress[] };
  const block = [account[index].replace(/^Address\s*/, "")];
  for (const line of account.slice(index + 1, index + 8)) {
    if (!line || /^(Primary Currency|Relationship with Oracle|Firmographic Information)\b/.test(line)) break;
    block.push(line);
  }
  const streetIndex = block.findIndex(line => /^(?:\d+[A-Z]?(?:[-/]\d+)?\s|P\.?\s*O\.?\s+Box\s+\d)/i.test(line));
  if (streetIndex < 0) return { aliases: [] as string[], addresses: [] as IdentityAddress[] };
  const locationIndex = block.findIndex((line, i) => i > streetIndex && /^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:[- ]?\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i.test(line));
  if (locationIndex < 0) return { aliases: [] as string[], addresses: [] as IdentityAddress[] };
  const location = block[locationIndex].match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:[- ]?\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i)!;
  const country = block[locationIndex + 1]?.trim();
  const countryCode = /^(United States(?: of America)?|USA?|U\.S\.?A?\.?)$/i.test(country ?? "") ? "US" : /^(Canada|CA)$/i.test(country ?? "") ? "CA" : undefined;
  const addressLine1 = clean(block.slice(streetIndex, locationIndex).join(" "));
  if (!addressLine1 || !countryCode) return { aliases: [] as string[], addresses: [] as IdentityAddress[] };
  const label = clean(block.slice(0, streetIndex).join(" "));
  const aliases = label && /\b(?:inc\.?|incorporated|llc|ltd\.?|limited|corp\.?|corporation|llp|pllc|pc)\.?$/i.test(label) ? [label] : [];
  return { aliases, addresses: [{ addressLine1, city: location[1], state: location[2].toUpperCase(), postalCode: location[3], countryCode,
    sourceKind: "netsuite_record" as const, sourceId: source.id, capturedAt: source.capturedAt }] };
}

export function buildCompanyIdentityContext(company: Company, sources: SourceContext): CompanyIdentityContext {
  const record = sources.record && typeof sources.record.header === "string" ? parseNetSuiteIdentityHeader(sources.record.header, sources.record) : { aliases: [], addresses: [] };
  const aliases: string[] = [...record.aliases], addresses: IdentityAddress[] = [...record.addresses];
  const anchored = [company.name, ...record.aliases].map(identityName);
  for (const claim of (sources.claims ?? []).slice(0, 20)) {
    if (!["legal_name", "dba", "former_name"].includes(claim.relationship) || !clean(claim.name)
      || !anchored.includes(identityName(claim.subjectName)) || !isCompanyIdentitySource(claim.sourceUrl, company.domain || company.website_raw)) continue;
    aliases.push(claim.name);
  }
  for (const source of (sources.websites ?? []).slice(0, 8)) {
    if (!isCompanyIdentitySource(source.url, company.domain || company.website_raw)) continue;
    const identity = object(source.identity);
    // A site can describe several legal entities. Its schema names do not create
    // new legal aliases for federal matching; an address must name this company
    // or the company addressee already sourced from its exact CRM record.
    const targetNames = [company.name, ...aliases].map(identityName);
    if (!Array.isArray(identity.names) || !identity.names.some(name => typeof name === "string" && targetNames.includes(identityName(name)))) continue;
    for (const raw of Array.isArray(identity.addresses) ? identity.addresses.slice(0, 4) : []) {
      const address = object(raw), addressLine1 = clean(address.addressLine1);
      if (!addressLine1) continue;
      addresses.push({ addressLine1, city: clean(address.city), state: clean(address.state), postalCode: clean(address.postalCode, 20),
        countryCode: clean(address.countryCode, 40), sourceKind: "company_website", sourceUrl: source.url, sourceId: source.id, capturedAt: source.capturedAt });
    }
  }
  const uniqueAddresses = addresses.filter((address, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(address)) === i).slice(0, 8);
  const retainedAliases = [...new Set(aliases)].slice(0, 8);
  const contextData = { purpose: "Account identity only; not evidence that an event happened. Business-address fields from the authorized NetSuite record and same-company website. Dates show when captured; branches and relocations are possible. A shared name, domain or address alone does not establish the same contracting entity. Missing values remain unknown.",
    companyName: company.name, companyDomain: company.domain || company.website_raw || null, knownCity: company.city ?? null, knownState: company.state ?? null,
    aliases: retainedAliases, addresses: [...uniqueAddresses] };
  while (Buffer.byteLength(JSON.stringify(contextData), "utf8") > 3600 && contextData.addresses.length) contextData.addresses.pop();
  const context = JSON.stringify(contextData);
  return { aliases: retainedAliases, addresses: uniqueAddresses, context };
}

/** SQL returns at most one 6k account header and eight small public identity
 * objects, rather than transferring or indexing the full private record. */
export async function loadCompanyIdentityContext(company: Company): Promise<CompanyIdentityContext> {
  const { data, error } = await serviceClient().rpc("company_identity_source_context", { p_company_id: company.id });
  if (error) throw new Error("company_identity_context_unavailable");
  return buildCompanyIdentityContext(company, object(data) as SourceContext);
}

export async function enrichCompanyIdentity<T extends Company>(company: T): Promise<T & { legalNames: string[]; addresses: IdentityAddress[] }> {
  try {
    const identity = await loadCompanyIdentityContext(company);
    return { ...company, legalNames: identity.aliases, addresses: identity.addresses };
  } catch {
    // Missing identity context cannot strengthen a candidate match. Name/domain
    // and any previously verified source identifiers remain independently usable.
    return { ...company, legalNames: [], addresses: [] };
  }
}
