import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteText } from "./registryWebsiteText";
import { RegistryWebsiteMismatchError, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const now = new Date("2026-10-01T00:00:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" }, context = { aliases: [], addresses: [], context: "PRIVATE CRM CONTEXT" };
const good = "<footer>Acme Inc 123 Main Street Suite 4 Austin TX 78701</footer>";
function item() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), sourceRow, quote: evidence } } }, now);
}
function proof(overrides: Partial<RegistryWebsiteCorroboration> = {}) {
  const { legalName, ...address } = identity, quote = registryWebsiteText(good);
  const data = { sourceUrl: "https://acme.com/", quote, quoteSha256: sha(quote), normalizedVisibleTextSha256: sha(quote), subject: legalName, address, ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item(), data);
  return { ...data, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string, finalUrl = "https://acme.com/") => ({ status: 200, body, finalUrl, contentType: "text/html" });
async function failure(html: string, p = proof()) {
  fetch.mockResolvedValueOnce(page(html));
  const error = await registryWebsiteVerifier()(item(), p, company, context, now).catch(x => x);
  expect(error).toBeInstanceOf(RegistryWebsiteMismatchError);
  return error as RegistryWebsiteMismatchError;
}
beforeEach(() => { fetch.mockReset(); vi.unstubAllEnvs(); });

describe("exact failed website response evidence", () => {
  it("retains the actual complete HTML and normalized text when unrelated visible text changes", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    const html = good + "<p>New announcement &amp; café</p>", p = proof(), error = await failure(html, p), d = error.diagnostic;
    expect(error.message).toBe("registry website changed or exact reviewed quote missing");
    expect(d).toMatchObject({ schema: "registry_website_mismatch_v1", sourceUrl: p.sourceUrl, finalUrl: p.sourceUrl, normalization: "legacy_html_to_visible_text", deploymentCommit: "a".repeat(40), expectedNormalizedVisibleTextSha256: p.normalizedVisibleTextSha256, observedNormalizedVisibleTextSha256: sha(registryWebsiteText(html)), htmlSha256: sha(html), htmlUtf8Bytes: Buffer.byteLength(html), normalizedCharacters: registryWebsiteText(html).length, quotePresent: true, quoteStart: 0, snapshot: { complete: true, rawHtml: html, normalizedText: registryWebsiteText(html) } });
    expect(Number.isFinite(Date.parse(d.fetchedAt))).toBe(true);
    expect(JSON.stringify(d)).not.toContain("PRIVATE CRM CONTEXT");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(p.sourceUrl, expect.objectContaining({ maxBytes: 2_000_000, maxRedirects: 2 }));
  });
  it.each(["123 Main Street", "Suite 4", "Acme Inc"])("still rejects changed identity content: %s", async token => {
    const error = await failure(good.replace(token, "Different value"));
    expect(error.diagnostic.quotePresent).toBe(false); expect(error.diagnostic.quoteStart).toBe(-1);
    expect(error.diagnostic.snapshot.complete).toBe(true);
  });
  it("distinguishes an absent quote even when the expected full-page hash equals the observed hash", async () => {
    const html = good.replace("Suite 4", "Suite 5"), error = await failure(html, proof({ normalizedVisibleTextSha256: sha(registryWebsiteText(html)) }));
    expect(error.diagnostic.expectedNormalizedVisibleTextSha256).toBe(error.diagnostic.observedNormalizedVisibleTextSha256);
    expect(error.diagnostic.quotePresent).toBe(false);
  });
  it.each(["gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2"] as const)("records the actual attested normalizer without changing it: %s", async normalization => {
    const error = await failure(good + " changed", proof({ normalization }));
    expect(error.diagnostic.normalization).toBe(normalization);
    expect(error.diagnostic.observedNormalizedVisibleTextSha256).toBe(sha(registryWebsiteText(good + " changed", normalization)));
  });
  it("caps serialized UTF-8 evidence, including escaped characters, and never supplies a partial body", async () => {
    const html = good + "\\".repeat(550_000); // Each body is below the existing fetch cap; JSON escaping doubles it.
    const d = (await failure(html)).diagnostic;
    expect(d.htmlUtf8Bytes).toBeLessThan(2_000_000);
    expect(d.snapshot).toEqual({ complete: false, omittedReason: "serialized_diagnostic_exceeds_byte_cap" });
    expect(d.htmlSha256).toBe(sha(html)); expect(d.normalizedCharacters).toBe(registryWebsiteText(html).length);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(d.diagnosticByteCap);
  });
  it("does not expose invalid deployment environment values", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "not-a-commit-or-safe-metadata");
    expect((await failure(good + " changed")).diagnostic.deploymentCommit).toBeNull();
  });
  it("keeps exact matching evidence on the unchanged success path", async () => {
    fetch.mockResolvedValueOnce(page(good));
    const result = await registryWebsiteVerifier()(item(), proof(), company, context, now);
    expect(result.method).toBe("official_website_corroboration"); expect(result).not.toHaveProperty("diagnostic");
  });
  it("does not attach a public snapshot when domain safety or fetching fails", async () => {
    fetch.mockResolvedValueOnce(page("unrelated body", "https://other.com/"));
    const wrongHost = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(wrongHost).not.toBeInstanceOf(RegistryWebsiteMismatchError);
    fetch.mockRejectedValueOnce(new Error("transport private error"));
    const unavailable = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(unavailable.message).toBe("registry website source unavailable"); expect(unavailable).not.toHaveProperty("diagnostic");
  });
});
