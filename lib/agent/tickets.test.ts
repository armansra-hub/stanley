import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import { reserveTicket } from "./tickets";

const id = "11111111-1111-4111-8111-111111111111";
const raw = `${id}.this-is-a-long-enough-ticket-secret`;

describe("atomic upload-ticket reservation", () => {
  beforeEach(() => mocks.rpc.mockReset());

  it("rejects malformed tickets without touching the database", async () => {
    await expect(reserveTicket("bad")).resolves.toEqual({ ok: false, reason: "malformed ticket" });
    await expect(reserveTicket("11111111-1111-1111-1111-111111111111.this-is-a-long-enough-ticket-secret"))
      .resolves.toEqual({ ok: false, reason: "malformed ticket" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns the exact scope and post-reservation remaining count", async () => {
    mocks.rpc.mockResolvedValue({
      data: { accepted: true, id, scope_ids: ["101", "202"], remaining: 4 },
      error: null,
    });
    const result = await reserveTicket(raw);
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_upload_ticket", {
      p_ticket_id: id,
      p_secret_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result).toEqual({
      ok: true,
      id,
      scopeIds: new Set(["101", "202"]),
      remaining: 4,
    });
  });

  it("fails closed on a spent/revoked/expired/bad-secret ticket", async () => {
    mocks.rpc.mockResolvedValue({ data: { accepted: false }, error: null });
    await expect(reserveTicket(raw)).resolves.toEqual({ ok: false, reason: "ticket unavailable" });
  });

  it("surfaces reservation errors instead of allowing an upload", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(reserveTicket(raw)).rejects.toThrow(/reservation failed: database unavailable/);
  });
});
