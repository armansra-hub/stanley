"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = "/";
      } else {
        setError("Incorrect password");
        setBusy(false);
      }
    } catch {
      setError("Login failed");
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={submit} className="w-80 rounded-lg border p-6" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <h1 className="mb-1 text-lg font-semibold">Jarvis</h1>
        <p className="mb-4 text-sm text-[var(--text-muted)]">Enter your password to continue.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mb-3 w-full rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        {error && <p className="mb-3 text-xs text-[var(--tier-b)]">{error}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white">
          {busy ? "…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
