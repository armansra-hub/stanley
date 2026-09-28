import "server-only";
import { createHash } from "node:crypto";
import { OPERATING_CATALOG_VERSION } from "./operatingCatalog";
import type { CatalogSource } from "./operatingCoverage";

export type CustomerReferenceSource = {
  id: string; url: string; title: string; text: string; contentHash: string;
  observedAt: string; sourceKind?: "website";
  firstPartyLinkedFrom?: string | null;
};
export type CustomerReferenceSeed = {
  id: string; name: string; domain: string; website: string; announcementDate: string;
  announcementType: "new_customer" | "expansion" | "renewal" | "unknown";
  buyingProgramId?: string; comparisonIndustry?: string; identityNotes?: string[];
  sources: CustomerReferenceSource[];
};

export function customerReferenceCompany(seed: CustomerReferenceSeed) {
  // Customer relationship, announcement, sales notes and pattern expectations
  // never enter the public native request. The website must establish the facts.
  return { name: seed.name, domain: seed.domain };
}

export function customerReferenceEvidenceKey(seed: CustomerReferenceSeed): string {
  return createHash("sha256").update(JSON.stringify([
    OPERATING_CATALOG_VERSION, customerReferenceCompany(seed),
    seed.sources.map(source => ({ id: source.id, url: source.url, contentHash: source.contentHash })),
  ])).digest("hex");
}

export function customerReferenceCatalogSources(seed: CustomerReferenceSeed): CatalogSource[] {
  const ids = new Set<string>();
  return seed.sources.map(source => {
    const url = new URL(source.url);
    const domain = seed.domain.toLowerCase().replace(/^www\./, "");
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const ownHost = (value: string) => value === domain || value.endsWith("." + domain);
    // Some publishers host their official documents on a CDN. The captured
    // seed must retain the exact first-party page that visibly linked it.
    const linkedByOfficialPage = !!source.firstPartyLinkedFrom && seed.sources.some(parent => parent.url === source.firstPartyLinkedFrom
      && ownHost(new URL(parent.url).hostname.toLowerCase().replace(/^www\./, "")));
    if (url.protocol !== "https:" || (!ownHost(host) && !linkedByOfficialPage)
      || !source.text.trim() || ids.has(source.id)
      || createHash("sha256").update(source.text).digest("hex") !== source.contentHash
      || !Number.isFinite(Date.parse(source.observedAt))) throw new Error("invalid_customer_reference_source:" + seed.id + ":" + source.id);
    ids.add(source.id);
    return { id: source.id, source_url: source.url, title: source.title, source_kind: "website",
      event_date: null, observed_at: source.observedAt, evidence_text: source.text,
      content_hash: source.contentHash, metadata: { source_truncated: false } };
  });
}
