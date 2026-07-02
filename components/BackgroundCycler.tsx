"use client";

import { useEffect, useState } from "react";
import manifest from "@/config/art-manifest.json";

/**
 * App-wide background. Rotates through every image in public/art once per hour
 * (the same image shows on all pages within the hour, so it feels intentional).
 * A dark scrim keeps content readable. Renders nothing until images are added.
 *
 * Hardened 2026-07-02 after the blank-background bug: filenames with spaces/
 * parentheses broke the unquoted CSS url() AND 404'd in the deploy, blanking the
 * screen on the hours the rotation landed on them. Now every image is PRELOADED
 * and only applied once it actually loads — a missing/broken file is skipped and
 * the next one in the rotation shows instead. URL is encoded + quoted so any
 * future filename is safe regardless.
 */
export default function BackgroundCycler() {
  const list = manifest as string[];
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (list.length === 0) return;
    let alive = true;
    const pick = () => {
      const start = Math.floor(Date.now() / 3_600_000) % list.length; // hourly rotation
      const tryLoad = (offset: number) => {
        if (!alive || offset >= list.length) return; // nothing loadable → keep last/gradient
        const candidate = list[(start + offset) % list.length];
        const img = new Image();
        img.onload = () => { if (alive) setUrl(candidate); };
        img.onerror = () => tryLoad(offset + 1); // broken/missing file → skip to the next
        img.src = encodeURI(candidate);
      };
      tryLoad(0);
    };
    pick();
    const t = setInterval(pick, 60_000); // re-check each minute; advances on the hour
    return () => { alive = false; clearInterval(t); };
  }, [list.length]);

  if (!url) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        backgroundImage: `linear-gradient(rgba(16,10,6,0.55), rgba(16,10,6,0.8)), url("${encodeURI(url)}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        transition: "background-image 0.8s ease",
      }}
    />
  );
}
