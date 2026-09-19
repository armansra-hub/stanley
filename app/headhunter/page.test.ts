import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ configured: vi.fn(), companies: vi.fn() }));
vi.mock("@/components/Dashboard", () => ({ default: () => null }));
vi.mock("@/lib/supabase/server", () => ({ hasSupabaseEnv: mocks.configured }));
vi.mock("@/lib/db/companies", () => ({ getCompanies: mocks.companies, getExportHistory: async () => [] }));
vi.mock("@/lib/db/settings", () => ({ getAppConfig: async () => ({}), getActorOverrides: async () => ({}) }));
vi.mock("@/lib/db/events", () => ({ listEvents: async () => [] }));
import React from "react";
import HeadhunterPage from "./page";
beforeEach(() => { mocks.configured.mockReturnValue(true); mocks.companies.mockReset().mockResolvedValue([]); vi.stubGlobal("React", React); });
afterEach(() => vi.unstubAllGlobals());
describe("headhunter live-data initialization", () => {
  it("treats an empty discovered set as a valid live read", async () => {
    const page = await HeadhunterPage();
    expect(page.props).toMatchObject({ initial: [], usingSample: false, initialLoadError: null });
  });
  it("reports a live read failure without substituting sample records", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.companies.mockRejectedValue(new Error("Synthetic storage failure"));
    const page = await HeadhunterPage();
    expect(page.props.initial).toEqual([]);
    expect(page.props.usingSample).toBe(false);
    expect(page.props.initialLoadError).toContain("could not load");
    log.mockRestore();
  });
  it("reserves sample data for an unconfigured database", async () => {
    mocks.configured.mockReturnValue(false);
    const page = await HeadhunterPage();
    expect(page.props.usingSample).toBe(true);
    expect(page.props.initial.length).toBeGreaterThan(0);
    expect(mocks.companies).not.toHaveBeenCalled();
  });
});
