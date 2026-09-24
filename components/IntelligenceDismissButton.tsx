"use client";

export default function IntelligenceDismissButton({ companyId, name, status, busy, onStatus }: {
  companyId: string; name: string; status?: string; busy: boolean;
  onStatus: (id: string, status: "new" | "dismissed") => Promise<boolean>;
}) {
  const hidden = status === "reviewed" || status === "dismissed" || status?.startsWith("exported");
  return <button type="button" disabled={busy} onClick={event => {
    event.stopPropagation();
    void onStatus(companyId, hidden ? "new" : "dismissed");
  }} className="rounded-md border px-2.5 py-1 text-xs disabled:cursor-wait disabled:opacity-50"
    style={hidden ? undefined : { borderColor: "rgba(220,38,38,0.45)", color: "#ef4444" }}
    aria-label={`${hidden ? "Restore" : "Dismiss"} ${name}`}
    title={hidden ? "Restore this lead to the prospecting lists" : "Dismiss this lead, as in Triggered. Its research is kept; restore it with Show hidden."}>
    {hidden ? "Restore" : "✕ Dismiss"}
  </button>;
}
