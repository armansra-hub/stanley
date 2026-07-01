import { describe, it, expect } from "vitest";
import { parseCsv, rowsToBaseRows } from "./csv";

// Real ZoomInfo export header shape (Location = "City, State", compound Industry).
const ZOOMINFO = `Company Name,Location,Industry,Employees,Revenue,Website,Last Touch
Artisan Creative,"Los Angeles, California","HR & Staffing, Business Services",11 - 50,$10M,www.artisancreative.com,None
Mannapov,"Boerne, Texas","Freight & Logistics Services, Transportation",51 - 200,$10M,www.mannapovllc.com,None`;

// Real NetSuite export header shape (WEB ADDRESS, BILLING STATE/PROVINCE, a "Duplicate" junk row).
const NETSUITE = `COMPANY NAME,WEB ADDRESS,ANNUAL REVENUE,BILLING STATE/PROVINCE,INDUSTRY
SIMC LLC,http://simcllc.com,$1M to $2M,TX,Business Services
Duplicate,http://www.duplicate.com,$2M to $5M,TX,Advertising`;

describe("rowsToBaseRows — ZoomInfo", () => {
  const rows = rowsToBaseRows(parseCsv(ZOOMINFO));
  it("maps name/website/industry/employees and parses state from Location", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Artisan Creative", website: "www.artisancreative.com", industry: "HR & Staffing, Business Services", employees: "11 - 50", state: "CA", city: "Los Angeles" });
    expect(rows[1]).toMatchObject({ name: "Mannapov", state: "TX", city: "Boerne" });
  });
});

describe("rowsToBaseRows — NetSuite", () => {
  const rows = rowsToBaseRows(parseCsv(NETSUITE));
  it("maps WEB ADDRESS + BILLING STATE and skips the 'Duplicate' placeholder", () => {
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "SIMC LLC", website: "http://simcllc.com", state: "TX" });
  });
});
