import { createHash } from "node:crypto";
import { stableRegistryJson } from "./registryProfiles";
import { registeredAgentOperatorInstant as instant } from "./registryRegisteredAgentOperator";

type Review = { taskId: string; reviewedAt: string; receiptSha256: string };
export type Row = { requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
  responseSha256: string; receiptSha256: string; rawRow: string; rawRowSha256: string;
  arrayIndex: number; byteOffset: number; byteLength: number; matchedRows: number };
export type Quote = { start: number; end: number; text: string;
  ordinaryHtml: { start: number; end: number; html: string; sha256: string } };
export type FirmLicenseBridge = {
  schema: "reviewed_colorado_firm_license_v1"; canonicalName: string; licenseToken: string;
  sourceInputSha256: string; primaryDecisionSha256: string; independentDecisionSha256: string;
  license: Row; trade: Row;
  ownSite: { requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
    hops: { url: string; status: number }[]; htmlSha256: string; textSha256: string; receiptSha256: string;
    text: string; representation: "complete_retained_static_text_v1" };
  companyQuote: Quote; licenseQuote: Quote;
  limitations: { association: "independently_reviewed_company_inference"; addressEquivalenceClaimed: false;
    canonicalIdentityChanged: false; currentLicenseClaimed: false; individualOwnershipClaimed: false;
    financialOrDisciplinaryInference: false; literalDifferences: string[] };
};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const shape = (v: unknown, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const compact = (v: string) => v.replace(/\s+/g, " ").trim();
// Only case, commas, periods and whitespace differ. No suffix deletion, token
// similarity, personal-name inference or address normalization participates.
const legal = (v: unknown) => typeof v === "string" ? compact(v.replace(/[.,]/g, " ")).toLowerCase() : "";
const exactWords = (v: unknown) => typeof v === "string" ? compact(v).toLowerCase() : "";
function need(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(`firm license ${why}`); }
function url(value: string, host: string, path?: string) {
  const u = new URL(value);
  need(u.protocol === "https:" && u.hostname === host && !u.username && !u.password && !u.port && !u.hash
    && value.length <= 16000 && (!path || u.pathname === path), "source URL differs");
  return u;
}
export function row(s: Row, path: string) {
  need(shape(s, ["requestedUrl", "finalUrl", "status", "contentType", "observedAt", "responseSha256", "receiptSha256",
    "rawRow", "rawRowSha256", "arrayIndex", "byteOffset", "byteLength", "matchedRows"])
    && s.requestedUrl === s.finalUrl && s.status === 200 && /^application\/json(?:\s*;|$)/i.test(s.contentType)
    && [s.responseSha256, s.receiptSha256, s.rawRowSha256].every(hash) && s.rawRow.length <= 16000
    && sha(s.rawRow) === s.rawRowSha256 && Number.isSafeInteger(s.arrayIndex) && s.arrayIndex >= 0
    && Number.isSafeInteger(s.byteOffset) && s.byteOffset >= 0 && s.byteLength === Buffer.byteLength(s.rawRow)
    && s.matchedRows === 1, "exact unique retained row differs");
  const u = url(s.requestedUrl, "data.colorado.gov", path), keys = [...u.searchParams.keys()];
  need(new Set(keys).size === keys.length, "duplicate query key");
  const raw: unknown = JSON.parse(s.rawRow); need(object(raw), "row object absent");
  return { u, raw, keys };
}
export function ordinaryQuote(page: FirmLicenseBridge["ownSite"], q: Quote) {
  need(shape(q, ["start", "end", "text", "ordinaryHtml"]) && typeof q.text === "string" && q.text.length > 0 && q.text.length <= 2000
    && Number.isSafeInteger(q.start) && q.start >= 0 && q.end === q.start + q.text.length && page.text.slice(q.start, q.end) === q.text,
  "literal page quote differs");
  const h = q.ordinaryHtml;
  need(shape(h, ["start", "end", "html", "sha256"]) && Number.isSafeInteger(h.start) && h.start >= 0
    && typeof h.html === "string" && h.html.length > 0 && h.html.length <= 8000 && h.end === h.start + h.html.length
    && hash(h.sha256) && sha(h.html) === h.sha256
    && !/<!--|<\/?(?:script|style|template|noscript|svg|math|textarea|title|iframe|xmp|plaintext)\b/i.test(h.html)
    && !/\b(?:aria-hidden|on\w+)\s*=/i.test(h.html) && !/<[^>]*\s+(?:hidden|inert)(?=\s|=|\/?>)/i.test(h.html), "ordinary HTML differs");
  // Preserve complete literal paragraphs. Normal weight is the sole style
  // allowed here; no visibility, layout, CSS entity or arbitrary typography.
  const markers = [...h.html.matchAll(/\bstyle\s*=/gi)];
  const styles = [...h.html.matchAll(/\sstyle\s*=\s*(?:"\s*font-weight\s*:\s*(?:400|normal)\s*;?\s*"|'\s*font-weight\s*:\s*(?:400|normal)\s*;?\s*')/gi)];
  const tags = [...h.html.matchAll(/<[^>]*>/g)];
  need(markers.length === styles.length && styles.every(a => tags.some(t => a.index > t.index && a.index + a[0].length < t.index + t[0].length))
    && tags.every(t => [...t[0].matchAll(/\bstyle\s*=/gi)].length <= 1), "unsupported or ambiguous style");
  const text = h.html.replace(/<\/?(?:div|section|article|h[1-6]|p|span|strong|em|b|i|a|br)\b(?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*\/?\s*>/gi, " ");
  need(!/[<>]/.test(text), "nonordinary markup");
  const decoded = text.replace(/&amp;/g, "&").replace(/&(?:apos|#39);/g, "'").replace(/&(?:rsquo|#8217);/g, "’").replace(/&nbsp;/g, " ");
  need(compact(decoded).includes(compact(q.text)) && !/\b(not|unrelated|formerly|previously|former|customer|client|partner|affiliate|subsidiary|parent|example|fictional)\b/i.test(q.text),
    "quote attribution differs");
  return compact(q.text);
}
/** Opt-in compiled data only. The local consumer verifies original raw response
 * slices, complete page/capture bytes and the genuine paired source receipts. */
export function verifyFirmLicenseBridge(args: { bridge: FirmLicenseBridge; source: Record<string, unknown>; domain: string;
  companyName: string; sourceReader: Review; sourceReviewer: Review }) {
  const { bridge: b, source, domain, companyName, sourceReader, sourceReviewer } = args;
  need(shape(b, ["schema", "canonicalName", "licenseToken", "sourceInputSha256", "primaryDecisionSha256", "independentDecisionSha256",
    "license", "trade", "ownSite", "companyQuote", "licenseQuote", "limitations"])
    && b.schema === "reviewed_colorado_firm_license_v1" && b.canonicalName === companyName && companyName.trim().length > 0
    && [b.sourceInputSha256, b.primaryDecisionSha256, b.independentDecisionSha256].every(hash)
    && b.primaryDecisionSha256 === sourceReader.receiptSha256 && b.independentDecisionSha256 === sourceReviewer.receiptSha256,
  "reviewed input or source witness binding differs");
  const lic = row(b.license, "/resource/7s5z-vewr.json"), trade = row(b.trade, "/resource/u7sb-g482.json"), l = lic.raw, t = trade.raw;
  need(Object.values(l).every(v => typeof v === "string" || object(v) && shape(v, ["url"]) && typeof v.url === "string")
    && l.licensetype === "FRM" && typeof l.licensenumber === "string" && /^[1-9]\d{0,8}$/.test(l.licensenumber)
    && b.licenseToken === `FRM.${l.licensenumber}` && lic.keys.length === 2 && lic.keys.includes("$where") && lic.keys.includes("$limit")
    && lic.u.searchParams.get("$where") === `licensetype='FRM' AND licensenumber='${l.licensenumber}'`
    && /^[1-9]$|^10$/.test(lic.u.searchParams.get("$limit") ?? ""), "license type, token or exact query differs");
  need(Object.values(t).every(v => typeof v === "string") && /^\d{11}$/.test(String(t.mastertradenameid))
    && t.entityid === source.entityid && /^\d{11}$/.test(String(source.entityid)) && t.tradenameform === "Entity Type"
    && legal(t.registrantorganization) === legal(source.entityname) && legal(l.entityname) === legal(source.entityname)
    && legal(source.entityname).length > 0 && exactWords(t.tradenamedescription) === exactWords(companyName), "exact license legal name or trade owner differs");
  need(trade.keys.length === 4 && trade.keys.every(k => ["$where", "$select", "$order", "$limit"].includes(k))
    && trade.u.searchParams.get("$order") === "entityid,mastertradenameid" && trade.u.searchParams.get("$limit") === "10000",
  "trade query shape differs");
  const selected = (trade.u.searchParams.get("$select") ?? "").split(",");
  const ids = trade.u.searchParams.get("$where")?.match(/^entityid in\(('\d{11}'(?:,'\d{11}')*)\)$/)?.[1].split(",").map(x => x.slice(1, -1));
  need(ids && ids.length <= 1000 && new Set(ids).size === ids.length && ids.includes(String(source.entityid))
    && ["mastertradenameid", "tradenamedescription", "registrantorganization", "entityid", "city", "state", "zipcode", "country"].every(k => selected.includes(k))
    && selected.length === new Set(selected).size, "exact trade owner query differs");
  need(l.state === "CO" && source.principalstate === "CO" && t.state === "CO" && source.principalcountry === "US" && t.country === "US"
    && exactWords(l.city).length > 0 && exactWords(l.city) === exactWords(source.principalcity) && exactWords(t.city) === exactWords(l.city)
    && /^\d{5}$/.test(String(l.mailzipcode)) && l.mailzipcode === source.principalzipcode && t.zipcode === l.mailzipcode, "legal locality differs");
  const page = b.ownSite;
  need(shape(page, ["requestedUrl", "finalUrl", "status", "contentType", "observedAt", "hops", "htmlSha256", "textSha256", "receiptSha256", "text", "representation"])
    && page.status === 200 && /^text\/html(?:\s*;|$)/i.test(page.contentType) && page.representation === "complete_retained_static_text_v1"
    && typeof page.text === "string" && page.text.length > 0 && page.text.length <= 150000 && sha(page.text) === page.textSha256
    && [page.htmlSha256, page.textSha256, page.receiptSha256].every(hash), "complete own-site body differs");
  url(page.requestedUrl, domain); url(page.finalUrl, domain);
  need(Array.isArray(page.hops) && page.hops.length >= 1 && page.hops.length <= 4
    && page.hops[0].url === page.requestedUrl && page.hops.at(-1)!.url === page.finalUrl
    && page.hops.every((h, i) => shape(h, ["url", "status"]) && !!url(h.url, domain)
      && (i === page.hops.length - 1 ? h.status === 200 : [301, 302, 303, 307, 308].includes(h.status))), "own-site hops differ");
  const companyText = ordinaryQuote(page, b.companyQuote), licenseText = ordinaryQuote(page, b.licenseQuote);
  need((` ${legal(companyText)} `).includes(` ${legal(companyName)} `)
    && licenseText === `Colorado Public Accounting Firm License Number ${b.licenseToken}`,
  "own-company labelled firm license differs");
  const tokens = [...page.text.matchAll(/\bFRM\.[A-Za-z0-9.-]+/g)].map(m => m[0]);
  need(tokens.length > 0 && tokens.every(token => token === b.licenseToken), "ambiguous or partial firm license token");
  const times = [b.license.observedAt, b.trade.observedAt, page.observedAt].map(instant);
  need(sourceReader.taskId !== sourceReviewer.taskId && times.every(t => t <= instant(sourceReader.reviewedAt))
    && instant(sourceReviewer.reviewedAt) >= instant(sourceReader.reviewedAt), "source chronology or independence differs");
  const lim = b.limitations;
  need(shape(lim, ["association", "addressEquivalenceClaimed", "canonicalIdentityChanged", "currentLicenseClaimed", "individualOwnershipClaimed", "financialOrDisciplinaryInference", "literalDifferences"])
    && lim.association === "independently_reviewed_company_inference" && lim.addressEquivalenceClaimed === false && lim.canonicalIdentityChanged === false
    && lim.currentLicenseClaimed === false && lim.individualOwnershipClaimed === false && lim.financialOrDisciplinaryInference === false
    && Array.isArray(lim.literalDifferences) && lim.literalDifferences.length > 0 && lim.literalDifferences.length <= 12
    && lim.literalDifferences.every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 1500), "inference limits differ");
  return { ...b, bridgeSha256: sha(stableRegistryJson(b)),
    scope: "Dated company association through its labelled Colorado FRM license, exact official legal licensee/locality and exact owner-linked trade-name entity. No street/unit equivalence, current license/control/occupancy, personal ownership, discipline consequence or financial inference. Original SOS facts and canonical identity remain unchanged." };
}
