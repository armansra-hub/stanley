import "server-only";
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

// No platform credentials, database credentials, arbitrary env enumeration or
// database reads. Missing and empty values are preserved inside the ciphertext.
export const SETTING_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY", "APIFY_TOKEN", "TYPESAFE_API_KEY", "SAM_API_KEY", "SAM_GOV_API_KEY",
  "SOCRATA_APP_TOKEN", "RESEND_API_KEY", "ICS_PUBLISH_URL", "FROM_EMAIL", "USER_EMAIL",
  "EDGAR_USER_AGENT_EMAIL", "SALES_NAV_URL", "APP_PASSWORD",
  "MODEL_CHAT", "MODEL_BULK", "MODEL_CLASSIFY", "APP_TIMEZONE", "TYPESAFE_MODEL",
  "STANLEY_INTELLIGENCE_ENABLED", "TYPESAFE_PRIVATE_EXCERPTS_ENABLED",
]);
const ORIGIN = "https://jarvis-sable-eta.vercel.app";
const ROUTE = "/api/agent/migration-settings";
const BASE = "a64ed601f1cbb250c5c4b173bc8682569748b932";
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, private, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
  pragma: "no-cache", expires: "0", "x-content-type-options": "nosniff",
});

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function recipient(config, now) {
  const start = Date.parse(config.notBefore);
  const end = Date.parse(config.expiresAt);
  if (config.enabled !== true || !/^[a-f0-9]{32}$/.test(config.transferId)
      || config.sourceBaseCommit !== BASE || !Number.isFinite(start) || !Number.isFinite(end)
      || end <= start || end - start > 60 * 60 * 1000 || now < start || now >= end
      || !/^[a-f0-9]{64}$/.test(config.recipientKeySha256)) throw new Error("inactive");
  const key = createPublicKey(config.recipientPublicKeyPem);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error("recipient");
  const der = key.export({ type: "spki", format: "der" });
  if (createHash("sha256").update(der).digest("hex") !== config.recipientKeySha256) throw new Error("recipient");
  return key;
}

async function hasEmptyBody(request) {
  if (request.signal.aborted) return false;
  if (request.body === null) return true;
  let reader, timer;
  const expired = Symbol("expired");
  try {
    reader = request.body.getReader();
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(expired), 1000); });
    // Next's Node adapter represents even Content-Length: 0 as a stream.
    // Accept only a confirmed EOF, with a fixed deadline and chunk bound.
    for (let chunks = 0; chunks < 16; chunks++) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === expired || request.signal.aborted) return false;
      if (result.done) return true;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength !== 0) return false;
    }
    return false;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    // Cancellation itself can stall; it must never extend the request deadline.
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
  }
}

/** Returns only a hybrid-encrypted envelope or a fixed nonsensitive error. */
export async function handleTransfer(request, { authorized, config, env, sourceAttestation, now = undefined }) {
  // Authenticate before recipient/config inspection and before any settings read.
  if (authorized !== true) return reply(401, { error: "unauthorized" });
  if (request.method !== "POST") return reply(405, { error: "post_required" });
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== ROUTE || url.search || url.hash
      || (request.headers.get("content-length") ?? "0") !== "0" || !await hasEmptyBody(request)) {
    return reply(400, { error: "empty_fixed_request_required" });
  }
  const issuedTime = now ?? Date.now();
  let key;
  try { key = recipient(config, issuedTime); } catch { return reply(404, { error: "unavailable" }); }
  const source = sourceAttestation?.received;
  if (sourceAttestation?.ok !== true || sourceAttestation?.checked !== true
      || source?.provider !== "github" || source?.owner !== "armansra-hub"
      || source?.repository !== "stanley" || source?.branch !== "main"
      || !/^[a-f0-9]{40}$/.test(source?.commit ?? "")) {
    return reply(503, { error: "source_unverified" });
  }
  let aesKey, plaintext;
  try {
    const metadata = {
      format: "stanley-settings-envelope-v1", transferId: config.transferId,
      recipientKeySha256: config.recipientKeySha256, origin: ORIGIN,
      sourceBaseCommit: BASE, deploymentCommit: source.commit,
      issuedAt: new Date(issuedTime).toISOString(), expiresAt: config.expiresAt,
      keyAlgorithm: "RSA-OAEP-256", contentAlgorithm: "A256GCM",
    };
    const values = Object.fromEntries(SETTING_NAMES.map(name => {
      const value = env[name];
      if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16384)) throw new Error("settings");
      return [name, value === undefined ? null : value];
    }));
    const aad = Buffer.from(JSON.stringify(metadata), "utf8");
    plaintext = Buffer.from(JSON.stringify({ format: "stanley-settings-payload-v1", transferId: config.transferId, values }), "utf8");
    if (plaintext.length > 128 * 1024) throw new Error("settings");
    aesKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encryptedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
    return reply(200, {
      format: "stanley-settings-envelope-v1", aad: aad.toString("base64"),
      encryptedKey: encryptedKey.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
    });
  } catch {
    return reply(503, { error: "transfer_unavailable" });
  } finally {
    aesKey?.fill(0); plaintext?.fill(0);
  }
}
