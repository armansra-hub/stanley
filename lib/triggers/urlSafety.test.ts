import { describe, expect, it, vi } from "vitest";

import {
  fetchPublicHttpText,
  isPublicHostname,
  isPublicIpAddress,
  resolvePublicAddresses,
  resolveSafeHttpRedirect,
  UnsafeHttpTargetError,
  validatePublicHttpUrl,
} from "./urlSafety";

describe("career-link URL safety", () => {
  it("accepts ordinary public IPv4 and IPv6 addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "localhost",
    "jobs.localhost",
    "metadata.internal",
    "printer.lan",
    "service.home.arpa",
    "company.example",
    "careers.test",
    "hidden.onion",
  ])("rejects reserved hostname %s", (hostname) => {
    expect(isPublicHostname(hostname)).toBe(false);
  });

  it("rejects unsafe URL forms before DNS", () => {
    expect(() => validatePublicHttpUrl("http://169.254.169.254/latest/meta-data")).toThrow(UnsafeHttpTargetError);
    expect(() => validatePublicHttpUrl("https://user:password@careers.acme.com/jobs")).toThrow(UnsafeHttpTargetError);
    expect(() => validatePublicHttpUrl("https://careers.acme.com:8443/jobs")).toThrow(UnsafeHttpTargetError);
    expect(() => validatePublicHttpUrl("file:///etc/passwd")).toThrow(UnsafeHttpTargetError);
    expect(validatePublicHttpUrl("https://careers.acme.com/jobs").hostname).toBe("careers.acme.com");
  });

  it.each([
    ["http://2130706433/", "127.0.0.1"], // decimal
    ["http://0x7f000001/", "127.0.0.1"], // hexadecimal
    ["http://0177.0.0.1/", "127.0.0.1"], // octal
    ["http://127.1/", "127.0.0.1"], // shortened
  ])("canonicalizes and rejects alternate loopback spelling %s", (rawUrl, canonicalHostname) => {
    expect(new URL(rawUrl).hostname).toBe(canonicalHostname);
    expect(() => validatePublicHttpUrl(rawUrl)).toThrow(UnsafeHttpTargetError);
  });

  it("requires every DNS answer to be public and deduplicates safe answers", async () => {
    const publicResolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "93.184.216.34", family: 4 as const },
      { address: "2001:4860:4860::8888", family: 6 as const },
    ]);
    await expect(resolvePublicAddresses("careers.acme.com", publicResolver)).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);

    const rebindingResolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);
    await expect(resolvePublicAddresses("careers.acme.com", rebindingResolver)).rejects.toBeInstanceOf(UnsafeHttpTargetError);
  });

  it("validates absolute and relative redirect targets before another hop", () => {
    const current = new URL("https://careers.acme.com/jobs");
    expect(resolveSafeHttpRedirect(current, "/jobs/123").toString()).toBe("https://careers.acme.com/jobs/123");
    expect(() => resolveSafeHttpRedirect(current, "http://127.0.0.1/admin")).toThrow(UnsafeHttpTargetError);
    expect(() => resolveSafeHttpRedirect(current, "http://metadata.internal/latest")).toThrow(UnsafeHttpTargetError);
  });

  it("rejects unsafe body-fetch targets before any request", async () => {
    await expect(fetchPublicHttpText("https://user:password@public.example/feed.xml"))
      .rejects.toBeInstanceOf(UnsafeHttpTargetError);
    await expect(fetchPublicHttpText("http://2130706433/latest/meta-data"))
      .rejects.toBeInstanceOf(UnsafeHttpTargetError);
    await expect(fetchPublicHttpText("https://news.example:8443/rss"))
      .rejects.toBeInstanceOf(UnsafeHttpTargetError);
  });

  it("rejects body fetches when DNS mixes public and private answers", async () => {
    const resolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "169.254.169.254", family: 4 as const },
    ]);
    await expect(fetchPublicHttpText("https://news.acme.com/rss", { resolver }))
      .rejects.toBeInstanceOf(UnsafeHttpTargetError);
  });
});
