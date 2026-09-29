import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => mocks.db }));
vi.mock("./customerReferenceData.json", () => ({ default: { references: [], asOf: "2026-09-28" } }));
import { normalizeCustomerReferenceImport, loadCustomerReferenceRegistry, customerReferencePublicUrl, loadCustomerReferencePartialRows,
  type CustomerReferenceRegistryRow } from "./customerReferenceRegistry";
const row = (id = "customer") => ({ id, name: "Customer", domain: "customer.example.com", website: "https://customer.example.com/",
  announcementDate: "2024-01-02", announcementType: "renewal", asOf: "2026-09-28",
  announcements: [{ id: "message", date: "2024-01-02", type: "renewal", sourceUrl: "https://workspace.slack.com/archives/channel/message" }], candidateUrls: [] });
beforeEach(() => { mocks.db.rpc.mockReset(); mocks.db.from.mockReturnValue({ select: () => ({ in: async () => ({ data: [], error: null }) }) }); });
describe("private customer registry boundary", () => {
  it("keeps renewal announcements and unresolved identity accounting", () => {
    const records = normalizeCustomerReferenceImport({ records: [{ ...row(), domain: null, website: null, name: "Unresolved announcement 123" }] });
    expect(records[0]).toMatchObject({ domain: null, website: null, announcementType: "renewal" });
    expect(records[0].announcements).toHaveLength(1);
  });
  it("requires exact audited aliases and keeps different same-host entities separate", () => {
    const records = normalizeCustomerReferenceImport({ records: [row("a"), { ...row("b"), existingReferenceId: "legacy" }] });
    expect(records).toHaveLength(2); expect(records[1].existingReferenceId).toBe("legacy");
    expect(() => normalizeCustomerReferenceImport({ records: [row("a"), { ...row("b"), existingReferenceId: "a" }] })).toThrow();
  });
  it("rejects invalid dates, duplicate announcement IDs, mismatched hosts and unsafe addresses", () => {
    for (const changed of [{ announcementDate: "2026-02-31" }, { announcementDate: "2023-12-31" }, { website: "https://other.example.com/" },
      { domain: "127.0.0.1", website: "http://127.0.0.1/" }, { candidateUrls: ["http://localhost/secrets"] },
      { announcements: [row().announcements[0], row().announcements[0]] }])
      expect(() => normalizeCustomerReferenceImport({ records: [{ ...row(), ...changed }] })).toThrow("invalid_registry_record:0");
    expect(customerReferencePublicUrl("https://user:pass@example.com/")).toBeNull();
  });
  it("rejects source bodies or native answers as top-level import actions", () => {
    expect(() => normalizeCustomerReferenceImport({ records: [row()], sources: [] })).toThrow();
    const imported = normalizeCustomerReferenceImport({ records: [{ ...row(), sources: [{ text: "Not an official capture" }], status: "complete" }] });
    expect(imported[0]).not.toHaveProperty("sources"); expect(imported[0]).not.toHaveProperty("status");
  });
  it("loads all pages beyond1000 without a hidden sample cap", async () => {
    mocks.db.rpc.mockImplementation(async (_name, args) => {
      const start = args.p_after ? Number(args.p_after) + 1 : 0;
      return { data: Array.from({ length: Math.min(250, 1003 - start) }, (_, i) => ({ id: String(start + i).padStart(5, "0") })), error: null };
    });
    const records = await loadCustomerReferenceRegistry();
    expect(records).toHaveLength(1003); expect(records.at(-1)?.id).toBe("01002");
    expect(mocks.db.rpc).toHaveBeenCalledTimes(5);
  });
  it("reads every eligible partial answer beyond1000 without loading pending bodies or completed native results", async () => {
    const ids: string[] = [], selections: string[] = [];
    const db = { from: vi.fn(() => ({ select: (selection: string) => {
      selections.push(selection); return { in: async (_column: string, batch: string[]) => {
        ids.push(...batch); expect(batch.length).toBeLessThanOrEqual(40);
        return { data: batch.map(id => ({ id, checkpoint_answers: { rr_c01: { nativeResult: { original: id } } } })), error: null };
      } };
    } })) };
    const rows = Array.from({ length: 1003 }, (_, i) => ({ id: `partial-${i}`, source_status: "ready", native_status: "blocked", native_answered: 46 } as CustomerReferenceRegistryRow));
    rows.push({ id: "complete", source_status: "ready", native_status: "complete", native_answered: 47 } as CustomerReferenceRegistryRow);
    rows.push({ id: "no-answers", source_status: "ready", native_status: "pending", native_answered: 0 } as CustomerReferenceRegistryRow);
    const found = await loadCustomerReferencePartialRows(rows, db as never);
    expect(found).toHaveLength(1003); expect(new Set(ids).size).toBe(1003); expect(ids).not.toContain("complete");
    expect(selections.every(s => s.includes("checkpoint_answers:checkpoint->answers") && !s.split(",").includes("checkpoint") && !s.includes("result"))).toBe(true);
  });
});
