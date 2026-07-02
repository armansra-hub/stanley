"use client";

import { useEffect, useState } from "react";
import manifest from "@/config/art-manifest.json";

/**
 * App-wide background. Rotates through every image in public/art every 30 minutes
 * (the same image shows on all pages within the window, so it feels intentional).
 * A dark scrim keeps content readable. Renders nothing until images are added.
 */
export default function BackgroundCycler() {
  const list = manifest as string[];
  const [i, setI] = useState(0);

  useEffect(() => {
    if (list.length === 0) return;
    const pick = () => setI(Math.floor(Date.now() / 1_800_000) % list.length);
    pick();
    const t = setInterval(pick, 60_000); // re-check each minute; advances every 30 min
    return () => clearInterval(t);
  }, [list.length]);

  if (list.length === 0) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        backgroundImage: `linear-gradient(rgba(16,10,6,0.55), rgba(16,10,6,0.8)), url(${list[i]})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        transition: "background-image 0.8s ease",
      }}
    />
  );
}
