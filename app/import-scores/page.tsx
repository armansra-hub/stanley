"use client";

import { useEffect, useState } from "react";

export default function ImportScoresPage() {
  const [payload, setPayload] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitRows(rows: unknown, dryRun: boolean) {
    setBusy(true);
    setResult("");
    try {
      const response = await fetch("/api/import/scores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows, dryRun }),
      });
      setResult(`${response.status} ${await response.text()}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(dryRun: boolean) {
    try {
      await submitRows(JSON.parse(payload), dryRun);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const inlinePayload = params.get("payload");
    if (!inlinePayload) return;
    setPayload(inlinePayload);
    void submitRows(JSON.parse(inlinePayload), params.get("mode") === "dry");
  }, []);

  return (
    <main style={{ maxWidth: 960, margin: "40px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Score Import</h1>
      <textarea
        aria-label="Score rows JSON"
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        rows={18}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: 12 }}
      />
      <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
        <button type="button" disabled={busy || !payload} onClick={() => submit(true)}>Dry Run</button>
        <button type="button" disabled={busy || !payload} onClick={() => submit(false)}>Import Batch</button>
      </div>
      <pre aria-label="Import result" style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>{result}</pre>
    </main>
  );
}
