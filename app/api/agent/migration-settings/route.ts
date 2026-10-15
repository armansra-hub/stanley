import { agentAuthOk } from "@/lib/agent/auth";
import { verifyProductionSource } from "@/scripts/verify-production-source.mjs";
import { handleTransfer } from "@/lib/agent/migrationSettings.mjs";
import { TRANSFER_CONFIG } from "@/config/migration-settings.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function handle(request: Request) {
  const authorized = agentAuthOk(request);
  return handleTransfer(request, {
    authorized,
    config: TRANSFER_CONFIG,
    env: process.env,
    sourceAttestation: authorized ? verifyProductionSource(process.env) : null,
  });
}

export const POST = handle;
export const GET = handle;
export const OPTIONS = handle;
