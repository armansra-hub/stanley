import { afterEach, describe, expect, it, vi } from "vitest";
import { edgarSubmissionUrl, fetchEdgarFunding } from "./edgarFts";

afterEach(() => vi.unstubAllGlobals());

describe("SEC Form D evidence", () => {
  it("constructs an exact immutable filing URL", () => {
    expect(edgarSubmissionUrl("0001234567-26-000042", "0000123456")).toBe(
      "https://www.sec.gov/Archives/edgar/data/123456/000123456726000042/0001234567-26-000042.txt",
    );
    expect(edgarSubmissionUrl("0001234567-26-000042:primary_doc.xml", "CIK 0000123456")).toBe(
      "https://www.sec.gov/Archives/edgar/data/123456/000123456726000042/0001234567-26-000042.txt",
    );
    expect(edgarSubmissionUrl("not-an-accession", "123")).toBeNull();
  });

  it("returns the filer identity and exact filing evidence from EFTS", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      hits: { hits: [{
        _id: "0001234567-26-000042",
        _source: {
          display_names: ["Acme Services LLC (CIK 0000123456) (Filer)"],
          ciks: ["0000123456"],
          file_date: "2026-08-01",
          root_forms: ["D"],
        },
      }] },
    }), { status: 200 })));

    await expect(fetchEdgarFunding("Acme Services")).resolves.toEqual([{
      name: "Acme Services LLC (CIK 0000123456) (Filer)",
      date: "2026-08-01",
      form: "D",
      url: "https://www.sec.gov/Archives/edgar/data/123456/000123456726000042/0001234567-26-000042.txt",
    }]);
  });
});
