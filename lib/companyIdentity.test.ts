import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { buildCompanyIdentityContext, isCompanyIdentitySource, parseNetSuiteIdentityHeader } from "./companyIdentity";

const source = { id: "record-1", capturedAt: "2026-07-28T00:00:00Z" };
const header = "Company Name Example Magazine\nWeb Address https://example.test\n\nAddress Example Media, Inc.\n5100 Eden Ave Ste 107\nMinneapolis MN 554362333\nUnited States\n\nPrimary Currency USD\nFirmographic Information\nResearch Notes Private note";
const company = { id: "company-1", name: "Example Magazine", domain: "example.test", state: "MN" };

describe("sourced business identity", () => {
  it("extracts a labelled US business address and its sourced legal addressee", () => {
    expect(parseNetSuiteIdentityHeader(header, source)).toEqual({ aliases: ["Example Media, Inc."], addresses: [{ addressLine1: "5100 Eden Ave Ste 107", city: "Minneapolis", state: "MN", postalCode: "554362333", countryCode: "US", sourceKind: "netsuite_record", sourceId: "record-1", capturedAt: source.capturedAt }] });
  });
  it("does not use an event invitation or note address when the account address is absent", () => {
    const result = parseNetSuiteIdentityHeader("Company Name Example\nFirmographic Information\nResearch Notes\nAddress Hotel Inc.\n123 Main St\nDenver CO 80202\nUnited States", source);
    expect(result.addresses).toEqual([]);
  });
  it("leaves incomplete addresses unknown and never treats a person as a legal alias", () => {
    expect(parseNetSuiteIdentityHeader("Address Person Name\n123 Main St\nUnited States", source).addresses).toEqual([]);
    const parsed = parseNetSuiteIdentityHeader("Address Person Name\n123 Main St\nDenver CO 80202\nUnited States", source);
    expect(parsed.aliases).toEqual([]); expect(parsed.addresses).toHaveLength(1);
  });
  it("keeps Canadian postal and country evidence", () => {
    expect(parseNetSuiteIdentityHeader("Address Example Inc.\n42 King St\nSuite 100\nToronto ON M5H 1J9\nCanada", source).addresses[0]).toMatchObject({ addressLine1: "42 King St Suite 100", city: "Toronto", state: "ON", postalCode: "M5H 1J9", countryCode: "CA" });
  });
  it("does not admit another publisher or another entity on a shared site", () => {
    const make = (url: string, name: string) => ({ id: "page", url, capturedAt: source.capturedAt, identity: { names: [name], addresses: [{ addressLine1: "1 Broadway", city: "New York" }] } });
    expect(buildCompanyIdentityContext(company, { websites: [make("https://news.test/story", company.name), make("https://example.test/group", "Other Subsidiary Inc.")] }).addresses).toEqual([]);
    expect(isCompanyIdentitySource("https://example.test.evil.test", company.domain)).toBe(false);
  });
  it("combines company-name-bound website addresses with exact record identity but omits private record text", () => {
    const context = buildCompanyIdentityContext(company, { record: { ...source, header }, websites: [{ id: "page", url: "https://www.example.test/contact", capturedAt: "2026-09-19", identity: { names: ["Example Media, Inc."], addresses: [{ addressLine1: "6100 Eden Ave", city: "Minneapolis", state: "MN", postalCode: "55436", countryCode: "US" }] } }] });
    expect(context.addresses).toHaveLength(2); expect(context.context).toContain("record-1"); expect(context.context).not.toContain("Private note");
    expect(context.aliases).toEqual(["Example Media, Inc."]);
  });
  it("bounds serialized context without breaking JSON", () => {
    const context = buildCompanyIdentityContext(company, { websites: Array.from({ length: 8 }, (_, i) => ({ id: `page-${i}`, url: `https://example.test/contact-${i}`, capturedAt: source.capturedAt, identity: { names: [company.name], addresses: [{ addressLine1: `${i} ${"a".repeat(170)}`, city: "b".repeat(170), state: "CA", postalCode: "90001", countryCode: "US" }] } })) });
    expect(Buffer.byteLength(context.context)).toBeLessThanOrEqual(3600); expect(JSON.parse(context.context).addresses.length).toBeGreaterThan(0);
  });
});
