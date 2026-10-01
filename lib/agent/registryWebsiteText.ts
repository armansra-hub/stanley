import { htmlToVisibleText, htmlAttributes, decodeEntities } from "@/lib/sources/siteDiscovery";

export type RegistryWebsiteNormalization = "gravity_forms_honeypot_v1" | "gravity_forms_honeypot_v2";

const attributes = /([\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g;
function exactAttributes(raw: string, allowed: string[]): Record<string, string> | null {
  const names = [...raw.matchAll(attributes)].map(m => m[1].toLowerCase());
  if (raw.replace(attributes, "").replace(/\/\s*$/, "").trim()
    || new Set(names).size !== names.length || names.some(n => !allowed.includes(n))) return null;
  return htmlAttributes(raw);
}
function classes(raw: string | undefined, required: string[], allowed = required): boolean {
  const values = (raw ?? "").trim().split(/\s+/);
  return required.every(v => values.includes(v)) && values.every(v => allowed.includes(v));
}

// A closed field grammar, not deletion by label or a general hidden-element rule.
// Additional tags, prose, values or attributes keep the entire field in the hash.
const attrs = `((?:[^"'<>]|"[^"]*"|'[^']*')*)`;
const field = new RegExp(`<div\\b${attrs}>\\s*<label\\b${attrs}>\\s*<span\\b${attrs}>([^<>]{0,80})<\\/span>\\s*<\\/label>\\s*<div\\b${attrs}>\\s*<input\\b${attrs}\\/?>\\s*<\\/div>\\s*<div\\b${attrs}>([^<>]{0,160})<\\/div>\\s*<\\/div>`, "gi");
// v2 additionally recognizes the observed description-before-input layout.
const fieldAbove = new RegExp(`<div\\b${attrs}>\\s*<label\\b${attrs}>\\s*<span\\b${attrs}>([^<>]{0,80})<\\/span>\\s*<\\/label>\\s*<div\\b${attrs}>([^<>]{0,160})<\\/div>\\s*<div\\b${attrs}>\\s*<input\\b${attrs}\\/?>\\s*<\\/div>\\s*<\\/div>`, "gi");
const trapLabels = new Set(["Name", "Email", "Phone", "Company", "Website", "URL", "Comments", "Fax"]);
const outerClasses = ["gfield", "gfield--type-honeypot", "gform_validation_container", "field_sublabel_below",
  "gfield--has-description", "field_description_below", "field_validation_below", "gfield_visibility_visible"];

const trapLabelsV2 = new Set([...trapLabels, "Facebook", "LinkedIn"]);
const aboveClasses = outerClasses.map(c => c === "field_sublabel_below" ? "field_sublabel_above"
  : c === "field_description_below" ? "field_description_above" : c);

function withoutDeclaredTraps(html: string, extended = false): string {
  // Match only real markup, never field-shaped text inside scripts or comments.
  const source = html.replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  return source.replace(/(<form\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>)([\s\S]*?)(<\/form\s*>)/gi, (form, open: string, raw: string, body: string, close: string) => {
    const formAttrs = htmlAttributes(raw), formId = formAttrs.id?.match(/^gform_([1-9]\d*)$/)?.[1];
    const formAttributeNames = [...raw.matchAll(attributes)].map(m => m[1].toLowerCase());
    if (!formId || formAttrs["data-formid"] !== formId || formAttrs.method?.toLowerCase() !== "post"
      || new Set(formAttributeNames).size !== formAttributeNames.length || /<\/?form\b/i.test(body)) return form;
    const cleanField = (whole: string, outer: string, label: string, span: string, title: string,
      container: string, input: string, description: string, message: string, above: boolean) => {
      const o = exactAttributes(outer, ["id", "class"]), l = exactAttributes(label, ["class", "for"]),
        s = exactAttributes(span, ["class"]), c = exactAttributes(container, ["class"]),
        i = exactAttributes(input, ["name", "id", "type", "value", "autocomplete"]),
        d = exactAttributes(description, ["class", "id"]);
      const fieldId = o?.id?.match(new RegExp(`^field_${formId}_([1-9]\\d*)$`))?.[1];
      if (!o || !l || !s || !c || !i || !d || !fieldId
        || !classes(o.class, ["gfield", "gfield--type-honeypot", "gform_validation_container",
          ...(above ? ["field_sublabel_above", "field_description_above"] : [])], above ? aboveClasses : outerClasses)
        || !classes(l.class, ["gfield_label", "gform-field-label"]) || !classes(s.class, ["gform-field-label__text"])
        || !classes(c.class, ["ginput_container"]) || !classes(d.class, ["gfield_description"])
        || l.for !== `input_${formId}_${fieldId}` || i.id !== l.for || i.name !== `input_${fieldId}`
        || i.type !== "text" || i.value !== "" || i.autocomplete !== "new-password"
        || d.id !== `gfield_description_${formId}_${fieldId}` || !(extended ? trapLabelsV2 : trapLabels).has(decodeEntities(title).trim())
        || decodeEntities(message).trim() !== "This field is for validation purposes and should be left unchanged.") return whole;
      return " ";
    };
    let cleaned = body.replace(field, (whole, o, l, s, t, c, i, d, m) => cleanField(whole, o, l, s, t, c, i, d, m, false));
    if (extended) cleaned = cleaned.replace(fieldAbove, (whole, o, l, s, t, d, m, c, i) => cleanField(whole, o, l, s, t, c, i, d, m, true));
    // Keep every original form tag/attribute and all non-trap text intact.
    return open + cleaned + close;
  });
}

/** Default is the original complete-text algorithm. The opt-in version omits
 * only declared empty Gravity Forms anti-spam fields with the closed grammar
 * above. It makes no CSS/rendering claim and never drops general hidden content.
 * The proof version is attestation-bound; raw HTML is retained independently. */
export function registryWebsiteText(html: string, normalization?: RegistryWebsiteNormalization): string {
  if (normalization === undefined) return htmlToVisibleText(html);
  if (normalization !== "gravity_forms_honeypot_v1" && normalization !== "gravity_forms_honeypot_v2")
    throw new Error("invalid registry website normalization");
  return htmlToVisibleText(withoutDeclaredTraps(html, normalization === "gravity_forms_honeypot_v2"));
}
