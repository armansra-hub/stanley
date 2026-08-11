import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PRODUCTION_SOURCE_SENTINEL, verifyProductionSource } from "./verify-production-source.mjs";

const gitProduction = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  STANLEY_PRODUCTION_SOURCE_POLICY: PRODUCTION_SOURCE_SENTINEL,
  VERCEL_GIT_PROVIDER: "github",
  VERCEL_GIT_REPO_OWNER: "armansra-hub",
  VERCEL_GIT_REPO_SLUG: "stanley",
  VERCEL_GIT_COMMIT_REF: "main",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
};

describe("production source guard", () => {
  it("does not interfere with local or preview builds", () => {
    expect(verifyProductionSource({}).ok).toBe(true);
    expect(verifyProductionSource({ VERCEL: "1", VERCEL_ENV: "preview" }).ok).toBe(true);
  });

  it("accepts the linked GitHub main source", () => {
    expect(verifyProductionSource(gitProduction)).toMatchObject({ ok: true, checked: true });
  });

  it("requires the Production-only sentinel even when Vercel system variables exist", () => {
    const result = verifyProductionSource({ VERCEL: "1", VERCEL_ENV: "production" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("STANLEY_PRODUCTION_SOURCE_POLICY");
  });

  it("rejects a production CLI upload with the sentinel but no Git trigger metadata", () => {
    const result = verifyProductionSource({
      VERCEL: "1",
      VERCEL_ENV: "production",
      STANLEY_PRODUCTION_SOURCE_POLICY: PRODUCTION_SOURCE_SENTINEL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("provider=(missing)");
  });

  it("still enforces when Vercel system-variable exposure is disabled", () => {
    const result = verifyProductionSource({
      STANLEY_PRODUCTION_SOURCE_POLICY: PRODUCTION_SOURCE_SENTINEL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("provider=(missing)");
  });

  it("rejects a stale branch or different repository", () => {
    expect(verifyProductionSource({ ...gitProduction, VERCEL_GIT_COMMIT_REF: "stale-copy" }).ok).toBe(false);
    expect(verifyProductionSource({ ...gitProduction, VERCEL_GIT_REPO_SLUG: "stanley-copy" }).ok).toBe(false);
  });

  it("requires an immutable commit SHA", () => {
    expect(verifyProductionSource({ ...gitProduction, VERCEL_GIT_COMMIT_SHA: "main" }).ok).toBe(false);
  });

  it("is wired into builds and contains ordinary CLI source uploads", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.prebuild).toBe("node scripts/verify-production-source.mjs");

    const ignore = readFileSync(new URL("../.vercelignore", import.meta.url), "utf8");
    expect(ignore).toContain("/*");
    expect(ignore).toContain("!scripts/verify-production-source.mjs");
    expect(ignore).not.toMatch(/!app(?:\/|\s)/);
  });
});
