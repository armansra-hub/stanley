import { describe, it, expect } from "vitest";
import { fitWeightFor, parseTechnologies, isErpReady, parseEmployees, employeeBand } from "./baseImport";
import { importBlockReason } from "../config/territory";

describe("importBlockReason (hard blocks)", () => {
  it("blocks accounting / CPA / bookkeeping / tax", () => {
    expect(importBlockReason("Accounting", "Smith & Co")).toBe("accounting/tax firm");
    expect(importBlockReason("", "Bay Area CPAs LLP")).toBe("accounting/tax firm");
    expect(importBlockReason("Tax Preparation Services", "X")).toBe("accounting/tax firm");
  });
  it("does NOT block law firms (un-blocked 2026-07-02, AE decision)", () => {
    expect(importBlockReason("Legal Services", "X")).toBeNull();
    expect(importBlockReason("", "Jones Law Firm")).toBeNull();
    expect(importBlockReason("", "Cantor Law Group")).toBeNull();
  });
  it("blocks 3PLs and call centers", () => {
    expect(importBlockReason("Third-Party Logistics", "X")).toBe("3PL");
    expect(importBlockReason("", "Acme Order Fulfillment")).toBe("3PL");
    expect(importBlockReason("Call Center", "X")).toBe("call center");
  });
  it("KEEPS freight/logistics broadly (not a 3PL) and normal ICP", () => {
    expect(importBlockReason("Freight & Logistics Services", "Western Freight Lines")).toBeNull();
    expect(importBlockReason("Staffing & Recruiting", "Ridgeline Staffing")).toBeNull();
    expect(importBlockReason("Marketing Services", "Harbor Media")).toBeNull();
  });
});

describe("isErpReady (technographics)", () => {
  it("QuickBooks-tier + no real ERP → ready", () => {
    expect(isErpReady(parseTechnologies("QuickBooks Online; Salesforce; Slack"))).toBe(true);
    expect(isErpReady(["Xero", "HubSpot"])).toBe(true);
  });
  it("real ERP present → NOT ready", () => {
    expect(isErpReady(parseTechnologies("QuickBooks; NetSuite"))).toBe(false);
    expect(isErpReady(["Sage Intacct"])).toBe(false);
    expect(isErpReady(["Acumatica", "QuickBooks"])).toBe(false);
  });
  it("no accounting signal → not ready (unknown)", () => {
    expect(isErpReady(["Salesforce", "AWS"])).toBe(false);
    expect(isErpReady([])).toBe(false);
  });
});

describe("fitWeightFor (vendor weighting)", () => {
  it("NetSuite highest solo, multi-source boosted", () => {
    expect(fitWeightFor(["netsuite"])).toBe(1.1);
    expect(fitWeightFor(["zoominfo"])).toBe(1.0);
    expect(fitWeightFor(["linkedin"])).toBe(1.0);
    expect(fitWeightFor(["netsuite", "zoominfo"])).toBe(1.2);
    expect(fitWeightFor(["fmcsa"])).toBe(1.0); // non-vendor sources ignored → default
  });
});

describe("parseEmployees + employeeBand", () => {
  it("parses ranges and counts (low end of a range)", () => {
    expect(parseEmployees("51-200")).toBe(51);
    expect(parseEmployees("1,200")).toBe(1200);
    expect(parseEmployees("201 - 500 employees")).toBe(201);
    expect(parseEmployees("")).toBeNull();
  });
  it("bands", () => {
    expect(employeeBand(35)).toBe("20-49");
    expect(employeeBand(120)).toBe("50-199");
    expect(employeeBand(null)).toBeNull();
  });
});
