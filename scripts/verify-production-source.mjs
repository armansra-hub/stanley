import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const EXPECTED_PRODUCTION_SOURCE = Object.freeze({
  provider: "github",
  owner: "armansra-hub",
  repository: "stanley",
  branch: "main",
});

export const PRODUCTION_SOURCE_SENTINEL = "github-main-only-v1";

/**
 * Build-time defense in depth for Stanley's Git-only production policy.
 *
 * The custom sentinel is deliberately independent of Vercel's optional system
 * environment-variable exposure. Configure it only in the Production environment.
 * Preview and ordinary local builds remain available. This check is not a substitute
 * for Vercel project permissions/promotion policy: prebuilt artifacts can bypass a
 * repository prebuild script, so every release still needs platform readback.
 *
 * @param {Record<string, string | undefined>} env
 */
export function verifyProductionSource(env = process.env) {
  const isVercelProduction = env.VERCEL === "1" && env.VERCEL_ENV === "production";
  const sentinelConfigured = env.STANLEY_PRODUCTION_SOURCE_POLICY !== undefined;
  if (!isVercelProduction && !sentinelConfigured) {
    return { ok: true, checked: false, reason: "production source attestation not requested" };
  }

  if (env.STANLEY_PRODUCTION_SOURCE_POLICY !== PRODUCTION_SOURCE_SENTINEL) {
    return {
      ok: false,
      checked: true,
      reason: "production source rejected (STANLEY_PRODUCTION_SOURCE_POLICY missing or invalid)",
      expected: EXPECTED_PRODUCTION_SOURCE,
    };
  }

  const received = {
    provider: String(env.VERCEL_GIT_PROVIDER ?? "").toLowerCase(),
    owner: String(env.VERCEL_GIT_REPO_OWNER ?? "").toLowerCase(),
    repository: String(env.VERCEL_GIT_REPO_SLUG ?? "").toLowerCase(),
    branch: String(env.VERCEL_GIT_COMMIT_REF ?? ""),
    commit: String(env.VERCEL_GIT_COMMIT_SHA ?? "").toLowerCase(),
  };
  const failures = [];
  for (const key of ["provider", "owner", "repository", "branch"]) {
    if (received[key] !== EXPECTED_PRODUCTION_SOURCE[key]) {
      failures.push(`${key}=${received[key] || "(missing)"}`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(received.commit)) {
    failures.push(`commit=${received.commit || "(missing)"}`);
  }

  if (failures.length) {
    return {
      ok: false,
      checked: true,
      reason: `production source rejected (${failures.join(", ")})`,
      expected: EXPECTED_PRODUCTION_SOURCE,
      received,
    };
  }
  return { ok: true, checked: true, reason: `verified Git source ${received.commit}`, received };
}

function main() {
  const result = verifyProductionSource();
  const line = `[production-source] ${result.reason}`;
  if (!result.ok) {
    console.error(line);
    console.error("Production builds must carry the Production-only sentinel and exact linked GitHub/main metadata. Push main; do not upload a local or prebuilt artifact.");
    process.exitCode = 1;
    return;
  }
  console.log(line);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) main();
