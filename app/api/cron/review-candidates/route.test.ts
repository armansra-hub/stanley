import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/lib/triggers/candidateReview", () => ({ reviewPendingCandidates: mocks.review }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.logEvent }));

import { GET } from "./route";

describe("automatic trigger-candidate review cron", () => {
  const priorSecret = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "review-secret";
    mocks.review.mockReset().mockResolvedValue({ checked: 3, kept: 1, rejected: 1, promoted: 1, deferred: 1 });
    mocks.logEvent.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  it("rejects unauthenticated requests", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/review-candidates"));
    expect(response.status).toBe(401);
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("reviews, publishes, and records a bounded receipt", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/review-candidates?n=25", {
      headers: { "x-cron-secret": "review-secret" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(25);
    expect(await response.json()).toEqual({ checked: 3, kept: 1, rejected: 1, promoted: 1, deferred: 1 });
    expect(mocks.logEvent).toHaveBeenCalledWith("headhunter", "trigger.candidates_auto_reviewed", expect.objectContaining({
      meta: expect.objectContaining({ promoted: 1, rejected: 1, deferred: 1 }),
    }));
  });
});
