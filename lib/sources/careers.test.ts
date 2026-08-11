import { describe, expect, it } from "vitest";
import { isRealCareersPage, scanFinanceRoles } from "./careers";

const realPosting = `
  Join our team. We are hiring. Current openings. Apply now.
  Controller — full-time. Job description: own the monthly close and reporting.
  Responsibilities include leading the accounting team and financial controls.
  Qualifications include seven years of experience. Benefits include health care.
`;

describe("careers-page proof", () => {
  it("requires a genuine job page before emitting a role", () => {
    expect(isRealCareersPage(realPosting)).toBe(true);
    expect(scanFinanceRoles(realPosting).map((hit) => hit.role)).toContain("Controller");
  });

  it("rejects a soft-404 document that is the homepage", () => {
    expect(scanFinanceRoles(realPosting, { homeText: realPosting })).toEqual([]);
  });

  it("rejects finance-service copy even when surrounded by job-page markers", () => {
    const serviceCopy = `${realPosting} We offer outsourced CFO services and bookkeeping packages to our clients. `.repeat(2);
    expect(scanFinanceRoles(serviceCopy).some((hit) => hit.role === "CFO")).toBe(false);
  });
});
