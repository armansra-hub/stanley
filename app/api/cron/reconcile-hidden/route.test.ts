import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const reconcile = vi.hoisted(() => vi.fn(async ({ dryRun }: { dryRun: boolean }) => ({ dryRun, restored: 0 })));
vi.mock("@/lib/db/reviewPolicy", () => ({ reconcileHumanHiddenStatuses: reconcile }));

import { GET } from "./route";

describe("reconcile-hidden cron GET", () => {
  const prior = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    reconcile.mockClear();
  });

  afterEach(() => {
    if (prior == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  });

  it("supports the authenticated GET method used by the daily dispatcher", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/reconcile-hidden", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith({ dryRun: false });
  });

  it("keeps dry runs explicit", async () => {
    await GET(new NextRequest("https://stanley.local/api/cron/reconcile-hidden?dryRun=true", {
      headers: { authorization: "Bearer test-cron-secret" },
    }));
    expect(reconcile).toHaveBeenCalledWith({ dryRun: true });
  });
});
