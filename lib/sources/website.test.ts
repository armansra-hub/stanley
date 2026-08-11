import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSiteSignals } from "./website";

afterEach(() => vi.unstubAllGlobals());

const posting = `
  <html><body><h1>Join our team</h1><p>We are hiring. Current openings.</p>
  <h2>Controller</h2><p>Full-time job description. Apply now.</p>
  <p>Responsibilities include close and reporting. Qualifications include seven years of experience.</p>
  <p>Benefits include medical, dental, and retirement. Submit your application today.</p>
  </body></html>
`;

function response(body: string, finalUrl: string): Response {
  const out = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(out, "url", { value: finalUrl });
  return out;
}

describe("website career evidence redirects", () => {
  it("uses a verified final careers URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.example/careers");
      return response("<html><body>Acme operating company.</body></html>", url);
    }));

    const scan = await fetchSiteSignals("acme.example", "Acme");
    expect(scan.financeRoles).toEqual([expect.objectContaining({ role: "Controller", url: "https://acme.example/careers" })]);
  });

  it("fails closed when /careers redirects to an unrelated page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.example/solutions/");
      return response("<html><body>Acme operating company.</body></html>", url);
    }));

    const scan = await fetchSiteSignals("acme.example", "Acme");
    expect(scan.financeRoles).toEqual([]);
  });
});
