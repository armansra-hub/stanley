import { test, expect } from "vitest";
import { buildNetsuiteSqlExport, normalizeName } from "./sql";

test("URL chunk produces the exact NetSuite Formula (Numeric) shape", () => {
  const { chunks } = buildNetsuiteSqlExport([{ website: "https://www.Acme.com/x" }, { website: "Foo.io" }]);
  const url = chunks.filter((c) => c.kind === "url");
  expect(url.length).toBe(1);
  expect(url[0].formula).toBe(
    "CASE WHEN INSTR('|acme.com|foo.io|', '|' || " +
      "REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(NVL({url}, ''))), " +
      "'^https?://', ''), '^www\\.', ''), '[/?#].*$', '') || '|') > 0 THEN 1 ELSE 0 END",
  );
});

test("matches on BOTH website and name (separate chunks)", () => {
  const { domains, names, chunks } = buildNetsuiteSqlExport([
    { name: "Tiny Books, LLC", website: "tinybooks.com" },
    { name: "Acme Logistics Inc.", website: "acme.com" },
  ]);
  expect(domains).toEqual(["tinybooks.com", "acme.com"]);
  expect(names).toEqual(["tinybooks", "acmelogistics"]);
  expect(chunks.some((c) => c.kind === "url")).toBe(true);
  expect(chunks.some((c) => c.kind === "name")).toBe(true);
});

test("normalizeName strips punctuation, legal suffix, and spaces", () => {
  expect(normalizeName("Tiny Books, LLC")).toBe("tinybooks");
  expect(normalizeName("Acme Logistics Inc.")).toBe("acmelogistics");
  expect(normalizeName("The Smith Group")).toBe("thesmith");
});

test("chunks at chunkSize and preserves dedupe/order across chunks", () => {
  const companies = Array.from({ length: 41 }, (_, i) => ({ website: `co${i}.com` }));
  const { domains, chunks } = buildNetsuiteSqlExport(companies, { chunkSize: 40 });
  expect(domains.length).toBe(41);
  const url = chunks.filter((c) => c.kind === "url");
  expect(url.length).toBe(2);
  expect(url[0].values.length).toBe(40);
  expect(url[1].values[0]).toBe("co40.com");
});

test("dedupes normalized domains before chunking", () => {
  const { domains } = buildNetsuiteSqlExport([
    { website: "https://www.acme.com" },
    { website: "http://acme.com/careers" },
    { website: "acme.com" },
  ]);
  expect(domains).toEqual(["acme.com"]);
});

test("fields, stage, salesRep are configurable and appear in output", () => {
  const { chunks, text } = buildNetsuiteSqlExport([{ website: "acme.com", name: "Acme" }], {
    urlField: "{custentity_web}",
    stage: "Prospect",
    salesRep: "Unassigned",
  });
  expect(chunks.find((c) => c.kind === "url")?.formula).toContain("NVL({custentity_web}, '')");
  expect(text).toContain("Stage = Prospect");
  expect(text).toContain("Sales Rep = Unassigned");
  expect(text).toContain('condition is "is 1"');
});

test("empty input yields zero chunks", () => {
  const { domains, names, chunks } = buildNetsuiteSqlExport([{ website: "" }, { website: "   " }, { name: "" }]);
  expect(domains.length).toBe(0);
  expect(names.length).toBe(0);
  expect(chunks.length).toBe(0);
});
