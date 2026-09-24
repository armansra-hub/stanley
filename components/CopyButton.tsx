"use client";

import { useState, type ReactNode } from "react";

/** Copy only the domain, without a protocol, leading www, or URL path. */
export function bareDomain(value: string): string {
  return value.trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function legacyCopy(value: string) {
  try {
    const ta = document.createElement("textarea");
    ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
  } catch { /* clipboard unavailable */ }
}

function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).catch(() => legacyCopy(value));
      return;
    }
  } catch { /* fall through to legacy path */ }
  legacyCopy(value);
}

/** The same hover-to-copy control for Triggered and operating-match leads. */
export default function CopyButton({ value, label, children }: { value: string; label: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return <button
    type="button"
    onClick={(e) => { e.stopPropagation(); copyText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
    title={`Copy ${label}`}
    aria-label={`Copy ${label}`}
    className="rounded px-1 text-[10px] leading-none text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100 focus-visible:opacity-100"
    style={copied ? { color: "var(--tier-a)", opacity: 1 } : undefined}
  >{copied ? "✓" : children}</button>;
}
