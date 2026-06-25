import { readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Scans public/art for image files and writes config/art-manifest.json (the
// list the background cycler rotates through). Runs at build time so any images
// dropped into public/art are picked up automatically on the next deploy.
const root = process.cwd();
const artDir = join(root, "public", "art");
const configDir = join(root, "config");
const out = join(configDir, "art-manifest.json");
const exts = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

let files = [];
try {
  if (existsSync(artDir)) {
    files = readdirSync(artDir)
      .filter((f) => exts.has(f.slice(f.lastIndexOf(".")).toLowerCase()))
      .sort()
      .map((f) => `/art/${f}`);
  }
} catch (e) {
  console.error("gen-art: scan failed —", e.message);
}

try {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(out, JSON.stringify(files, null, 2) + "\n");
  console.log(`gen-art: wrote ${files.length} background image(s) to config/art-manifest.json`);
} catch (e) {
  console.error("gen-art: write failed —", e.message);
}
