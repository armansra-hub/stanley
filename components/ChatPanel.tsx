"use client";

import { useEffect, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type LogEntry = { role: "user" | "assistant" | "system"; text: string };
type Pending = { tool_use_id: string; name: string; input: unknown } | null;

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([
    { role: "assistant", text: "Hi — ask me about your pipeline. e.g. “show Tier A logistics”, “why is Cobalt here?”, “dismiss the out-of-territory imports”." },
  ]);
  const [apiMessages, setApiMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [listening, setListening] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const recRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log, busy, pending, streaming]);

  async function streamTurn(body: any) {
    let acc = "";
    setStreaming("");
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, idx).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(idx + 2);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "delta") {
            acc += ev.text;
            setStreaming(acc);
          } else if (ev.type === "done") {
            setApiMessages(ev.messages);
            if (acc.trim()) setLog((l) => [...l, { role: "assistant", text: acc }]);
            setPending(null);
            setStreaming(null);
          } else if (ev.type === "confirm") {
            setApiMessages(ev.messages);
            setPending(ev.pending);
            setLog((l) => [...l, { role: "assistant", text: `Proposed change — needs your OK:\n${ev.summary}` }]);
            setStreaming(null);
          } else if (ev.type === "error") {
            setLog((l) => [...l, { role: "system", text: `Error: ${ev.error}` }]);
            setStreaming(null);
          }
        }
      }
    } catch {
      setLog((l) => [...l, { role: "system", text: "Request failed." }]);
      setStreaming(null);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setLog((l) => [...l, { role: "user", text }]);
    const next = [...apiMessages, { role: "user", content: text }];
    setApiMessages(next);
    setBusy(true);
    try {
      await streamTurn({ messages: next });
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "allow" | "deny") {
    if (!pending || busy) return;
    setBusy(true);
    setLog((l) => [...l, { role: "system", text: decision === "allow" ? "✓ Approved" : "✕ Cancelled" }]);
    const body = { messages: apiMessages, decision, pending };
    setPending(null);
    try {
      await streamTurn(body);
    } finally {
      setBusy(false);
    }
  }

  function toggleMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setLog((l) => [...l, { role: "system", text: "Voice input isn't supported in this browser." }]);
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const t = e.results[0][0].transcript;
      setInput((prev) => (prev ? prev + " " : "") + t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="western fixed bottom-5 right-5 z-40 rounded-full bg-[var(--accent)] px-5 py-3 text-base text-white shadow-lg"
      >
        Ask Stanley
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 right-0 z-40 flex h-full w-[400px] flex-col border-l bg-[var(--surface)]" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <span className="western text-lg">Ask Stanley</span>
        <button onClick={() => setOpen(false)} className="text-[var(--text-muted)]">✕</button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
        {log.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className="inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2"
              style={{
                background: m.role === "user" ? "var(--accent)" : m.role === "system" ? "transparent" : "var(--surface-2)",
                color: m.role === "user" ? "white" : m.role === "system" ? "var(--text-muted)" : "var(--text)",
                fontSize: m.role === "system" ? "11px" : undefined,
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
        {streaming != null && streaming !== "" && (
          <div>
            <div className="inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2" style={{ background: "var(--surface-2)", color: "var(--text)" }}>
              {streaming}
            </div>
          </div>
        )}
        {busy && (streaming === null || streaming === "") && (
          <div className="text-xs text-[var(--text-muted)]">Stanley is thinking…</div>
        )}
      </div>

      {pending && (
        <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="mb-2 flex gap-2">
            <button onClick={() => decide("allow")} disabled={busy} className="flex-1 rounded-md bg-[var(--tier-a)] py-1.5 text-sm font-medium text-white">
              Approve
            </button>
            <button onClick={() => decide("deny")} disabled={busy} className="flex-1 rounded-md border py-1.5 text-sm font-medium" style={{ borderColor: "var(--border)" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2 border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        <button
          onClick={toggleMic}
          title="Dictate"
          className="rounded-md border px-2 py-2 text-sm"
          style={{ borderColor: listening ? "var(--tier-b)" : "var(--border)", color: listening ? "var(--tier-b)" : "var(--text)" }}
        >
          🎤
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={listening ? "Listening…" : "Ask or dictate…"}
          rows={1}
          className="max-h-28 flex-1 resize-none rounded-md border bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button onClick={send} disabled={busy} className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white">
          Send
        </button>
      </div>
    </div>
  );
}
