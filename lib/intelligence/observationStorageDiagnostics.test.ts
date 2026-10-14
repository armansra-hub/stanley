import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
import { enqueueObservation, INTELLIGENCE_VERSION, observationStorageDiagnostics, prepareObservation } from "./observations";
import { newSweepOutcomes, sweepError } from "@/lib/triggers/sweepOutcomes";

const base = { companyId: "11111111-1111-4111-8111-111111111111", companyName: "Example Services",
  sourceKind: "website" as const, sourceUrl: "https://example.com/private-looking-path?secret=unchanged",
  title: "Original title", text: "Original body", observedAt: "2026-10-14T04:00:00Z" };
const hash = (text: string) => createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");
const project = (diagnostics: unknown, code = "22P05", stage = "observation") => {
  const stats = newSweepOutcomes();
  sweepError(stats, "website", stage, Object.assign(new Error(`Observation persistence failed: ${code}`), { observationDiagnostics: diagnostics }));
  return stats;
};
beforeEach(() => { rpc.mockReset(); vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());

describe("rejected observation diagnostics", () => {
  it.each(["22P05", "22P02"])("attaches bounded diagnostics through the real %s persistence wrapper without changing arguments", async code => {
    const text = "Original\0body\ud800X\udc00😀";
    const metadata = Object.freeze({ "sensitive\0key": Object.freeze({ value: "secret\0value", nullable: null }) });
    const input = { ...base, text, metadata };
    const prepared = prepareObservation(input);
    rpc.mockResolvedValue({ data: null, error: { code, message: "sensitive DB message", details: "raw query", hint: "credential" } });
    const failure = await enqueueObservation(input).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(`Observation persistence failed: ${code}`);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("intelligence_observe", {
      p_company: input.companyId, p_source_key: prepared.sourceKey, p_source_kind: input.sourceKind,
      p_url: prepared.url, p_title: input.title, p_text: prepared.text, p_hash: prepared.contentHash,
      p_event_date: prepared.eventDate, p_observed_at: prepared.observedAt, p_metadata: prepared.metadata,
      p_sections: prepared.sections, p_version: INTELLIGENCE_VERSION,
    });
    expect(input.text).toBe(text);
    expect(input.metadata).toBe(metadata);
    const stats = newSweepOutcomes();
    sweepError(stats, "website", "observation", failure, base.companyId);
    expect(stats).toMatchObject({ attempted: 0, succeeded: 0, error_count: 1,
      errors: [{ code: "storage_failure", databaseCode: code, companyId: base.companyId }] });
    const diagnostics = stats.errors[0].observationDiagnostics!;
    expect(diagnostics.scanComplete).toBe(true);
    expect(diagnostics.samples).toContainEqual({ field: "p_text", path: [], member: "value",
      stringCodeUnits: text.length, examinedCodeUnits: text.length, complete: true,
      nulCount: 1, unpairedHighCount: 1, unpairedLowCount: 1, utf16leSha256: hash(text) });
    expect(diagnostics.samples).toContainEqual(expect.objectContaining({ field: "p_metadata", path: [0], member: "key", nulCount: 1, utf16leSha256: hash("sensitive\0key") }));
    const serialized = JSON.stringify(stats);
    for (const forbidden of ["Original", "sensitive", "secret", "raw query", "credential", "example.com", "private-looking-path"])
      expect(serialized).not.toContain(forbidden);
  });

  it("preserves successful, disabled and unrelated database-error behavior", async () => {
    rpc.mockResolvedValueOnce({ data: { id: "saved", queued: true }, error: null });
    await expect(enqueueObservation(base)).resolves.toEqual({ id: "saved", queued: true });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "hidden" } });
    const failure = await enqueueObservation(base).catch(error => error);
    expect(failure.message).toBe("Observation persistence failed: 23505");
    expect(failure).not.toHaveProperty("observationDiagnostics");
    rpc.mockResolvedValueOnce({ data: { disabled: true }, error: null });
    await expect(enqueueObservation(base)).resolves.toBeNull();
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(enqueueObservation(base)).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("hashes exact complete UTF16 units, distinguishes nulls, and leaves valid pairs alone", () => {
    const text = "\ud800\0A\udc00😀";
    const result = observationStorageDiagnostics({ p_text: text, p_metadata: { a: null, b: false, c: 1, d: "😀" } });
    expect(result.scanComplete).toBe(true);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({ nulCount: 1, unpairedHighCount: 1, unpairedLowCount: 1, utf16leSha256: hash(text) });
    expect(result.samples[0].utf16leSha256).not.toBe(createHash("sha256").update(text).digest("hex"));
    expect(observationStorageDiagnostics({ p_metadata: null }).samples).toEqual([]);
  });

  it("marks clipped strings incomplete, does not hash prefixes or misclassify a pair crossing the boundary", () => {
    const text = "x".repeat(65535) + "😀" + "\0";
    const result = observationStorageDiagnostics({ p_text: text });
    expect(result.scanComplete).toBe(false);
    expect(result.samples).toEqual([{ field: "p_text", path: [], member: "value", stringCodeUnits: text.length,
      examinedCodeUnits: 65536, complete: false, nulCount: 0, unpairedHighCount: 0, unpairedLowCount: 0 }]);
    expect(project(result).errors[0].observationDiagnostics).toEqual(result);
  });

  it("bounds total units, string/node/depth counts and sample output deterministically", () => {
    const total = observationStorageDiagnostics({ p_text: "a".repeat(65536), p_metadata: ["b".repeat(65536), "\0"] });
    expect(total.scanComplete).toBe(false);
    expect(total.examinedCodeUnits).toBe(131072);
    expect(total.samples.every(s => !s.complete && !s.utf16leSha256)).toBe(true);
    const many = { p_metadata: Array.from({ length: 1000 }, () => "\0") };
    const result = observationStorageDiagnostics(many);
    expect(result).toEqual(observationStorageDiagnostics(many));
    expect(result.scanComplete).toBe(false);
    expect(result.samplesTruncated).toBe(true);
    expect(result.samples).toHaveLength(8);
    expect(result.examinedStrings).toBeLessThanOrEqual(96);
    expect(result.visitedNodes).toBeLessThanOrEqual(256);
    const nested = { p_metadata: [[[[[[[[[["\0"]]]]]]]]]] };
    expect(observationStorageDiagnostics(nested).scanComplete).toBe(false);
    const nodes = observationStorageDiagnostics({ p_metadata: Array(1000).fill(null) });
    expect(nodes.visitedNodes).toBeLessThanOrEqual(256);
    expect(nodes.scanComplete).toBe(false);
  });

  it("does not invoke getters or mask database failure for malformed metadata", async () => {
    const getter = vi.fn(() => { throw new Error("do not inspect text"); });
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, "privateGetter", { enumerable: true, get: getter });
    nested.cycle = nested;
    const result = observationStorageDiagnostics({ p_metadata: { nested, unsupported: new Date() } });
    expect(result.scanComplete).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { code: "22P05" } });
    const failure = await enqueueObservation({ ...base, metadata: { nested } }).catch(error => error);
    expect(failure.message).toBe("Observation persistence failed: 22P05");
    expect(failure.observationDiagnostics.scanComplete).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("observation diagnostic receipt projection", () => {
  it("reconstructs only safe fields and preserves the existing ten-error cap", () => {
    const valid = observationStorageDiagnostics({ p_text: "\0" });
    const dirty = { ...valid, rawBody: "secret", samples: [{ ...valid.samples[0], rawUrl: "secret", arbitraryKey: { hidden: "secret" } }] };
    expect(project(dirty).errors[0].observationDiagnostics).toEqual(valid);
    const stats = newSweepOutcomes();
    for (let i = 0; i < 12; i++) sweepError(stats, "website", "observation", Object.assign(new Error("Observation persistence failed: 22P05"), { observationDiagnostics: dirty }));
    expect(stats.error_count).toBe(12);
    expect(stats.errors).toHaveLength(10);
    expect(JSON.stringify(stats)).not.toContain("secret");
  });

  it.each([
    { field: "secret field" }, { path: ["secret"] }, { path: [256] }, { path: Array(1) }, { path: Array(9).fill(0) },
    { utf16leSha256: "raw text" }, { nulCount: -1 }, { unpairedHighCount: 2 }, { examinedCodeUnits: 65537 },
    { complete: false }, { member: "secret" }, { stringCodeUnits: null },
  ])("rejects malformed diagnostic sample %j", mutation => {
    const valid = observationStorageDiagnostics({ p_text: "\0" });
    valid.samples[0] = { ...valid.samples[0], ...mutation } as typeof valid.samples[number];
    expect(project(valid).errors[0]).not.toHaveProperty("observationDiagnostics");
  });

  it("rejects malformed envelopes and never attaches to other stages or codes", () => {
    const valid = observationStorageDiagnostics({ p_text: "\0" });
    for (const raw of [null, [], "raw", { ...valid, examinedStrings: 97 }, { ...valid, samples: Array(9).fill(valid.samples[0]) },
      { ...valid, schema: "secret" }, { ...valid, scanComplete: {} }])
      expect(project(raw).errors[0]).not.toHaveProperty("observationDiagnostics");
    expect(project(valid, "23505").errors[0]).not.toHaveProperty("observationDiagnostics");
    expect(project(valid, "22P05", "pages").errors[0]).not.toHaveProperty("observationDiagnostics");
    const malformed = Object.defineProperty({}, "schema", { get: () => { throw new Error("secret"); } });
    expect(() => project(malformed)).not.toThrow();
    expect(project(malformed).errors[0]).not.toHaveProperty("observationDiagnostics");
  });
});
