/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, vi } from "vitest";
import { runFederalReviewedProgressionChecks } from "../../scripts/validate-federal-reviewed-progression-sql.mjs";
const ref = vi.hoisted(() => ({ db: null as any, trace: [] as string[], hideCursorHash: false }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (!["acquire_public_growth_sweep_lease", "fail_public_growth_sweep_lease", "inspect_federal_reviewed_capture", "consume_federal_reviewed_capture"].includes(name)) throw new Error(`Forbidden RPC ${name}`);
    ref.trace.push(name);
    try {
      const keys = Object.keys(args);
      const result = await ref.db.query(`select ${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) value`, Object.values(args));
      const data = JSON.parse(JSON.stringify(result.rows[0].value));
      if (name === "inspect_federal_reviewed_capture" && ref.hideCursorHash) delete data.cursorSha256;
      return { data, error: null };
    } catch (error) { return { data: null, error: { message: String(error) } }; }
  },
  from: (table: string) => {
    if (table !== "app_events") throw new Error(`Forbidden table ${table}`);
    let columns: string, id: string;
    const q: any = { select: (value: string) => { columns = value; return q; },
      eq: (key: string, value: string) => { if (key !== "id") throw new Error("Exact event ID required"); id = value; return q; },
      maybeSingle: async () => {
        ref.trace.push("read_exact_event");
        const result = await ref.db.query(`select ${columns} from app_events where id=$1`, [id]);
        return { data: result.rows[0] ? JSON.parse(JSON.stringify(result.rows[0])) : null, error: null };
      } };
    return q;
  },
}) }));
import { consumeFederalReviewedCapture, inspectFederalReviewedCapture } from "./federalReviewedCapture";
import { readFederalDiscoveryContinuations } from "./federalDiscoveryState";

it("uses the actual source lease and SQL transaction, verifies event/state/release, and recovers an uncertain controller response without another write", async () => {
  const result = await runFederalReviewedProgressionChecks({ controller: async ({ db, seed, snapshot }: any) => {
    ref.db = db;
    const f = await seed();
    await db.exec("update public_growth_sweep_state set lease_token=null,lease_until=null");
    ref.trace = [];
    const saved = await consumeFederalReviewedCapture(f.request);
    expect(saved).toMatchObject({ exactEventVerified: true, exactStateVerified: true, reusedReceipt: false, queryRetired: true,
      completionScope: "source_capture", companyComplete: false, historyComplete: false, sourceRequests: 0 });
    expect(ref.trace).toEqual(["read_exact_event", "acquire_public_growth_sweep_lease", "consume_federal_reviewed_capture", "read_exact_event", "fail_public_growth_sweep_lease", "inspect_federal_reviewed_capture"]);
    expect((await inspectFederalReviewedCapture(f.g.company.id)).cursorSha256).toBe(saved.afterCursorSha256);
    const state = await snapshot();
    expect(state.state.lease_token).toBeNull(); expect(state.state.lease_until).toBeNull();
    expect(Object.keys(readFederalDiscoveryContinuations(state.state.cursor))).toHaveLength(3);
    expect(state.state.cursor.discoveryCapacityHold).toEqual(f.cursor.discoveryCapacityHold);
    ref.trace = [];
    expect((await consumeFederalReviewedCapture(f.request)).reusedReceipt).toBe(true);
    expect(ref.trace).toEqual(["read_exact_event"]);
    expect(await snapshot()).toEqual(state);
    await expect(consumeFederalReviewedCapture({ ...f.request, decisionHash: "f".repeat(64) })).rejects.toThrow("receipt mismatch");

    const next = await seed("contracts");
    await db.exec("update public_growth_sweep_state set lease_token=null,lease_until=null");
    ref.hideCursorHash = true;
    await expect(consumeFederalReviewedCapture(next.request)).rejects.toThrow("state readback mismatch");
    ref.hideCursorHash = false;
    const committed = await snapshot();
    ref.trace = [];
    const recovered = await consumeFederalReviewedCapture(next.request);
    expect(recovered.reusedReceipt).toBe(true); expect(ref.trace).toEqual(["read_exact_event"]);
    expect(await snapshot()).toEqual(committed);
    expect((await inspectFederalReviewedCapture(next.g.company.id)).continuation).not.toHaveProperty("sourceCapture");
  } });
  expect(result.ok).toBe(true);
}, 30_000);
