import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyCoordinationSync,
  canonicalJsonBytes,
  createCoordinationApi,
  loadCoordinationInputs,
  sha256Text,
  verifyCoordinationAggregate,
} from "./tam-coordination-sync.mjs";

function membershipRow(internalId: string, membershipStatus: "new" | "overlap", page: number) {
  const tableRows = [{ "INTERNAL ID": internalId, "COMPANY NAME": `Company ${internalId}` }];
  return {
    netsuiteInternalId: internalId,
    companyName: `Company ${internalId}`,
    membershipStatus,
    tableRows,
    sourceCoordinates: [{ page, row: 1 }],
    savedSearchRowCount: 1,
    tableRowsSha256: sha256Text(canonicalJsonBytes(tableRows)),
  };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tam-coordination-sync-"));
  const refreshDir = path.join(root, "refresh");
  await mkdir(refreshDir);
  const missionPath = path.join(root, "mission.json");
  const liveStatePath = path.join(root, "live-state.json");
  const snapshotSha256 = "a".repeat(64);
  const membership = [membershipRow("101", "new", 1), membershipRow("202", "overlap", 2)];
  const mission = {
    schemaVersion: 2,
    runSlug: "ars-bs-tam-current",
    membershipSource: { savedSearchId: "1327786" },
  };
  const liveState = {
    schemaVersion: 2,
    runSlug: "ars-bs-tam-current",
    updatedAt: "2026-08-10T20:00:00-07:00",
    capture: {
      distinctCurrentInternalIds: 2,
      visibleRowsCaptured: 2,
      snapshotSha256,
      finalDeltaRefreshRequired: false,
    },
  };
  const manifest = {
    schema: "tam-current-membership-refresh",
    version: 2,
    search_id: "1327786",
    distinct_current_internal_ids: 2,
    snapshot_total: 2,
    saved_search_row_count: 2,
    header_total_discrepancy: 0,
    removed_internal_ids: 1,
    added_internal_ids: 1,
    overlap_internal_ids: 1,
    pagination_snapshot_sha256: snapshotSha256,
  };
  const removed = {
    runSlug: "ars-bs-tam-current",
    netsuiteInternalIds: ["303"],
    reason: "Absent from completed exact snapshot",
  };
  await Promise.all([
    writeFile(missionPath, JSON.stringify(mission)),
    writeFile(liveStatePath, JSON.stringify(liveState)),
    writeFile(path.join(refreshDir, "refresh_manifest.json"), JSON.stringify(manifest)),
    writeFile(path.join(refreshDir, "coordination_membership.jsonl"), `${membership.map((row) => JSON.stringify(row)).join("\n")}\n`),
    writeFile(path.join(refreshDir, "coordination_removed_ids.json"), JSON.stringify(removed)),
  ]);
  return {
    root,
    refreshDir,
    missionPath,
    liveStatePath,
    inputs: await loadCoordinationInputs({ missionPath, liveStatePath, refreshDir }),
  };
}

describe("TAM coordination bootstrap", () => {
  it("requires exact explicit artifacts and reads liveState.capture", async () => {
    const fixture = await makeFixture();
    expect(fixture.inputs.expected).toEqual({ current: 2, removed: 1, new: 1, overlap: 1 });
    expect(fixture.inputs.currentIds).toEqual(["101", "202"]);
    expect(fixture.inputs.liveState.capture.snapshotSha256).toBe("a".repeat(64));

    const staleStatePath = path.join(fixture.root, "stale-live-state.json");
    await writeFile(staleStatePath, JSON.stringify({
      runSlug: "ars-bs-tam-current",
      savedSearchCapture: fixture.inputs.liveState.capture,
    }));
    await expect(loadCoordinationInputs({
      missionPath: fixture.missionPath,
      liveStatePath: staleStatePath,
      refreshDir: fixture.refreshDir,
    })).rejects.toThrow("liveState.capture is required");
  });

  it("uses only the dedicated AGENT_TOKEN header and never retries", async () => {
    const calls: Array<{ headers: HeadersInit }> = [];
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
      calls.push({ headers: init.headers! });
      return new Response(JSON.stringify({ error: "stop" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });
    const api = createCoordinationApi({
      baseUrl: "https://stanley.example",
      agentToken: "dedicated-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(api.get("/api/cron/tam-coordination")).rejects.toThrow("503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(calls[0].headers);
    expect(headers.get("x-agent-token")).toBe("dedicated-token");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cron-secret")).toBeNull();
  });

  it("stops immediately when a membership batch inserts an unexpected company", async () => {
    const { inputs } = await makeFixture();
    const posts: unknown[] = [];
    const api = {
      get: vi.fn(),
      post: vi.fn(async (body: Record<string, unknown>) => {
        posts.push(body);
        if (body.action === "membership") {
          return { upserted: 1, distinctIds: 1, companiesInserted: 1, companiesUpdated: 0 };
        }
        return {};
      }),
    };
    await expect(applyCoordinationSync({
      api,
      inputs,
      batchSize: 1,
      expectedCompaniesInserted: 0,
    })).rejects.toThrow("Unexpected companiesInserted=1");
    expect(posts.filter((body: any) => body.action === "membership")).toHaveLength(1);
  });

  it("transitions to capturing and verifies the exact current and removed aggregate", async () => {
    const { inputs } = await makeFixture();
    const current = new Map<string, Record<string, unknown>>();
    const removed = new Map<string, Record<string, unknown>>();
    let run: Record<string, unknown> = {};
    const api = {
      post: vi.fn(async (body: any) => {
        if (body.action === "bootstrap") {
          run = {
            slug: body.runSlug,
            search_id: body.searchId,
            mission: body.mission,
            source_total: body.sourceTotal,
            source_snapshot_sha256: body.sourceSnapshotSha256,
            status: body.status,
          };
          return { run };
        }
        if (body.action === "membership") {
          for (const row of body.rows) {
            current.set(row.netsuiteInternalId, {
              netsuite_internal_id: row.netsuiteInternalId,
              is_current: true,
              membership_status: row.membershipStatus,
              saved_search_row_count: row.savedSearchRowCount,
              table_rows_sha256: row.tableRowsSha256,
              source_coordinates: row.sourceCoordinates,
              table_rows: row.tableRows,
            });
          }
          return { upserted: body.rows.length, distinctIds: body.rows.length, companiesInserted: 0, companiesUpdated: body.rows.length };
        }
        if (body.action === "removed") {
          for (const internalId of body.netsuiteInternalIds) {
            removed.set(internalId, {
              netsuite_internal_id: internalId,
              is_current: false,
              membership_status: "removed",
            });
          }
          return { removed: body.netsuiteInternalIds.length };
        }
        return {};
      }),
      get: vi.fn(async (relativePath: string) => {
        const url = new URL(relativePath, "https://stanley.example");
        if (url.searchParams.get("view") === "records") {
          const records = url.searchParams.get("current") === "true"
            ? [...current.values()]
            : [...removed.values()];
          return { records, total: records.length, limit: 500, offset: 0 };
        }
        return {
          run,
          counts: {
            records_total: current.size + removed.size,
            current: current.size,
            new: [...current.values()].filter((row) => row.membership_status === "new").length,
            overlap: [...current.values()].filter((row) => row.membership_status === "overlap").length,
            removed: removed.size,
          },
        };
      }),
    };
    const result = await applyCoordinationSync({
      api,
      inputs,
      batchSize: 1,
      expectedCompaniesInserted: 0,
    });
    expect(run.status).toBe("capturing");
    expect(result.readback.currentIdsSha256).toBe(inputs.hashes.currentIds);
    expect(result.readback.removedIdsSha256).toBe(inputs.hashes.removedIds);
    expect(api.post.mock.calls.some(([body]) => body.action === "event")).toBe(true);

    run.status = "grading";
    await expect(verifyCoordinationAggregate(api, inputs)).rejects.toThrow("is not capturing");
    run.status = "capturing";
    run.mission = { ...inputs.mission, altered: true };
    await expect(verifyCoordinationAggregate(api, inputs)).rejects.toThrow("exact mission/capture identity");
  });
});
