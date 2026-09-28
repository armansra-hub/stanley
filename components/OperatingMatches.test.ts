import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatingAccountsWithStatus } from "./OperatingMatches";
import IntelligenceSelectionBar, { selectedLoadedIds } from "./IntelligenceSelectionBar";
import type { TopicSearchResult } from "@/lib/intelligence/topicSearch";

const account = (companyId: string, status = "new"): TopicSearchResult["accounts"][number] => ({
  companyId, name: companyId, domain: null, subindustry: null, internalId: companyId, status,
  topics: [], coverage: { observations: 0, interpreted: 0, citedObservations: 0 },
});
afterEach(() => vi.unstubAllGlobals());

describe("operating match dismissal and selection", () => {
  it("keeps a pending or saved dismissal hidden when an older search returns", () => {
    const stale = [account("a"), account("b")];
    expect(operatingAccountsWithStatus(stale, { a: "dismissed" }, false).map(row => row.companyId)).toEqual(["b"]);
    expect(stale[0].status).toBe("new");
  });
  it("restores the original account after an optimistic dismissal rolls back", () => {
    const rows = [account("a")];
    expect(operatingAccountsWithStatus(rows, { a: "dismissed" }, false)).toHaveLength(0);
    expect(operatingAccountsWithStatus(rows, {}, false)).toEqual(rows);
  });
  it("shows overridden dismissed status in Show hidden and an explicit restore overrides an older hidden response", () => {
    expect(operatingAccountsWithStatus([account("a")], { a: "dismissed" }, true)[0].status).toBe("dismissed");
    expect(operatingAccountsWithStatus([account("a", "dismissed")], { a: "new" }, false)[0].status).toBe("new");
  });
  it("keeps reviewed, exported and removed leads hidden by default", () => {
    expect(operatingAccountsWithStatus([account("a", "reviewed"), account("b", "exported_batch"), account("c"), account("d", "removed_from_tam")], {}, false).map(row => row.companyId)).toEqual(["c"]);
  });
  it("limits every bulk action to unique, currently loaded selected IDs", () => {
    expect(selectedLoadedIds(["a", "b", "a", "c"], new Set(["b", "offscreen", "a"]))).toEqual(["a", "b"]);
    expect(selectedLoadedIds(["a", "b", "c", "next-page"], new Set(["a", "b"]))).toEqual(["a", "b"]);
  });
  it("offers select-all, selected count and dismissal, with restoration only in Show hidden", () => {
    vi.stubGlobal("React", React);
    const props = { ids: ["a", "b"], selectedIds: new Set(["a", "offscreen"]), onSelectionChange: vi.fn(), onStatus: vi.fn() };
    const normal = renderToStaticMarkup(React.createElement(IntelligenceSelectionBar, props));
    expect(normal).toContain('aria-label="Select all loaded accounts"');
    expect(normal).toContain("1 selected");
    expect(normal).toContain("Dismiss selected");
    expect(normal).not.toContain("Restore selected");
    const hidden = renderToStaticMarkup(React.createElement(IntelligenceSelectionBar, { ...props, showHidden: true, busy: true }));
    expect(hidden).toContain("Restore selected");
    expect(hidden).toContain("Saving…");
    expect(hidden.match(/disabled=""/g)).toHaveLength(4);
  });
});
