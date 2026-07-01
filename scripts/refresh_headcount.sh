#!/usr/bin/env bash
# Annual DOL Form 5500 headcount-growth refresh — ONE command.
# Downloads BOTH filings (SF = small plans <100 participants, full = 100+), unzips,
# and runs both ingests (merge-max, so order doesn't matter and re-runs are safe).
#
# Usage:   scripts/refresh_headcount.sh [YEAR]
#   YEAR defaults to the DOL "Latest" pointer (currently the most recent posted year).
# Override the data dir with HEADCOUNT_DIR=/path (default: a temp dir).
set -euo pipefail

YEAR="${1:-2023}"                 # DOL posts each plan year; bump as new files publish
DIR="${HEADCOUNT_DIR:-/tmp/dol5500_${YEAR}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="https://askebsa.dol.gov/FOIA%20Files/${YEAR}/Latest"
mkdir -p "$DIR"

# The unzipped CSVs are lowercased by DOL: f_5500_sf_<year>_latest.csv / f_5500_<year>_latest.csv
SF_CSV="$DIR/f_5500_sf_${YEAR}_latest.csv"
FULL_CSV="$DIR/f_5500_${YEAR}_latest.csv"

[ -f "$SF_CSV" ]   || { echo "↓ SF (small plans <100) …";  curl -sL "${BASE}/F_5500_SF_${YEAR}_Latest.zip" -o "$DIR/sf.zip" --max-time 600 && unzip -o "$DIR/sf.zip" -d "$DIR" >/dev/null && rm -f "$DIR/sf.zip"; }
[ -f "$FULL_CSV" ] || { echo "↓ full (large plans 100+) …"; curl -sL "${BASE}/F_5500_${YEAR}_Latest.zip"    -o "$DIR/full.zip" --max-time 600 && unzip -o "$DIR/full.zip" -d "$DIR" >/dev/null && rm -f "$DIR/full.zip"; }

echo "── SF ingest (small plans) ──"
SF_CSV="$SF_CSV" python3 "$HERE/ingest_dol5500.py"
echo "── full ingest (large plans, merge-max) ──"
F5500_CSV="$FULL_CSV" python3 "$HERE/ingest_dol5500_full.py"
echo "✓ headcount refresh complete (both plan sizes). Leads ≥25% now surface in Triggered."
