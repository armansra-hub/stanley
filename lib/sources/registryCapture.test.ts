import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCarrierByName } from "./fmcsa";
import { fetchNewCoEntities, fetchRecentUccFilings } from "./coSos";
vi.mock("@/lib/db/companies", () => ({ getTerritoryConfig: vi.fn() }));
vi.mock("@/lib/db/fmcsa", () => ({ getFmcsaSnapshot: vi.fn(), upsertFmcsaSnapshot: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("strict registry source capture", () => {
  it("retains original registry identities, nulls, query URLs and UCC joins for independent review", async () => {
    const captured = vi.fn();
    const carrier = { dot_number: "123", legal_name: "Acme Logistics", nbr_power_unit: "10", driver_total: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([carrier])));
    await fetchCarrierByName("Acme Logistics", 5, { strict: true, onCapture: captured });
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: expect.stringContaining("kjg3-diqy.json?"), rows: [carrier] }));
    captured.mockClear();
    const debtor = { organizationname: "Acme Logistics", city: "Denver", fileid: "F1" };
    const filing = { fileid: "F1", filingdate: "2026-09-01", documenttype: "UCC financing statement" };
    const party = { fileid: "F1", organizationname: "Bank" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json([debtor])).mockResolvedValueOnce(Response.json([filing])).mockResolvedValueOnce(Response.json([party])));
    await fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true, onCapture: captured });
    expect(captured.mock.calls.map(([capture]) => ({ table: capture.table, rows: capture.rows }))).toEqual([
      { table: "debtor", rows: [debtor] }, { table: "filing", rows: [filing] }, { table: "party", rows: [party] },
    ]);
  });

  it("retains a malformed object row as evidence without certifying successful source capture", async () => {
    const captured = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ error: "upstreamchanged" }])));
    await expect(fetchCarrierByName("Acme Logistics", 5, { strict: true, onCapture: captured })).rejects.toThrow("invalid record");
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ rows: [{ error: "upstreamchanged" }] }));
  });

  it("retains backward-compatible empty failures while strict callers see HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
    expect(await fetchCarrierByName("Acme Logistics")).toEqual([]);
    await expect(fetchCarrierByName("Acme Logistics", 5, { strict: true })).rejects.toThrow("HTTP 503");
    expect(await fetchNewCoEntities("ACME LOGISTICS", "2026-01-01")).toEqual([]);
    await expect(fetchNewCoEntities("ACME LOGISTICS", "2026-01-01", 10, { strict: true })).rejects.toThrow("HTTP 503");
    await expect(fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).rejects.toThrow("HTTP 503");
  });

  it("does not call invalid response shapes empty successful source results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not records" })));
    await expect(fetchCarrierByName("Acme Logistics", 5, { strict: true })).rejects.toThrow("invalid response");
    await expect(fetchNewCoEntities("ACME LOGISTICS", "2026-01-01", 10, { strict: true })).rejects.toThrow("invalid response");
    await expect(fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).rejects.toThrow("invalid response");
  });

  it("reports full result pages as incomplete while retaining their returned records", async () => {
    const truncated = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ dot_number: "1", legal_name: "Acme Logistics", nbr_power_unit: "4" }])));
    expect(await fetchCarrierByName("Acme Logistics", 1, { strict: true, onTruncated: truncated })).toHaveLength(1);
    expect(truncated).toHaveBeenCalledOnce();
    truncated.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ entityname: "Acme Logistics West", entityid: "1", entityformdate: "2026-09-01T00:00:00" }])));
    expect(await fetchNewCoEntities("ACME LOGISTICS", "2026-01-01", 1, { strict: true, onTruncated: truncated })).toHaveLength(1);
    expect(truncated).toHaveBeenCalledOnce();
  });

  it("propagates a UCC join failure after valid debtor capture", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([{ organizationname: "Acme Logistics", city: "Denver", fileid: "F1" }]))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).rejects.toThrow("HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { error: "upstreamchanged" },
    { dot_number: "", legal_name: "Acme Logistics" },
    { dot_number: "123", legal_name: " " },
    { dot_number: "123", dba_name: [] },
    { dot_number: "123", legal_name: "Acme Logistics", nbr_power_unit: true },
    { dot_number: "123", legal_name: "Acme Logistics", driver_total: "unknown" },
    { dot_number: "123", legal_name: "Acme Logistics", driver_total: {} },
    { dot_number: "123", legal_name: "Acme Logistics", phy_city: 123 },
  ])("rejects invalid FMCSA record identity or selected field: %j", async row => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([row])));
    await expect(fetchCarrierByName("Acme Logistics", 5, { strict: true })).rejects.toThrow("invalid record");
  });

  it("preserves legitimate nullable FMCSA metrics instead of inventing zeros", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ dot_number: "123", dba_name: "Acme Logistics", legal_name: null,
      nbr_power_unit: null, driver_total: null, phy_city: null }])));
    expect(await fetchCarrierByName("Acme Logistics", 5, { strict: true })).toMatchObject([{ dot: "123", units: null, drivers: null }]);
  });

  it.each([
    { error: "upstreamchanged" },
    { entityid: "", entityname: "Acme Logistics", entityformdate: "2026-09-01" },
    { entityid: "1", entityname: " ", entityformdate: "2026-09-01" },
    { entityid: "1", entityname: "Acme Logistics" },
    { entityid: "1", entityname: "Acme Logistics", entityformdate: "2026-02-30" },
    { entityid: "1", entityname: "Acme Logistics", entityformdate: "unknown" },
    { entityid: "1", entityname: "Acme Logistics", entityformdate: "2026-09-01", principalcity: [] },
  ])("rejects invalid Colorado entity identity or date: %j", async row => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([row])));
    await expect(fetchNewCoEntities("ACME LOGISTICS", "2026-01-01", 10, { strict: true })).rejects.toThrow("invalid record");
  });

  it.each([
    { table: "debtor", row: { error: "upstreamchanged" } },
    { table: "debtor", row: { fileid: "", organizationname: "Acme Logistics" } },
    { table: "debtor", row: { fileid: "F1", organizationname: " " } },
    { table: "debtor", row: { fileid: "F1", organizationname: "Acme Logistics", city: {} } },
    { table: "filing", row: { error: "upstreamchanged" } },
    { table: "filing", row: { fileid: "F1", documenttype: "UCC financing statement" } },
    { table: "filing", row: { fileid: "F1", filingdate: "2026-09-01", documenttype: false } },
    { table: "filing", row: { fileid: "F1", filingdate: "2026-02-30", documenttype: "UCC financing statement" } },
    { table: "party", row: { error: "upstreamchanged" } },
    { table: "party", row: { fileid: "", organizationname: "Lender" } },
    { table: "party", row: { fileid: "F1", organizationname: " " } },
  ])("rejects malformed UCC $table records without returning an empty successful join", async ({ table, row }) => {
    const debtor = { organizationname: "Acme Logistics", fileid: "F1", city: null };
    const filing = { fileid: "F1", filingdate: "2026-09-01T00:00:00", documenttype: "UCC financing statement" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([table === "debtor" ? row : debtor]));
    if (table !== "debtor") fetch.mockResolvedValueOnce(Response.json([table === "filing" ? row : filing]));
    if (table === "party") fetch.mockResolvedValueOnce(Response.json([row]));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).rejects.toThrow("invalid record");
  });

  it("preserves complete valid UCC attribution and rejects a join outside requested debtor identities", async () => {
    const debtor = { organizationname: "Acme Logistics", fileid: "F1", city: null };
    const filing = { fileid: "F1", filingdate: "2026-09-01T00:00:00", documenttype: "UCC financing statement" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([debtor])).mockResolvedValueOnce(Response.json([filing]))
      .mockResolvedValueOnce(Response.json([{ fileid: "F1", organizationname: "Lender" }]))
      .mockResolvedValueOnce(Response.json([debtor])).mockResolvedValueOnce(Response.json([{ ...filing, fileid: "unrelated" }]));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).toEqual([{ filed: filing.filingdate,
      docType: filing.documenttype, debtorAsFiled: debtor.organizationname, debtorCity: "", securedParty: "Lender" }]);
    await expect(fetchRecentUccFilings("Acme Logistics", "2026-01-01", { strict: true })).rejects.toThrow("unrelated identity");
  });
});
