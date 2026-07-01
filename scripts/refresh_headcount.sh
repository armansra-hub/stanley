#!/usr/bin/env bash
# DOL Form 5500 headcount refresh — ONE command, multiple plan years.
# For each year: downloads BOTH filings (SF = small plans <100 participants, full =
# 100+), unzips, runs both ingests (headcount % merge-max + ACA-50 crossing triggers;
# everything deduped, so re-runs are always safe).
#
# Usage:   scripts/refresh_headcount.sh [YEAR ...]
#   Default: "2024 2025" — 2024 is the newest COMPLETE population; 2025 filings
#   trickle in Jul–Oct 2026 and DOL refreshes the Latest zips MONTHLY, so re-run
#   this monthly through the fall to catch fresh crossings as they file.
#   A year whose file DOL hasn't posted yet is skipped with a warning (not an error).
# Override the data dir root with HEADCOUNT_DIR=/path.
set -uo pipefail

YEARS=("${@:-}")
[ -z "${YEARS[0]:-}" ] && YEARS=(2024 2025)
HERE="$(cd "$(dirname "$0")" && pwd)"

for YEAR in "${YEARS[@]}"; do
  DIR="${HEADCOUNT_DIR:-/tmp}/dol5500_${YEAR}"
  BASE="https://askebsa.dol.gov/FOIA%20Files/${YEAR}/Latest"
  mkdir -p "$DIR"
  SF_CSV="$DIR/f_5500_sf_${YEAR}_latest.csv"
  FULL_CSV="$DIR/f_5500_${YEAR}_latest.csv"

  echo "════ plan year $YEAR ════"
  [ -f "$SF_CSV" ]   || { echo "↓ SF (small plans <100) …";  curl -sL --retry 3 --retry-delay 5 "${BASE}/F_5500_SF_${YEAR}_Latest.zip" -o "$DIR/sf.zip" --max-time 900 && unzip -o "$DIR/sf.zip" -d "$DIR" >/dev/null && rm -f "$DIR/sf.zip"; }
  [ -f "$FULL_CSV" ] || { echo "↓ full (large plans 100+) …"; curl -sL --retry 3 --retry-delay 5 "${BASE}/F_5500_${YEAR}_Latest.zip"    -o "$DIR/full.zip" --max-time 900 && unzip -o "$DIR/full.zip" -d "$DIR" >/dev/null && rm -f "$DIR/full.zip"; }

  if [ -f "$SF_CSV" ]; then
    echo "── SF ingest ($YEAR) ──"
    SF_CSV="$SF_CSV" YEAR="$YEAR" python3 "$HERE/ingest_dol5500.py"
  else
    echo "⚠ $YEAR SF file not available (not posted yet, or DOL unreachable) — skipped"
  fi
  if [ -f "$FULL_CSV" ]; then
    echo "── full ingest ($YEAR) ──"
    F5500_CSV="$FULL_CSV" YEAR="$YEAR" python3 "$HERE/ingest_dol5500_full.py"
  else
    echo "⚠ $YEAR full file not available — skipped"
  fi
done
echo "✓ headcount refresh done (headcount % + ACA-50 crossings; deduped, monthly re-runs safe)."
