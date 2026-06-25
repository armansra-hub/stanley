import { test, expect } from "vitest";
import { normalizeDomain, uniqueNormalizedDomains } from "./domain";

test("normalizeDomain strips scheme, www, path/query/fragment, lowercases", () => {
  expect(normalizeDomain("https://www.Acme.com/path?x=1#f")).toBe("acme.com");
  expect(normalizeDomain("HTTP://Foo.IO")).toBe("foo.io");
  expect(normalizeDomain("  www.Baz.org#frag ")).toBe("baz.org");
  expect(normalizeDomain("bar.com")).toBe("bar.com");
  expect(normalizeDomain("http://sub.domain.co.uk/a/b")).toBe("sub.domain.co.uk");
});

test("normalizeDomain handles empty / null safely", () => {
  expect(normalizeDomain("")).toBe("");
  expect(normalizeDomain(null)).toBe("");
  expect(normalizeDomain(undefined)).toBe("");
  expect(normalizeDomain("   ")).toBe("");
});

test("uniqueNormalizedDomains dedupes (case/scheme-insensitive) and preserves order", () => {
  const got = uniqueNormalizedDomains([
    "https://www.Acme.com",
    "http://acme.com/jobs",
    "Foo.io",
    "",
    "https://foo.io/",
    "bar.com",
  ]);
  expect(got).toEqual(["acme.com", "foo.io", "bar.com"]);
});
