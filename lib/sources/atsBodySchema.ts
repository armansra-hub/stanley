import { htmlToVisibleText } from "./siteDiscovery";
export const ATS_BODY_SCHEMA = "ats-body-schema-v1";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Validate provider fields before joining/interpolating; object coercion is never source text. */
export function validatedAtsBody(type: string, raw: unknown): { description: string; bodySchemaValidated: boolean } {
  const invalid = { description: "", bodySchemaValidated: false };
  if (!object(raw)) return invalid;
  const id = raw.id ?? raw.shortcode ?? raw.jobId ?? raw.slug;
  if (!(typeof id === "string" && id.trim() || typeof id === "number" && Number.isFinite(id))) return invalid;
  const title = type === "lever" ? raw.text : type === "smartrecruiters" ? raw.name : raw.title;
  const url = type === "greenhouse" ? raw.absolute_url : type === "lever" ? raw.hostedUrl
    : type === "ashby" ? raw.jobUrl ?? raw.applyUrl : type === "recruitee" ? raw.careers_url ?? raw.url
      : type === "workable" ? raw.url ?? raw.shortlink : null;
  if (typeof title !== "string" || !title.trim() || (type !== "smartrecruiters" && (typeof url !== "string" || !/^https?:\/\//i.test(url)))) return invalid;
  const fields: unknown[] = [];
  if (type === "greenhouse") fields.push(raw.content);
  else if (type === "ashby") fields.push(raw.descriptionPlain ?? raw.descriptionHtml);
  else if (type === "recruitee" || type === "workable") fields.push(raw.description);
  else if (type === "lever") {
    fields.push(raw.descriptionPlain ?? raw.description);
    if (raw.lists != null && !Array.isArray(raw.lists)) return invalid;
    for (const section of (raw.lists ?? []) as unknown[]) {
      if (!object(section) || typeof section.text !== "string" || typeof section.content !== "string") return invalid;
      fields.push(section.text, section.content);
    }
    if (raw.additionalPlain != null || raw.additional != null) fields.push(raw.additionalPlain ?? raw.additional);
  } else if (type === "smartrecruiters") {
    const sections = object(raw.jobAd) ? raw.jobAd.sections : null;
    if (!object(sections) || !Object.keys(sections).length) return invalid;
    for (const section of Object.values(sections)) {
      if (!object(section) || typeof section.text !== "string") return invalid;
      fields.push(section.text);
    }
  } else return invalid;
  if (!fields.length || fields.some(field => typeof field !== "string")) return invalid;
  const description = htmlToVisibleText((fields as string[]).join(" "));
  return description.trim() ? { description, bodySchemaValidated: true } : invalid;
}
