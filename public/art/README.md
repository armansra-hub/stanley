# Background art (drop your images here)

Drop **any** image files into this folder. The app cycles through all of them as
the background on **every page**, changing **once per hour**. Use images you have
the rights to (your own, or free stock from Unsplash / Pexels).

- Accepted: `.jpg` `.jpeg` `.png` `.webp` `.avif` `.gif`
- Any filenames work — they're picked up automatically.
- Best results: wide / landscape images, ~1920×1080 or larger.

How it's wired: a build step (`scripts/gen-art.mjs`) scans this folder and writes
`config/art-manifest.json`; `components/BackgroundCycler.tsx` rotates through that
list hourly. So after adding/removing images, redeploy (the build regenerates the
list). To refresh locally: `npm run gen-art`.

Until you add images, a styled dusk-gradient fallback shows — the app never looks
empty.
