import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        is: async () => ({ count: 0 }),
        in: async () => ({ count: 0 }),
        not: async () => ({ count: 0 }),
      }),
    }),
  }),
}));

import { GET as getContract } from "./route";
import { GET as getScoreContract } from "../scores/route";
import { ASSESSMENT_ARTIFACT_RULES, SCORE_STORAGE_RULES } from "@/lib/agent/scoreContract";

describe("published agent score contracts", () => {
  const previousToken = process.env.AGENT_TOKEN;

  beforeEach(() => {
    process.env.AGENT_TOKEN = "contract-test-token";
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.AGENT_TOKEN;
    else process.env.AGENT_TOKEN = previousToken;
  });

  const request = () => new Request("https://stanley.test/api/agent/contract", {
    headers: { "x-agent-token": "contract-test-token" },
  });

  it("publishes the canonical rules through /api/agent/contract", async () => {
    const response = await getContract(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scoring.storageRules).toEqual(SCORE_STORAGE_RULES);
    expect(body.scoring.assessmentArtifactRules).toEqual(ASSESSMENT_ARTIFACT_RULES);
    expect(body.deploymentSource).toMatchObject({
      checked: false,
      attested: false,
      policySentinelConfigured: false,
    });
  });

  it("publishes the same rules through /api/agent/scores", async () => {
    const response = await getScoreContract(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rules).toEqual(SCORE_STORAGE_RULES);
    expect(body.assessmentArtifactRules).toEqual(ASSESSMENT_ARTIFACT_RULES);
  });
});
