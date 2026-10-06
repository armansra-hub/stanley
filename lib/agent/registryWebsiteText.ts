import { createHash } from "node:crypto";
import { htmlToVisibleText, htmlAttributes, decodeEntities } from "@/lib/sources/siteDiscovery";

export type RegistryWebsiteNormalization = "gravity_forms_honeypot_v1" | "gravity_forms_honeypot_v2" | "gravity_forms_honeypot_v3" | "everest_forms_honeypot_v1" | "everest_forms_honeypot_v2" | "everest_forms_honeypot_v3" | "testimonials_widget_unordered_v1" | "caldera_forms_honeypot_v1";

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
// v3 adds only the Instagram label observed in the retained NRI failure.
const trapLabelsV3 = new Set([...trapLabelsV2, "Instagram"]);
const aboveClasses = outerClasses.map(c => c === "field_sublabel_below" ? "field_sublabel_above"
  : c === "field_description_below" ? "field_description_above" : c);

function withoutDeclaredTraps(html: string, extended = false, instagram = false): string {
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
        || d.id !== `gfield_description_${formId}_${fieldId}` || !(instagram ? trapLabelsV3 : extended ? trapLabelsV2 : trapLabels).has(decodeEntities(title).trim())
        || decodeEntities(message).trim() !== "This field is for validation purposes and should be left unchanged.") return whole;
      return " ";
    };
    let cleaned = body.replace(field, (whole, o, l, s, t, c, i, d, m) => cleanField(whole, o, l, s, t, c, i, d, m, false));
    if (extended) cleaned = cleaned.replace(fieldAbove, (whole, o, l, s, t, d, m, c, i) => cleanField(whole, o, l, s, t, c, i, d, m, true));
    // Keep every original form tag/attribute and all non-trap text intact.
    return open + cleaned + close;
  });
}

// Independent opt-in grammar for the retained Everest Forms empty trap. It
// does not upgrade Gravity Forms modes or omit arbitrary Website/Message text.
const everestField = new RegExp(`<div\\b${attrs}>\\s*<label\\b${attrs}>(Website|Message)<\\/label>\\s*<input\\b${attrs}\\/?>\\s*<\\/div>`, "g");
// v2 adds only the Comment label observed in a retained empty Everest trap.
const everestFieldV2 = new RegExp(everestField.source.replace("Website|Message", "Website|Message|Comment"), "g");
// v3 uses the complete six-label array from the upstream Everest renderer:
// themegrill/everest-forms Git blob 48bfaca1d978f00ceeec7ddbea203698289e3eac,
// includes/shortcodes/class-evf-shortcode-form.php, honeypot(). No arbitrary labels.
const everestFieldV3 = new RegExp(everestField.source.replace("Website|Message", "Name|Phone|Comment|Message|Email|Website"), "g");
function withoutEverestTrap(html: string, comment = false, finiteLabels = false): string {
  const source = html.replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  return source.replace(/(<form\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>)([\s\S]*?)(<\/form\s*>)/gi, (form, open: string, raw: string, body: string, close: string) => {
    const f = exactAttributes(raw, ["id", "class", "data-formid", "data-ajax_submission", "data-keyboard_friendly_form", "data-form_state_type", "method", "enctype", "action"]);
    const id = f?.id?.match(/^evf-form-([1-9]\d*)$/)?.[1];
    if (!f || !id || f["data-formid"] !== id || !classes(f.class, ["everest-form"])
      || f.method !== "post" || f.enctype !== "multipart/form-data" || !f.action
      || f["data-ajax_submission"] !== "0" || f["data-keyboard_friendly_form"] !== "0" || f["data-form_state_type"] !== ""
      || /<\/?form\b/i.test(body)) return form;
    // Reject ambiguous duplicates; do not partially clean a malformed trap set.
    const trapNames = [...body.matchAll(new RegExp(`<input\\b${attrs}\\/?>`, "gi"))]
      .flatMap(input => [...input[1].matchAll(attributes)]
        .filter(a => a[1].toLowerCase() === "name" && htmlAttributes(a[0]).name === "everest_forms[hp]"));
    if (trapNames.length !== 1) return form;
    const candidates = [...body.matchAll(finiteLabels ? everestFieldV3 : comment ? everestFieldV2 : everestField)];
    if (candidates.length !== 1) return form;
    const [whole, outer, label, _title, input] = candidates[0];
    const o = exactAttributes(outer, ["class"]), l = exactAttributes(label, ["for", "class"]),
      i = exactAttributes(input, ["type", "name", "id", "class"]);
    if (!o || !l || !i || !classes(o.class, ["evf-honeypot-container", "evf-field-hp"])
      || !classes(l.class, ["evf-field-label"]) || l.for !== `evf-${id}-field-hp`
      || i.id !== l.for || i.name !== "everest_forms[hp]" || i.type !== "text" || !classes(i.class, ["input-text"])) return form;
    const start = candidates[0].index!;
    // Retain every byte outside the proven non-content region before the usual
    // visible-text extraction. The verifier still compares the whole page hash.
    return open + body.slice(0, start) + " " + body.slice(start + whole.length) + close;
  });
}

// The retained Caldera forms place one empty, zero-size trap immediately after
// their identity controls. This opt-in grammar removes only that closed block;
// a generic hidden div, arbitrary label, populated field or real form row stays.
const calderaLabels: Record<string, string> = {
  Name: "name", Url: "url", "Order Number": "order_number", "Web Site": "web_site", Email: "email", Phone: "phone", Company: "company", Twitter: "twitter",
};
function withoutCalderaTrap(html: string): string {
  if (html.length > 2 * 1024 * 1024) throw new Error("invalid Caldera trap page");
  // Mask non-markup contexts only for locating real forms; return original bytes
  // outside accepted trap offsets. Never discover a form inside a raw-text tag.
  let ambiguous = false;
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|svg|template|textarea|title|xmp|iframe|noembed)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)/gi, raw => {
    const tag = raw.match(/^<([a-z]+)/i)?.[1];
    if (tag && new RegExp(`<${tag}\\b`, "i").test(raw.slice(raw.indexOf(">") + 1))) ambiguous = true;
    return " ".repeat(raw.length);
  });
  // HTML plaintext consumes the remaining document; never parse its apparent forms.
  if (ambiguous || /<plaintext\b/i.test(source)) return html;
  const formPattern = /(<form\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>)([\s\S]*?)(<\/form\s*>)/gi;
  const forms = [...source.matchAll(formPattern)], edits: { start: number; end: number }[] = [];
  const ids = forms.map(m => htmlAttributes(m[2]).id).filter(Boolean);
  const prefixPattern = new RegExp(`^\\s*<input\\b${attrs}\\/?>\\s*<input\\b${attrs}\\/?>\\s*<div\\b${attrs}>\\s*<\\/div>\\s*<input\\b${attrs}\\/?>\\s*<input\\b${attrs}\\/?>\\s*<input\\b${attrs}\\/?>\\s*<input\\b${attrs}\\/?>\\s*`, "i");
  const trapPattern = new RegExp(`^<div\\b${attrs}>\\s*<label>(Name|Url|Order Number|Web Site|Email|Phone|Company|Twitter)<\\/label>\\s*<input\\b${attrs}\\/?>\\s*<\\/div>`, "i");
  for (const form of forms) {
    const f = exactAttributes(form[2], ["data-instance", "class", "method", "enctype", "id", "data-form-id", "aria-label", "data-target", "data-template", "data-cfajax", "data-load-element", "data-load-class", "data-post-disable", "data-action", "data-request", "data-custom-callback", "data-hiderows"]);
    const id = f?.["data-form-id"], instance = f?.["data-instance"];
    if (!f || !id || !/^CF[a-f0-9]{13}$/.test(id) || !instance || !/^[1-9]\d{0,5}$/.test(instance)
      || f.id !== `${id}_${instance}` || ids.filter(x => x === f.id).length !== 1
      || !classes(f.class, [id, "caldera_forms_form", "cfajax-trigger"])
      || f.method !== "POST" || f.enctype !== "multipart/form-data" || !f["aria-label"]
      || f["data-target"] !== `#caldera_notices_${instance}` || f["data-template"] !== `#cfajax_${id}-tmpl`
      || f["data-cfajax"] !== id || f["data-load-element"] !== "_parent" || f["data-load-class"] !== "cf_processing"
      || f["data-post-disable"] !== "0" || f["data-action"] !== "cf_process_ajax_submit"
      || f["data-custom-callback"] !== "slug_post_form_submit" || f["data-hiderows"] !== "true"
      || !new RegExp(`^https://[a-z0-9.-]+/cf-api/${id}$`).test(f["data-request"] ?? "")
      || /<\/?form\b/i.test(form[3])) continue;
    const bodyStart = form.index! + form[1].length;
    const body = html.slice(bodyStart, bodyStart + form[3].length), prefix = body.match(prefixPattern);
    if (!prefix) continue;
    const nonce = exactAttributes(prefix[1], ["type", "id", "name", "value", "data-nonce-time"]);
    const ref = exactAttributes(prefix[2], ["type", "name", "value"]), box = exactAttributes(prefix[3], ["id"]);
    const controls = prefix.slice(4, 8).map(raw => exactAttributes(raw, ["type", "name", "value"]));
    const expected = [["_cf_frm_id", id], ["_cf_frm_ct", instance], ["cfajax", id]];
    if (!nonce || nonce.type !== "hidden" || nonce.id !== `_cf_verify_${id}` || nonce.name !== "_cf_verify"
      || !/^[a-f0-9]{10}$/.test(nonce.value ?? "") || !/^\d{10}$/.test(nonce["data-nonce-time"] ?? "")
      || !ref || ref.type !== "hidden" || ref.name !== "_wp_http_referer" || !/^\/(?!\/)[^<>\s]*$/.test(ref.value ?? "")
      || !box || box.id !== `cf2-${id}_${instance}`
      || expected.some(([name, value], i) => !controls[i] || controls[i]!.type !== "hidden" || controls[i]!.name !== name || controls[i]!.value !== value)
      || !controls[3] || controls[3].type !== "hidden" || controls[3].name !== "_cf_cr_pst" || !/^[1-9]\d*$/.test(controls[3].value ?? "")) continue;
    const field = body.slice(prefix[0].length).match(trapPattern);
    if (!field) continue;
    const outer = exactAttributes(field[1], ["class", "style"]), input = exactAttributes(field[3], ["type", "name", "value", "autocomplete"]);
    if (!Object.hasOwn(calderaLabels, field[2]) || !outer || outer.class !== "hide" || outer.style !== "display:none; overflow:hidden;height:0;width:0;"
      || !input || input.type !== "text" || input.name !== calderaLabels[field[2]] || input.value !== "" || input.autocomplete !== "off") continue;
    // Duplicated identity/trap controls or a changed first real row are ambiguous.
    const names = [...body.matchAll(new RegExp(`<input\\b${attrs}\\/?>`, "gi"))]
      .flatMap(m => [...m[1].matchAll(attributes)].filter(a => a[1].toLowerCase() === "name").map(a => htmlAttributes(a[0]).name));
    if (["_cf_verify", "_wp_http_referer", "_cf_frm_id", "_cf_frm_ct", "cfajax", "_cf_cr_pst", input.name].some(name => names.filter(n => n === name).length !== 1)) continue;
    const next = body.slice(prefix[0].length + field[0].length).match(new RegExp(`^\\s*<div\\b${attrs}>`, "i"));
    const row = next && exactAttributes(next[1], ["id", "class"]);
    if (!row || row.id !== `${id}_${instance}-row-1` || !classes(row.class, ["row", "first_row"])) continue;
    const start = bodyStart + prefix[0].length;
    edits.push({ start, end: start + field[0].length });
  }
  for (const edit of edits.reverse()) html = html.slice(0, edit.start) + " " + html.slice(edit.end);
  return html;
}


// This mode recognizes one closed Testimonials Widget container. Order and the
// corresponding first-card display assignment are presentation; nothing else is
// omitted. Raw card bytes, wrapper bytes and positional whitespace/style vectors
// are integrity-bound in addition to the complete, reordered visible text.
function unorderedTestimonials(html: string) {
  function fail(): never { throw new Error("invalid unordered testimonials widget"); }
  if (html.length > 2 * 1024 * 1024) fail();
  const tokenPattern = /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|svg|template|textarea|title|xmp|iframe|noembed)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[a-z][\w:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  const tokens = [...html.matchAll(tokenPattern)].map(m => ({
    raw: m[0], start: m.index!, end: m.index! + m[0].length,
    tag: m[0].startsWith("<!--") || m[1] ? null : m[0].match(/^<\/?([\w:-]+)/)![1].toLowerCase(),
  }));
  // Nested raw-text/template constructs are outside this finite grammar. Do not
  // let a regex's first closing tag expose a hidden widget as real structure.
  for (const token of tokens) {
    if (token.tag || token.raw.startsWith("<!--")) continue;
    const name = token.raw.match(/^<([a-z]+)/i)![1];
    if (new RegExp(`<${name}\\b`, "i").test(token.raw.slice(token.raw.indexOf(">") + 1))) fail();
  }
  const widgetTags = tokens.filter(t => t.tag && !t.raw.startsWith("</")
    && (htmlAttributes(t.raw).class ?? "").split(/\s+/).some(c => /^testimonials-widget-testimonials(?:\d+)?$/.test(c)));
  const controls = widgetTags.filter(t => (htmlAttributes(t.raw).class ?? "").split(/\s+/).includes("bx-controls"));
  const candidates = widgetTags.filter(t => !controls.includes(t));
  if (candidates.length !== 1 || controls.length > 1) fail();
  const outer = candidates[0], outerAttrs = outer.raw.match(/^<div\b([\s\S]*)>$/i);
  const o = outerAttrs && exactAttributes(outerAttrs[1], ["class"]);
  if (!o || /\/\s*>$/.test(outer.raw) || !/^testimonials-widget-testimonials testimonials-widget-testimonials[1-9]\d{0,11}$/.test(o.class ?? "")) fail();
  const cards: { id: string; html: string }[] = [], styles: string[] = [], gaps: string[] = [];
  const stack = ["div"], ids = new Set<string>();
  const allowed = new Set(["div", "blockquote", "span", "a", "p", "br", "strong", "em", "b", "i", "img"]);
  let cursor = outer.end, previous = outer.end, cardStart = -1, cardId = "", close = "", end = -1;
  for (const token of tokens.slice(tokens.indexOf(outer) + 1)) {
    if (html.slice(previous, token.start).includes("<")) fail();
    previous = token.end;
    if (!token.tag) {
      // Comments inside cards are retained byte-for-byte. No raw-text elements
      // or comment-shaped cards can create structural evidence.
      if (stack.length < 2 || !token.raw.startsWith("<!--") || !token.raw.endsWith("-->")) fail();
      continue;
    }
    if (!allowed.has(token.tag)) fail();
    if (token.raw.startsWith("</")) {
      if (!/^<\/[a-z]+\s*>$/i.test(token.raw) || stack.pop() !== token.tag) fail();
      if (stack.length === 1) {
        const raw = html.slice(cardStart, token.end);
        // Only this exact double-quoted outer presentation attribute changes
        // assignment; its position and every other opening/inner/closing byte stay.
        cards.push({ id: cardId, html: raw.replace(/^<div\b[^>]*>/i, open => open.replace(/ style="(?:display: none;)?"/, ' style=""')) });
        cursor = token.end;
      } else if (stack.length === 0) {
        const gap = html.slice(cursor, token.start);
        if (gap.trim()) fail();
        gaps.push(gap); close = token.raw; end = token.end; break;
      }
    } else {
      if (/\/\s*>$/.test(token.raw) && !["br", "img"].includes(token.tag)) fail();
      if (stack.length === 1) {
        const a = token.raw.match(/^<div\b([\s\S]*)>$/i), parsed = a && exactAttributes(a[1], ["class", "style"]);
        const id = parsed?.class?.match(/^testimonials-widget-testimonial post-([1-9]\d{0,11}) testimonials-widget type-testimonials-widget status-publish$/)?.[1];
        const style = parsed?.style, gap = html.slice(cursor, token.start);
        if (!id || ids.has(id) || cards.length >= 100 || gap.trim()
          || !/ style="(?:display: none;)?"/.test(token.raw)
          || style !== (cards.length === 0 ? "" : "display: none;")) fail();
        ids.add(id); gaps.push(gap); styles.push(style); cardId = id; cardStart = token.start;
      } else if ((htmlAttributes(token.raw).class ?? "").split(/\s+/).includes("testimonials-widget-testimonial")) fail();
      if (!["br", "img"].includes(token.tag)) stack.push(token.tag);
    }
  }
  if (end < 0 || cards.length < 2 || stack.length) fail();
  // The plugin may emit one empty adjacent control div with the same instance.
  // Its complete bytes remain bound; it cannot hide a second content widget.
  let controlBytes = "";
  if (controls.length) {
    const control = controls[0], next = tokens[tokens.indexOf(control) + 1];
    const instance = o.class.match(/testimonials-widget-testimonials([1-9]\d*)$/)![1];
    const rawAttrs = control.raw.match(/^<div\b([\s\S]*)>$/i), a = rawAttrs && exactAttributes(rawAttrs[1], ["class"]);
    if (!a || a.class !== `testimonials-widget-testimonials bx-controls testimonials-widget-testimonials${instance}-control`
      || /\/\s*>$/.test(control.raw) || control.start < end || html.slice(end, control.start).trim()
      || !next || !/^<\/div\s*>$/i.test(next.raw) || html.slice(control.end, next.start).trim()) fail();
    controlBytes = html.slice(end, next.end);
  }
  cards.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify({ open: outer.raw, close, gaps, styles, cards, controlBytes })).digest("hex");
  const canonicalWidget = outer.raw + cards.map((card, i) => gaps[i]
    + card.html.replace(/^<div\b[^>]*>/i, open => open.replace(' style=""', ` style="${styles[i]}"`))).join("") + gaps[cards.length] + close;
  const prefix = html.slice(0, outer.start), suffix = html.slice(end);
  return { prefix, suffix, widgetText: htmlToVisibleText(canonicalWidget),
    text: htmlToVisibleText(prefix + canonicalWidget + suffix) + ` [registry:testimonials_widget_unordered_v1:sha256:${digest}]` };
}

/** A quote wholly outside the widget is required. Even a duplicated quote inside
 * a testimonial is rejected, so stored quote offsets cannot select a customer. */
export function registryWebsiteQuoteOutsideWidget(html: string, quote: string): boolean {
  const page = unorderedTestimonials(html);
  return !page.widgetText.includes(quote)
    && (htmlToVisibleText(page.prefix).includes(quote) || htmlToVisibleText(page.suffix).includes(quote));
}

/** Default is the original complete-text algorithm. The opt-in trap versions omit
 * only declared empty anti-spam fields under its separate closed grammar
 * above. It makes no CSS/rendering claim and never drops general hidden content.
 * The proof version is attestation-bound; raw HTML is retained independently. */
export function registryWebsiteText(html: string, normalization?: RegistryWebsiteNormalization): string {
  if (normalization === undefined) return htmlToVisibleText(html);
  if (normalization === "caldera_forms_honeypot_v1") return htmlToVisibleText(withoutCalderaTrap(html));
  if (normalization === "testimonials_widget_unordered_v1") return unorderedTestimonials(html).text;
  if (normalization === "everest_forms_honeypot_v1" || normalization === "everest_forms_honeypot_v2" || normalization === "everest_forms_honeypot_v3")
    return htmlToVisibleText(withoutEverestTrap(html, normalization === "everest_forms_honeypot_v2", normalization === "everest_forms_honeypot_v3"));
  if (normalization !== "gravity_forms_honeypot_v1" && normalization !== "gravity_forms_honeypot_v2" && normalization !== "gravity_forms_honeypot_v3")
    throw new Error("invalid registry website normalization");
  return htmlToVisibleText(withoutDeclaredTraps(html, normalization !== "gravity_forms_honeypot_v1", normalization === "gravity_forms_honeypot_v3"));
}
