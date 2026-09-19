/** Public-page extraction. Structural labels select content; prose never does. */
export interface SiteCompanyIdentity {
  names: string[];
  addresses: Array<{ addressLine1?: string; city?: string; state?: string; postalCode?: string; countryCode?: string }>;
  sourceUrl: string;
}

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlNode | string>;
  parent?: HtmlNode;
  hidden?: boolean;
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

export function htmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const OMIT = new Set(["head", "title", "script", "style", "noscript", "svg", "template", "nav", "form", "button"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section", "summary", "table", "tr", "ul"]);

// Deliberately match component identifiers, not words in article text. In
// particular an editorial footer/aside may contain the actual announcement.
const WIDGET = /^(?:related(?:-?(?:posts?|articles?|stories|content))|recommended-(?:posts?|articles?|stories)|recommendation-widget|yarpp-related|jp-relatedposts|crp-related|newsletter-(?:signup|sign-up|form|widget)|subscribe-(?:form|widget)|subscription-widget|cookie-(?:banner|consent|notice)|onetrust-(?:banner-sdk|consent-sdk)|comments?(?:-area|-list|-respond|-section)?|respond|disqus-thread|social-share|share-buttons|sharing-tools|sharedaddy|addtoany-share-save-container|sidebar|widget-area|advertisement|ad-container|ad-slot|adsbygoogle|site-header|site-footer)(?:-+(?:wrapper|container|block|items))?$/i;

function omitted(node: HtmlNode): boolean {
  const attrs = node.attrs;
  return OMIT.has(node.tag) || node.hidden === true || attrs["aria-hidden"] === "true"
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attrs.style ?? "")
    || /^(?:navigation|banner|contentinfo)$/i.test(attrs.role ?? "")
    || `${attrs.id ?? ""} ${attrs.class ?? ""}`.replaceAll("_", "-").split(/\s+/).some(marker => WIDGET.test(marker));
}

function htmlTree(html: string): HtmlNode {
  // Raw-text elements can contain fake tags; remove them before tokenizing.
  const source = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const root: HtmlNode = { tag: "#document", attrs: {}, children: [] };
  const stack = [root];
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  let cursor = 0;
  for (const match of source.matchAll(tags)) {
    const tag = match[0];
    if (match.index! > cursor) stack.at(-1)!.children.push(source.slice(cursor, match.index));
    cursor = match.index! + tag.length;
    if (tag.startsWith("<!")) continue;
    const name = tag.match(/^<\/?([\w:-]+)/)?.[1].toLowerCase();
    if (!name) continue;
    if (tag.startsWith("</")) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === name) { stack.length = index; break; }
      }
      continue;
    }
    const parent = stack.at(-1)!;
    const node: HtmlNode = { tag: name, attrs: htmlAttributes(tag), children: [], parent,
      hidden: /\shidden(?:\s|=|\/?>)/i.test(tag) };
    parent.children.push(node);
    if (!VOID.has(name) && !/\/\s*>$/.test(tag) && stack.length < 256) stack.push(node);
  }
  if (cursor < source.length) stack.at(-1)!.children.push(source.slice(cursor));
  return root;
}

function withinArticle(node: HtmlNode): boolean {
  for (let parent: HtmlNode | undefined = node; parent; parent = parent.parent) {
    if (parent.tag === "article") return true;
  }
  return false;
}

/** Retain the complete selected container and paragraph boundaries, including
 * editorial headers, footers and asides. Multiple article cards remain a list. */
export function extractSiteText(html: string): string {
  const root = htmlTree(html);
  const nodes: HtmlNode[] = [];
  const collect = (node: HtmlNode) => {
    if (omitted(node)) return;
    nodes.push(node);
    for (const child of node.children) if (typeof child !== "string") collect(child);
  };
  collect(root);
  const articles = nodes.filter(node => node.tag === "article" && !withinArticle(node.parent ?? root));
  const articleBodies = nodes.filter(node => /(?:^|\s)articleBody(?:\s|$)/i.test(node.attrs.itemprop ?? ""));
  const mains = nodes.filter(node => node.tag === "main" || node.attrs.role === "main");
  const contentBodies = nodes.filter(node => /(?:^|\s)(?:entry-content|article-body|post-content|story-body)(?:\s|$)/i.test(node.attrs.class ?? ""));
  const selected = articles.length === 1 ? articles[0]
    : articleBodies.length === 1 ? articleBodies[0]
      : mains.length === 1 ? mains[0]
        : contentBodies.length === 1 ? contentBodies[0] : root;
  const pieces: string[] = [];
  const render = (node: HtmlNode) => {
    if (omitted(node)) return;
    if (selected === root && /^(?:header|footer)$/.test(node.tag) && !withinArticle(node)) return;
    if (BLOCK.has(node.tag)) pieces.push("\n");
    for (const child of node.children) {
      if (typeof child === "string") pieces.push(child.replace(/\s+/g, " "));
      else render(child);
    }
    if (BLOCK.has(node.tag)) pieces.push("\n");
    else if (node.tag === "td" || node.tag === "th") pieces.push("\t");
  };
  render(selected);
  return decodeEntities(pieces.join(""))
    .split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean).join("\n\n").trim();
}

const ORGANIZATIONS = new Set(["Organization", "LocalBusiness", "Corporation", "NewsMediaOrganization", "ProfessionalService", "LegalService", "EmploymentAgency", "FinancialService", "MedicalOrganization", "NGO", "EducationalOrganization", "SportsOrganization", "Store", "AutomotiveBusiness", "EntertainmentBusiness", "FoodEstablishment", "HealthAndBeautyBusiness", "HomeAndConstructionBusiness", "LodgingBusiness", "RealEstateAgent", "TravelAgency"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clean = (value: unknown, length = 200): string | undefined => typeof value === "string" && value.trim()
  ? decodeEntities(value).replace(/\s+/g, " ").trim().slice(0, length) : undefined;
const schemaTypes = (value: unknown): string[] => (Array.isArray(value) ? value : [value])
  .filter((item): item is string => typeof item === "string").map(item => item.replace(/^https?:\/\/schema\.org\//, ""));

/** Only publisher/company organizations with an explicit same-site URL/@id.
 * Addresses attached to events, people, customers or unscoped PostalAddress
 * nodes are never borrowed. A foreign organization.url overrides a local @id. */
export function extractCompanyIdentity(html: string, sourceUrl: string, isSameSite: (url: string) => boolean): SiteCompanyIdentity | undefined {
  const names: string[] = [];
  const addresses: SiteCompanyIdentity["addresses"] = [];
  let organizationName: string | undefined;
  let remaining = 300;
  const addOrganization = (value: Record<string, unknown>) => {
    const name = clean(value.name);
    const rawUrl = typeof value.url === "string" ? value.url : typeof value["@id"] === "string" ? value["@id"] : undefined;
    if (!name || !rawUrl) return;
    try { if (!isSameSite(new URL(rawUrl, sourceUrl).toString())) return; } catch { return; }
    // names[] and addresses[] describe one organization. Flattening a site's
    // parent, publisher and customer nodes into one identity would incorrectly
    // attach every address after just one of the names matched the account.
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (organizationName && organizationName !== normalizedName) return;
    organizationName = normalizedName;
    for (const item of [name, ...(Array.isArray(value.alternateName) ? value.alternateName : [value.alternateName])]) {
      const alias = clean(item);
      if (alias && names.length < 6 && !names.includes(alias)) names.push(alias);
    }
    for (const item of Array.isArray(value.address) ? value.address : [value.address]) {
      if (!record(item) || addresses.length >= 6) continue;
      if (item["@type"] && !schemaTypes(item["@type"]).includes("PostalAddress")) continue;
      const country = clean(record(item.addressCountry) ? item.addressCountry.name : item.addressCountry, 80);
      const countryCode = country && (/^[a-z]{2}$/i.test(country) ? country.toUpperCase()
        : /^(?:USA|United States(?: of America)?)$/i.test(country) ? "US" : /^Canada$/i.test(country) ? "CA" : undefined);
      const address = {
        ...(clean(item.streetAddress) ? { addressLine1: clean(item.streetAddress) } : {}),
        ...(clean(item.addressLocality) ? { city: clean(item.addressLocality) } : {}),
        ...(clean(item.addressRegion) ? { state: clean(item.addressRegion) } : {}),
        ...(clean(item.postalCode, 40) ? { postalCode: clean(item.postalCode, 40) } : {}),
        ...(countryCode ? { countryCode } : {}),
      };
      if (Object.keys(address).length && !addresses.some(existing => JSON.stringify(existing) === JSON.stringify(address))) addresses.push(address);
    }
  };
  const visit = (value: unknown, depth = 0) => {
    if (remaining-- <= 0 || depth > 8) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    if (!record(value)) return;
    const types = schemaTypes(value["@type"]);
    if (types.some(type => ORGANIZATIONS.has(type))) addOrganization(value);
    if (value["@graph"]) visit(value["@graph"], depth + 1);
    // A page/article's publisher is scoped identity; its subjects, customers,
    // locations, event organizers and arbitrary nested objects are not.
    if (types.some(type => ["WebSite", "WebPage", "Article", "NewsArticle", "BlogPosting"].includes(type)) && record(value.publisher)) visit(value.publisher, depth + 1);
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (htmlAttributes(match[1]).type?.toLowerCase() !== "application/ld+json" || match[2].length > 500_000) continue;
    try { visit(JSON.parse(match[2])); } catch { /* Invalid structured data is not company identity. */ }
  }
  return names.length ? { names, addresses, sourceUrl } : undefined;
}
