import { test, expect } from "vitest";
import { buildCsvExport } from "./csv";

test("default headers + full website, with CSV escaping", () => {
  const csv = buildCsvExport([
    { name: "Acme, Inc.", website_raw: "https://www.acme.com" },
    { name: 'Quote "Co"', website_raw: "http://quote.io" },
  ]);
  const lines = csv.split("\r\n");
  expect(lines[0]).toBe("Company Name,Company URL");
  expect(lines[1]).toBe('"Acme, Inc.",https://www.acme.com');
  expect(lines[2]).toBe('"Quote ""Co""",http://quote.io');
});

test("domain mode emits bare normalized domain, deriving it when absent", () => {
  const csv = buildCsvExport(
    [{ name: "Acme", website_raw: "https://www.acme.com/jobs" }],
    { urlMode: "domain" },
  );
  expect(csv.split("\r\n")[1]).toBe("Acme,acme.com");
});

test("custom headers are honored", () => {
  const csv = buildCsvExport([{ name: "Acme", website_raw: "acme.com" }], {
    headers: ["company name", "company url"],
  });
  expect(csv.split("\r\n")[0]).toBe("company name,company url");
});
