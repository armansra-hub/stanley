import { test, expect } from "vitest";
import { buildNetsuiteSqlExport } from "./sql";

test("single chunk produces the exact NetSuite Formula (Numeric) shape", () => {
  const { chunks } = buildNetsuiteSqlExport(["https://www.Acme.com/x", "Foo.io"]);
  expect(chunks.length).toBe(1);
  expect(chunks[0].formula).toBe(
    "CASE WHEN INSTR('|acme.com|foo.io|', '|' || " +
      "REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(NVL({url}, ''))), " +
      "'^https?://', ''), '^www\\.', ''), '[/?#].*$', '') || '|') > 0 THEN 1 ELSE 0 END",
  );
});

test("chunks at chunkSize and preserves dedupe/order across chunks", () => {
  const urls = Array.from({ length: 41 }, (_, i) => `co${i}.com`);
  const { domains, chunks } = buildNetsuiteSqlExport(urls, { chunkSize: 40 });
  expect(domains.length).toBe(41);
  expect(chunks.length).toBe(2);
  expect(chunks[0].domains.length).toBe(40);
  expect(chunks[1].domains.length).toBe(1);
  expect(chunks[1].domains[0]).toBe("co40.com");
});

test("dedupes normalized domains before chunking", () => {
  const { domains } = buildNetsuiteSqlExport([
    "https://www.acme.com",
    "http://acme.com/careers",
    "acme.com",
  ]);
  expect(domains).toEqual(["acme.com"]);
});

test("urlField, stage, salesRep are configurable and appear in output", () => {
  const { chunks, text } = buildNetsuiteSqlExport(["acme.com"], {
    urlField: "{custentity_web}",
    stage: "Prospect",
    salesRep: "Unassigned",
  });
  expect(chunks[0].formula).toContain("NVL({custentity_web}, '')");
  expect(text).toContain("Stage = Prospect");
  expect(text).toContain("Sales Rep = Unassigned");
  expect(text).toContain('condition is "is 1"');
});

test("empty input yields zero chunks", () => {
  const { domains, chunks } = buildNetsuiteSqlExport(["", "   ", null]);
  expect(domains.length).toBe(0);
  expect(chunks.length).toBe(0);
});
