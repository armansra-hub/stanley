import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { fetchSiteSignals } from "./website";

vi.mock("@/lib/triggers/urlSafety", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(),
  fetchPublicHttpText: vi.fn(),
}));

const guardedFetch = vi.mocked(fetchPublicHttpText);

afterEach(() => vi.clearAllMocks());

const posting = `
  <html><body><h1>Join our team</h1><p>We are hiring. Current openings.</p>
  <h2>Controller</h2><p>Full-time job description. Apply now.</p>
  <p>Responsibilities include close and reporting. Qualifications include seven years of experience.</p>
  <p>Benefits include medical, dental, and retirement. Submit your application today.</p>
  </body></html>
`;

function response(body: string, finalUrl: string) {
  return { body, finalUrl, status: 200, contentType: "text/html" };
}

describe("website career evidence redirects", () => {
  it("uses a verified final careers URL", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.example/careers");
      return response("<html><body>Acme operating company.</body></html>", url);
    });

    const scan = await fetchSiteSignals("acme.example", "Acme");
    expect(scan.financeRoles).toEqual([expect.objectContaining({ role: "Controller", url: "https://acme.example/careers" })]);
  });

  it("fails closed when /careers redirects to an unrelated page", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.example/solutions/");
      return response("<html><body>Acme operating company.</body></html>", url);
    });

    const scan = await fetchSiteSignals("acme.example", "Acme");
    expect(scan.financeRoles).toEqual([]);
  });

  it("routes every company-derived page through the DNS-pinned public fetch", async () => {
    guardedFetch.mockResolvedValue(response("<html><body>Acme</body></html>", "https://acme.com/"));

    await fetchSiteSignals("acme.com", "Acme");

    expect(guardedFetch).toHaveBeenCalledTimes(5);
    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://acme.com",
      "https://acme.com/about",
      "https://acme.com/news",
      "https://acme.com/careers",
      "https://acme.com/jobs",
    ]);
  });

  it("fails closed when the public-target guard rejects a company-derived URL", async () => {
    guardedFetch.mockRejectedValue(new Error("unsafe HTTP target"));
    const scan = await fetchSiteSignals("user:pass@127.0.0.1:8080", "Unsafe");

    expect(scan).toEqual({ growth: [], parent: null, feedUrl: null, financeRoles: [] });
    expect(guardedFetch).toHaveBeenCalled();
  });
});
