import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAuthOk, tamMachineAuthOk } from "./auth";

describe("strict TAM machine authentication", () => {
  const priorAgent = process.env.AGENT_TOKEN;
  const priorCodex = process.env.CODEX_AGENT_TOKEN;
  const priorCron = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.AGENT_TOKEN = "tam-agent-secret";
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.CODEX_AGENT_TOKEN;
  });

  afterEach(() => {
    if (priorAgent == null) delete process.env.AGENT_TOKEN;
    else process.env.AGENT_TOKEN = priorAgent;
    if (priorCodex == null) delete process.env.CODEX_AGENT_TOKEN;
    else process.env.CODEX_AGENT_TOKEN = priorCodex;
    if (priorCron == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorCron;
  });

  it("accepts the dedicated agent credential in approved headers", () => {
    expect(tamMachineAuthOk(new Request("https://stanley.local/tam", {
      headers: { "x-agent-token": "tam-agent-secret" },
    }))).toBe(true);
    expect(tamMachineAuthOk(new Request("https://stanley.local/tam", {
      headers: { authorization: "Bearer tam-agent-secret" },
    }))).toBe(true);
    expect(agentAuthOk(new Request("https://stanley.local/agent", {
      headers: { "x-agent-token": "tam-agent-secret" },
    }))).toBe(true);
  });

  it("rejects cron and query-string credentials", () => {
    expect(tamMachineAuthOk(new Request("https://stanley.local/tam", {
      headers: { "x-cron-secret": "cron-secret" },
    }))).toBe(false);
    expect(tamMachineAuthOk(new Request("https://stanley.local/tam?token=tam-agent-secret"))).toBe(false);
    expect(agentAuthOk(new Request("https://stanley.local/agent", {
      headers: { "x-cron-secret": "cron-secret" },
    }))).toBe(false);
    expect(agentAuthOk(new Request("https://stanley.local/agent?token=tam-agent-secret"))).toBe(false);
  });
});
