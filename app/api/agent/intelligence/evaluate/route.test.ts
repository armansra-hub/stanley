import { describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: auth, unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }) }));
import { POST } from "./route";
describe("private TAM Jev exclusion", () => {
  it("denies authenticated grading without reading its private body", async () => {
    auth.mockReturnValue(true);
    const request = new Request("http://localhost/api/agent/intelligence/evaluate", { method: "POST", body: "private TAM text" });
    const json = vi.spyOn(request, "json").mockRejectedValue(new Error("must never inspect private text"));
    const result = await POST(request);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "tam_grading_excluded_from_jev_policy" });
    expect(json).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });
  it("still requires the dedicated agent authorization", async () => {
    auth.mockReturnValue(false);
    expect((await POST(new Request("http://localhost", { method: "POST" }))).status).toBe(401);
  });
});
