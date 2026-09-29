import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueObservation, evidenceSections, prepareObservation } from "./observations";
import { parseSharedFeed } from "./sharedSources";
import { sitePageEvidence } from "@/lib/sources/siteDiscovery";
import { fetchNewsItemsResult } from "@/lib/sources/googleNews";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { unicodePrefix } from "@/lib/textBounds";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: vi.fn() }));
const base = { companyId: "11111111-1111-4111-8111-111111111111", companyName: "Example Services", sourceKind: "news" as const,
  sourceUrl: "https://example.com/news/update", title: "Operating update", text: "A sourced public update." };
const pair = "\uD83D\uDE00";
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}
beforeEach(() => { vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true"); rpc.mockReset().mockResolvedValue({ data: { id: "observation", queued: true }, error: null }); vi.mocked(fetchPublicHttpText).mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe("Unicode-safe public observation boundaries", () => {
  it("keeps boundary-crossing characters intact in exact contiguous section spans", () => {
    const text = ("a".repeat(2999) + pair).repeat(15) + "z".repeat(2985);
    expect(text).toHaveLength(48000);
    const sections = evidenceSections(text);
    expect(sections).toHaveLength(16);
    expect(sections.map(section => section.text).join("")).toBe(text);
    for (const [index, section] of sections.entries()) {
      expect(section.start).toBe(index ? sections[index - 1].end : 0);
      expect(section.text).toBe(text.slice(section.start, section.end));
      expect(section.text.isWellFormed()).toBe(true);
    }
  });

  it("retains the full body when paragraph breaks exhaust the sixteen-section allowance", () => {
    const text = ("a".repeat(1999) + "\n").repeat(23) + "z".repeat(2000);
    const prepared = prepareObservation({ ...base, text });
    expect(prepared.sections).toHaveLength(16);
    expect(prepared.text).toBe(text);
    expect(prepared.sections.map(section => section.text).join("")).toBe(text);
    expect(prepared.sections.at(-1)?.end).toBe(text.length);
    for (const section of prepared.sections) expect(section.text).toBe(text.slice(section.start, section.end));
    expect(prepared.metadata.textTruncated).toBe(false);
  });

  it("keeps observation RPC strings valid while preserving full title provenance and exact body spans", async () => {
    const title = "t".repeat(499) + pair + " publisher title";
    const text = "a".repeat(2999) + pair + "b".repeat(44998) + pair + " clipped suffix";
    const prepared = prepareObservation({ ...base, title, text });
    expect(prepared.text).toBe(text.slice(0, 47999));
    expect(prepared.metadata.textTruncated).toBe(true);
    expect(prepared.metadata.retainedCharacters).toBe(47999);
    await enqueueObservation({ ...base, title, text });
    const payload = rpc.mock.calls[0][1];
    expect(payload.p_title).toBe("t".repeat(499));
    expect(payload.p_metadata.discovery).toMatchObject({ title, url: base.sourceUrl });
    expect(payload.p_metadata.companyName).toBe(base.companyName);
    expect(payload.p_sections.map((section: { text: string }) => section.text).join("")).toBe(payload.p_text);
    expect(strings(payload).every(value => value.isWellFormed())).toBe(true);
  });

  it("clips publisher bodies and titles at intact prefixes without changing source hashes", () => {
    const body = "a".repeat(23999) + pair + " suffix";
    const title = "t".repeat(299) + pair + " title suffix";
    const page = sitePageEvidence(`<title>${title}</title><article>${body}</article>`, base.sourceUrl);
    expect(page.text).toBe(body.slice(0, 23999));
    expect(page.title).toBe(title.slice(0, 299));
    expect(page.truncated).toBe(true);
    expect(page.contentHash).toBe(createHash("sha256").update(body).digest("hex"));
    expect(page.url).toBe(base.sourceUrl);
  });

  it("keeps Google feed snapshots valid before JSONB cursor persistence", async () => {
    const excerpt = "a".repeat(1999) + pair + " end";
    vi.mocked(fetchPublicHttpText).mockResolvedValue({ body: `<rss version="2.0"><channel><title>News</title><item><title>${excerpt}</title><description>${excerpt}</description><link>${base.sourceUrl}</link></item></channel></rss>`,
      status: 200, finalUrl: "https://news.google.com/rss/search", contentType: "application/rss+xml" });
    const result = await fetchNewsItemsResult("Example Services");
    expect(result.items[0]).toMatchObject({ source_url: base.sourceUrl, raw_excerpt: excerpt.slice(0, 1999), feed_excerpt: excerpt.slice(0, 1999) });
    expect(strings(result.cache).every(value => value.isWellFormed())).toBe(true);
  });

  it("keeps shared feed snapshot title/body bounds valid without discarding source identity", async () => {
    const title = "t".repeat(499) + pair + " suffix", body = "a".repeat(3999) + pair + " suffix";
    const [item] = await parseSharedFeed(`<rss version="2.0"><channel><title>News</title><item><title>${title}</title><description>${body}</description><link>${base.sourceUrl}</link></item></channel></rss>`, "https://example.com/feed");
    expect(item.payload).toMatchObject({ title: title.slice(0, 499), text: body.slice(0, 3999), url: base.sourceUrl });
    expect(strings(item).every(value => value.isWellFormed())).toBe(true);
  });

  it("preserves valid text hashes and does not silently repair malformed source characters", () => {
    const text = `An update ${pair} with a valid Unicode character.`, title = `News ${pair}`;
    const prepared = prepareObservation({ ...base, text, title });
    expect(prepared.contentHash).toBe(createHash("sha256").update(JSON.stringify([text, title, undefined,
      { companyName: base.companyName, companyDomain: null }])).digest("hex"));
    expect(unicodePrefix(`a${pair}b`, 3)).toBe(`a${pair}`);
    expect(unicodePrefix("NUL\u0000 and lone \uD800", 100)).toBe("NUL\u0000 and lone \uD800");
  });
});
