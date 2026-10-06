import { createHash } from "node:crypto";
import { stableRegistryJson } from "./registryProfiles";
import { registeredAgentOperatorInstant as instant } from "./registryRegisteredAgentOperator";
import { row, ordinaryQuote, type Row, type Quote, type FirmLicenseBridge } from "./registryFirmLicenseBridge";

type Review = { taskId: string; reviewedAt: string; receiptSha256: string };
export type RegisteredTradeSiteBridge = {
  schema: "reviewed_registered_trade_site_v1";
  canonicalName: string; tradeName: string;
  sourceInputSha256: string; primaryDecisionSha256: string; independentDecisionSha256: string;
  trade: Row; ownSite: FirmLicenseBridge["ownSite"];
  brandQuote: Quote & { role: "founder_brand" | "copyright_owner" };
  limitations: { association: "independently_reviewed_company_inference";
    addressEquivalenceClaimed: false; canonicalIdentityChanged: false; currentTradeControlClaimed: false;
    statutoryPersonIdentityVerified: false; currentOccupancyClaimed: false; literalDifferences: string[] };
};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const shape = (v: unknown, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const compact = (v: string) => v.replace(/\s+/g, " ").trim();
// Punctuation/case only. Legal-form and all substantive name tokens survive.
const legal = (v: unknown) => typeof v === "string" ? compact(v.replace(/[.,]/g, " ")).toLowerCase() : "";
function need(v: unknown, why: string): asserts v { if (!v) throw Error(`registered trade-site ${why}`); }
function ownUrl(value: string, domain: string) {
  const u = new URL(value);
  return value.length <= 2048 && u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash
    && u.hostname.toLowerCase().replace(/^www\./, "") === domain;
}
function civilDay(value: unknown) {
  need(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00\.000$/.test(value), "literal trade civil date differs");
  const day = value.slice(0, 10);
  need(new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day, "invalid trade civil date");
  return day;
}
function completeBrandQuote(page: RegisteredTradeSiteBridge["ownSite"], q: RegisteredTradeSiteBridge["brandQuote"], brand: string) {
  need(shape(q, ["role", "start", "end", "text", "ordinaryHtml"]), "brand quote shape differs");
  const { role, ...literal } = q;
  const text = ordinaryQuote(page, literal);
  // A complete ordinary element must say who uses the brand. A title, image
  // attribute, testimonial substring or bare word occurrence is insufficient.
  const element = /^<(div|p)\b[^<>]*>([\s\S]*)<\/\1>$/.exec(q.ordinaryHtml.html.trim());
  need(element, "whole ordinary brand element absent");
  const content = compact(element[2].replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:rsquo|#8217);/g, "’").replace(/&nbsp;/g, " "));
  need(content === text, "brand quote clips its whole element");
  if (role === "founder_brand") need(text === `Founder of ${brand}`, "literal founder brand differs");
  else {
    need(role === "copyright_owner", "unsupported brand role");
    const prefix = `© ${page.observedAt.slice(0, 4)} • ${brand} • All Rights Reserved`;
    const tail = text.slice(prefix.length);
    need(text.startsWith(prefix) && (tail === "" || /^ • Developed by [\p{L}\p{N} &'’.,-]{2,120}$/u.test(tail)), "literal copyright owner differs");
  }
  return text;
}
/** Only a compiled reviewed CO entry can call this branch. Government owner IDs
 * bind the alias to the original entity; the assigned own-domain claims that
 * complete alias in an explicit static role. Neither address nor person changes. */
export function verifyRegisteredTradeSite(args: { bridge: RegisteredTradeSiteBridge; source: Record<string, unknown>;
  companyName: string; aliases: string[]; domain: string; observedAt: string; sourceReader: Review; sourceReviewer: Review }) {
  const { bridge: b, source, companyName, aliases, domain, sourceReader, sourceReviewer } = args;
  need(shape(b, ["schema", "canonicalName", "tradeName", "sourceInputSha256", "primaryDecisionSha256", "independentDecisionSha256", "trade", "ownSite", "brandQuote", "limitations"])
    && b.schema === "reviewed_registered_trade_site_v1" && b.canonicalName === companyName
    && typeof b.tradeName === "string" && b.tradeName.length >= 5 && b.tradeName.length <= 200
    && [b.sourceInputSha256, b.primaryDecisionSha256, b.independentDecisionSha256].every(hash)
    && b.primaryDecisionSha256 === sourceReader.receiptSha256 && b.independentDecisionSha256 === sourceReviewer.receiptSha256,
  "reviewed input/actors differ");
  need(legal(companyName).length > 0 && legal(companyName) === legal(source.entityname)
    && aliases.every(name => legal(name) === legal(source.entityname)), "canonical full legal subject differs");
  const trade = row(b.trade, "/resource/u7sb-g482.json"), t = trade.raw;
  need(Object.values(t).every(v => typeof v === "string") && /^\d{11}$/.test(String(t.mastertradenameid))
    && /^\d{11}$/.test(String(source.entityid)) && t.entityid === source.entityid && t.tradenameform === "Entity Type"
    && ["firstname", "middlename", "lastname", "suffix"].every(k => t[k] === "")
    && legal(t.registrantorganization) === legal(source.entityname) && t.tradenamedescription === b.tradeName,
  "exact entity-owned trade differs");
  need(trade.keys.length === 4 && trade.keys.every(k => ["$where", "$select", "$order", "$limit"].includes(k))
    && trade.u.searchParams.get("$order") === "entityid,mastertradenameid" && trade.u.searchParams.get("$limit") === "10000", "trade query shape differs");
  const selected = (trade.u.searchParams.get("$select") ?? "").split(",");
  const ids = trade.u.searchParams.get("$where")?.match(/^entityid in\(('\d{11}'(?:,'\d{11}')*)\)$/)?.[1].split(",").map(x => x.slice(1, -1));
  need(ids && ids.length <= 1000 && new Set(ids).size === ids.length && ids.includes(String(source.entityid))
    && ["mastertradenameid", "tradenamedescription", "tradenameform", "registrantorganization", "entityid", "firstname", "middlename", "lastname", "suffix", "address1", "address2", "city", "state", "zipcode", "country", "effectivedate", "entitystatus", "entityformdate"].every(k => selected.includes(k))
    && selected.length === new Set(selected).size, "exact owner query fields differ");
  // The dated government declarations agree literally. This does not replace
  // or compare the different canonical/website street or unit.
  need(source.principalcountry === "US" && t.country === "US" && source.principalstate === "CO" && t.state === "CO"
    && t.entitystatus === "GOOD" && source.entitystatus === "Good Standing"
    && t.entityformdate === source.entityformdate
    && ["address1", "address2", "city", "state", "zipcode", "country"].every(k => (t[k] ?? "") === (source["principal" + k] ?? ""))
    && typeof t.address1 === "string" && t.address1.length > 0 && typeof t.city === "string" && t.city.length > 0
    && /^\d{5}$/.test(String(t.zipcode)), "dated official address/status differs");
  const day = civilDay(t.effectivedate), page = b.ownSite;
  need(shape(page, ["requestedUrl", "finalUrl", "status", "contentType", "observedAt", "hops", "htmlSha256", "textSha256", "receiptSha256", "text", "representation"])
    && page.status === 200 && /^text\/html(?:\s*;|$)/i.test(page.contentType) && page.representation === "complete_retained_static_text_v1"
    && typeof page.text === "string" && page.text.length > 0 && page.text.length <= 150000 && sha(page.text) === page.textSha256
    && [page.htmlSha256, page.textSha256, page.receiptSha256].every(hash)
    && ownUrl(page.requestedUrl, domain) && ownUrl(page.finalUrl, domain), "complete assigned-domain page differs");
  need(Array.isArray(page.hops) && page.hops.length >= 1 && page.hops.length <= 4
    && page.hops[0].url === page.requestedUrl && page.hops.at(-1)!.url === page.finalUrl
    && page.hops.every((h, i) => shape(h, ["url", "status"]) && ownUrl(h.url, domain)
      && (i === page.hops.length - 1 ? h.status === 200 : [301, 302, 303, 307, 308].includes(h.status))), "own-site hops differ");
  completeBrandQuote(page, b.brandQuote, b.tradeName);
  const mainTime = instant(args.observedAt), tradeTime = instant(b.trade.observedAt), pageTime = instant(page.observedAt);
  need(day <= b.trade.observedAt.slice(0, 10) && day <= page.observedAt.slice(0, 10)
    && mainTime <= tradeTime && tradeTime <= pageTime
    && [mainTime, tradeTime, pageTime].every(t => t <= instant(sourceReader.reviewedAt))
    && sourceReader.taskId !== sourceReviewer.taskId && instant(sourceReviewer.reviewedAt) >= instant(sourceReader.reviewedAt), "dated source chronology or independence differs");
  const l = b.limitations;
  need(shape(l, ["association", "addressEquivalenceClaimed", "canonicalIdentityChanged", "currentTradeControlClaimed", "statutoryPersonIdentityVerified", "currentOccupancyClaimed", "literalDifferences"])
    && l.association === "independently_reviewed_company_inference" && l.addressEquivalenceClaimed === false && l.canonicalIdentityChanged === false
    && l.currentTradeControlClaimed === false && l.statutoryPersonIdentityVerified === false && l.currentOccupancyClaimed === false
    && Array.isArray(l.literalDifferences) && l.literalDifferences.length > 0 && l.literalDifferences.length <= 12
    && l.literalDifferences.every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 1500), "inference limits differ");
  return { ...b, bridgeSha256: sha(stableRegistryJson(b)),
    scope: "Dated reviewed CO company association through the exact government entity-owned trade and explicit assigned-domain static brand claim. Original principal and different canonical/website addresses remain literal. No CEO, statutory person identity, address equivalence, current trade control, occupancy, scale or financial inference." };
}
