/** Some first-party RSS feeds contain unescaped '&' or HTML-only entities in
 * XML text/attributes. Repair that encoding alone; never change CDATA, URLs,
 * dates, item structure or malformed tags. Remaining parse errors stay visible. */
export function normalizeFeedXml(xml: string): { xml: string; entityRepairs: number } {
  let entityRepairs = 0;
  const normalized = xml.split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/g).map(part => {
    if (part.startsWith("<![CDATA[") || part.startsWith("<!--")) return part;
    return part.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, () => { entityRepairs++; return "&amp;"; });
  }).join("");
  return { xml: normalized, entityRepairs };
}
