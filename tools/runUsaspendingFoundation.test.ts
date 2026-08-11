import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "tools/run-usaspending-foundation.ps1"), "utf8");

describe("USAspending foundation runner", () => {
  it("uses the durable server-side continuation instead of numeric award offsets", () => {
    expect(script).not.toContain("awardOffset=");
    expect(script).not.toContain("nextAwardOffset");
    expect(script).not.toContain("awardTotal");
    expect(script).toContain("while ([int]$result.retryRemaining -gt 0)");
    expect(script).toContain("$chunk = Invoke-RestMethod -Uri $uri");
    expect(script).toContain("recoveryBlocked = [bool]$chunk.recoveryBlocked");
  });

  it("keeps recovery requests one-company and within the route timeout contract", () => {
    expect(script).toContain("[int]$BatchSize = 1");
    expect(script).toContain("[int]$RequestTimeoutSeconds = 330");
  });
});
