import "server-only";
import { createHash } from "node:crypto";
import Parser from "rss-parser";
import { serviceClient } from "@/lib/supabase/server";
import { fetchPublicHttpText, validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { htmlToVisibleText, sitePageEvidence } from "@/lib/sources/siteDiscovery";
import { canonicalEvidenceUrl, enqueueObservation, intelligenceEnabled, type ObservationInput } from "./observations";
import { getSourceAttentionWeights } from "./feedback";

export type SharedSource = {
  id: string; name: string; url: string; enabled: boolean; format: string;
  scope: "agency" | "state_local" | "industry" | "company";
  states: string[]; cities: string[]; free_access: boolean; verified_at: string | null;
  verification_url: string; poll_minutes: number; next_fetch_at: string;
  lease_token?: string;
};
export type SharedAccount = { id: string; name: string; domain: string | null; netsuite_internal_id: string | null; state: string | null; city: string | null };
export type FeedPayload = { url: string; title: string; text: string; eventDate: string | null; bodyFetched?: boolean; sourceDates?: unknown[] };
export type SharedItem = { item_key: string; payload: FeedPayload };

const SUPPORTED = new Set(["rss", "atom"]);
const FAILURE_CODES = new Set(["source_not_rss_or_atom", "source_item_capacity_exceeded", "source_item_missing_identity", "source_fetch_failed",
  "shared_source_capacity_exceeded", "shared_source_storage_capacity_exceeded", "article_fetch_failed", "article_body_unavailable",
  "article_candidate_capacity_exceeded", "observation_not_persisted"]);
const failureCode = (error: unknown, fallback: string) => error instanceof Error && FAILURE_CODES.has(error.message) ? error.message : fallback;
const STATES: Record<string, string> = Object.fromEntries("Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY".split("|").map((pair) => { const [name, code] = pair.split(":"); return [name.toLowerCase(), code]; }));
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const stateCode = (value: string | null) => STATES[value?.trim().toLowerCase() ?? ""] ?? value?.trim().toUpperCase() ?? "";
const nameKey = (value: string) => normalize(value).replace(/(?:\s+(?:incorporated|corporation|company|limited|inc|corp|llc|ltd|llp))+$/, "");
const domainKey = (value: string | null) => {
  try { return validatePublicHttpUrl(value?.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
};

/** Source priority reflects actual current account locations, never assumed territory coverage. */
export function rankSharedSources(sources: SharedSource[], accounts: SharedAccount[]) {
  return sources.map((source) => {
    const states = new Set(source.states.map(stateCode));
    const cities = new Set(source.cities.map(normalize));
    const accountCount = accounts.filter((account) => (!states.size || states.has(stateCode(account.state))) &&
      (!cities.size || cities.has(normalize(account.city ?? "")))).length;
    const supported = source.free_access && SUPPORTED.has(source.format) && !!source.verified_at;
    return { source, accountCount, supported };
  }).sort((a, b) => Number(b.supported) - Number(a.supported) || b.accountCount - a.accountCount || a.source.id.localeCompare(b.source.id));
}

/** One oldest source always receives baseline capacity. Remaining capacity uses
 * account concentration with explicit recorded-feedback weights limited to ±10%. */
export function feedbackSourceOrder(ranked: ReturnType<typeof rankSharedSources>, weights: Record<string, number>) {
  const oldest = [...ranked].sort((a, b) => Date.parse(a.source.next_fetch_at) - Date.parse(b.source.next_fetch_at) || a.source.id.localeCompare(b.source.id));
  const baseline = oldest.shift();
  const weight = (id: string) => Number.isFinite(weights[id]) ? Math.max(.9, Math.min(1.1, weights[id])) : 1;
  oldest.sort((a, b) => Math.max(1, b.accountCount) * weight(b.source.id) - Math.max(1, a.accountCount) * weight(a.source.id)
    || Date.parse(a.source.next_fetch_at) - Date.parse(b.source.next_fetch_at) || a.source.id.localeCompare(b.source.id));
  return baseline ? [baseline, ...oldest] : [];
}

/** Build one token/domain index per invocation; each item inspects only indexed candidates. */
export function buildSharedAccountIndex(accounts: SharedAccount[]) {
  const frequencies = new Map<string, number>();
  const named = accounts.map((account) => ({ account, name: nameKey(account.name) }));
  for (const { name } of named) for (const token of new Set(name.split(" "))) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const anchors = new Map<string, typeof named>();
  const domains = new Map<string, SharedAccount[]>();
  for (const row of named) {
    const words = row.name.split(" ").filter(Boolean);
    // Short single names/acronyms need a domain, avoiding generic-word collisions.
    if (words.length >= 2 || (words[0]?.length ?? 0) >= 7) {
      const anchor = [...words].sort((a, b) => (frequencies.get(a)! - frequencies.get(b)!) || a.localeCompare(b))[0];
      anchors.set(anchor, [...(anchors.get(anchor) ?? []), row]);
    }
    const domain = domainKey(row.account.domain);
    if (domain) domains.set(domain, [...(domains.get(domain) ?? []), row.account]);
  }
  return (text: string) => {
    const hay = ` ${normalize(text)} `;
    const matches = new Map<string, { account: SharedAccount; basis: "exact_name" | "domain" }>();
    for (const token of new Set(hay.trim().split(" "))) {
      for (const row of anchors.get(token) ?? []) if (hay.includes(` ${row.name} `)) matches.set(row.account.id, { account: row.account, basis: "exact_name" });
    }
    for (const match of text.toLowerCase().matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/g)) {
      const host = match[0].replace(/^www\./, "");
      for (const account of domains.get(host) ?? []) matches.set(account.id, { account, basis: "domain" });
    }
    return [...matches.values()].sort((a, b) => Number(b.basis === "domain") - Number(a.basis === "domain") || a.account.id.localeCompare(b.account.id));
  };
}

const parser = new Parser({ timeout: 8_000 });
/** A malformed/non-feed response is an error, while a valid empty feed is successful. */
export async function parseSharedFeed(xml: string, sourceUrl: string): Promise<SharedItem[]> {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("source_not_rss_or_atom");
  const parsed = await parser.parseString(xml);
  if ((parsed.items?.length ?? 0) > 250) throw new Error("source_item_capacity_exceeded");
  const items = new Map<string, SharedItem>();
  for (const item of parsed.items ?? []) {
    if (!item.title?.trim() || !item.link) throw new Error("source_item_missing_identity");
    const url = canonicalEvidenceUrl(new URL(item.link, sourceUrl).toString());
    const title = htmlToVisibleText(item.title).slice(0, 500);
    const rawText = htmlToVisibleText(item["content:encoded"] ?? item.content ?? item.contentSnippet ?? item.summary ?? "");
    const rawDate = item.isoDate ?? item.pubDate;
    const eventDate = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
    const item_key = createHash("sha256").update(JSON.stringify([url, title, rawText, eventDate])).digest("hex");
    items.set(item_key, { item_key, payload: { url, title, text: rawText.slice(0, 4_000), eventDate } });
  }
  return [...items.values()];
}

export interface SharedSourceStore {
  enabled(): Promise<boolean>;
  sources(): Promise<SharedSource[]>;
  accounts(): Promise<SharedAccount[]>;
  attentionWeights?(): Promise<Record<string, number>>;
  claim(id: string): Promise<SharedSource | null>;
  snapshot(source: SharedSource, items: SharedItem[] | null, error: string | null): Promise<void>;
  pending(source: SharedSource, limit: number): Promise<SharedItem[]>;
  item(source: SharedSource, key: string, update: { payload?: FeedPayload; done?: boolean; error?: string }): Promise<void>;
  release(source: SharedSource, error: string | null): Promise<void>;
}

function databaseStore(): SharedSourceStore {
  const db = serviceClient();
  const check = (error: { code?: string; message?: string } | null) => {
    if (error) throw new Error(FAILURE_CODES.has(error.message ?? "") ? error.message : `shared_source_storage_${error.code ?? "error"}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { const { data, error } = await db.rpc(name, args); check(error); return data; };
  const leaseArgs = (source: SharedSource) => ({ p_source: source.id, p_lease: source.lease_token });
  return {
    async enabled() { const { data, error } = await db.from("intelligence_config").select("enabled").eq("id", 1).single(); check(error); return data?.enabled === true; },
    async sources() { const { data, error } = await db.from("intelligence_shared_sources").select("*").eq("enabled", true).order("id").limit(100); check(error); return data ?? []; },
    attentionWeights: getSourceAttentionWeights,
    async accounts() {
      const result: SharedAccount[] = [];
      // Keyset pages, minimum public account context only. Never load CRM notes.
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        let query = db.from("companies").select("id,name,domain,netsuite_internal_id,state,city").contains("lists", ["netsuite_tam"])
          .neq("status", "tam_duplicate").order("id").limit(1_000);
        if (cursor) query = query.gt("id", cursor);
        const { data, error } = await query; check(error);
        result.push(...(data ?? []));
        if ((data?.length ?? 0) < 1_000) return result;
        cursor = data![data!.length - 1].id;
      }
      throw new Error("shared_account_capacity_exceeded");
    },
    async claim(id) { return await rpc("intelligence_shared_claim", { p_source: id }); },
    async snapshot(source, items, error) { await rpc("intelligence_shared_snapshot", { ...leaseArgs(source), p_items: items, p_error: error }); },
    async pending(source, limit) {
      const { data, error } = await db.from("intelligence_shared_items").select("item_key,payload").eq("source_id", source.id)
        .eq("complete", false).lte("next_attempt_at", new Date().toISOString()).order("created_at").order("item_key").limit(limit);
      check(error); return data ?? [];
    },
    async item(source, key, update) { await rpc("intelligence_shared_item", { ...leaseArgs(source), p_key: key, p_payload: update.payload ?? null, p_done: update.done ?? false, p_error: update.error ?? null }); },
    async release(source, error) { await rpc("intelligence_shared_release", { ...leaseArgs(source), p_error: error }); },
  };
}

type Dependencies = { store?: SharedSourceStore; fetchText?: typeof fetchPublicHttpText; enqueue?: (input: ObservationInput) => ReturnType<typeof enqueueObservation>; now?: () => number };

export async function runSharedSources(deps: Dependencies = {}) {
  const result = { enabled: false, claimed: 0, fetched: 0, empty: 0, processed: 0, observations: 0, failed: 0, unmatched: 0 };
  if (!intelligenceEnabled()) return result;
  const store = deps.store ?? databaseStore();
  if (!await store.enabled()) return result;
  result.enabled = true;
  const sources = await store.sources();
  if (!sources.length) return result;
  const accounts = await store.accounts();
  const match = buildSharedAccountIndex(accounts);
  const weights = store.attentionWeights ? await store.attentionWeights() : {};
  const ranked = feedbackSourceOrder(rankSharedSources(sources, accounts).filter((entry) => entry.supported && entry.source.enabled), weights);
  const fetchText = deps.fetchText ?? fetchPublicHttpText;
  const enqueue = deps.enqueue ?? enqueueObservation;
  const now = deps.now ?? Date.now;
  const deadline = now() + 210_000;
  // The oldest source retains a baseline slot independent of feedback.
  for (const entry of ranked) {
    if (result.claimed >= 3 || now() >= deadline) break;
    const source = await store.claim(entry.source.id);
    if (!source) continue;
    result.claimed++;
    let sourceError: string | null = null;
    try {
      if (Date.parse(source.next_fetch_at) <= now()) {
        try {
          const response = await fetchText(source.url, { timeoutMs: 8_000, maxBytes: 2_000_000, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" });
          if (response.status < 200 || response.status >= 300) throw new Error("source_fetch_failed");
          const items = await parseSharedFeed(response.body, source.url);
          await store.snapshot(source, items, null);
          result.fetched++;
          if (!items.length) result.empty++;
        } catch (error) {
          sourceError = failureCode(error, "feed_fetch_or_persistence_failed");
          await store.snapshot(source, null, sourceError);
          result.failed++;
        }
      }
      for (const item of await store.pending(source, 20)) {
        if (now() >= deadline) break;
        try {
          let payload = item.payload;
          // Feed excerpts are sometimes just a headline. Fetch each item once, then cache the body
          // before matching so companies mentioned deeper in the announcement remain discoverable.
          if (!payload.bodyFetched) {
            const response = await fetchText(payload.url, { timeoutMs: 5_000, maxBytes: 1_000_000 });
            if (response.status < 200 || response.status >= 300) throw new Error("article_fetch_failed");
            const evidence = sitePageEvidence(response.body, response.finalUrl);
            if (evidence.text.length < 160) throw new Error("article_body_unavailable");
            payload = { ...payload, text: evidence.text, bodyFetched: true, sourceDates: evidence.sourceDates };
            await store.item(source, item.item_key, { payload });
          }
          const candidates = match(`${payload.title}\n${payload.text}`);
          // Never silently truncate a many-account roundup: retain it for review/retry.
          if (candidates.length > 8) throw new Error("article_candidate_capacity_exceeded");
          for (const candidate of candidates) {
            const observation = await enqueue({ companyId: candidate.account.id, companyName: candidate.account.name, companyDomain: candidate.account.domain,
              netsuiteInternalId: candidate.account.netsuite_internal_id, sourceKind: "news", sourceUrl: payload.url, title: payload.title, text: payload.text,
              eventDate: payload.eventDate, metadata: { sharedSourceId: source.id, sharedSourceName: source.name, sharedFeedUrl: source.url,
                sourceScope: source.scope, sourceRole: "announcement_context", candidateMatch: candidate.basis, identityVerified: false,
                governmentAwardVerified: false, sourceDates: payload.sourceDates ?? [], dateKind: "feed_publication", verificationUrl: source.verification_url } });
            if (!observation) throw new Error("observation_not_persisted");
            result.observations++;
          }
          await store.item(source, item.item_key, { done: true });
          result.processed++;
          if (!candidates.length) result.unmatched++;
        } catch (error) {
          sourceError = failureCode(error, "article_or_observation_pending");
          result.failed++;
          await store.item(source, item.item_key, { error: sourceError });
        }
      }
    } finally {
      await store.release(source, sourceError);
    }
  }
  return result;
}
