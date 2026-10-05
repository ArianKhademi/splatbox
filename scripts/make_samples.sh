#!/usr/bin/env bash
# Builds the benchmark sample set in samples/assets/ (which is not committed):
#   1. downloads the pinned Khronos models and checks their SHA-256,
#   2. derives the FBX and OBJ inputs from two of them with Blender,
#   3. authors the two in-house assets with Blender.
# Needs Blender 4.5 LTS: on PATH as `blender`, or pointed to by BLENDER_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/samples/assets"

# Pick up BLENDER_BIN from .env when it is not already in the environment.
if [[ -z "${BLENDER_BIN:-}" && -f "$ROOT/.env" ]]; then
  BLENDER_BIN="$(grep -E '^BLENDER_BIN=' "$ROOT/.env" | cut -d= -f2- || true)"
fi
BLENDER="${BLENDER_BIN:-blender}"
if ! command -v "$BLENDER" >/dev/null 2>&1; then
  echo "Blender not found: put it on PATH or set BLENDER_BIN" >&2
  exit 1
fi

cd "$ROOT"
npx tsx scripts/fetch_samples.ts

run_blender() {
  # Blender prints a lot; keep the lines our scripts emit and anything that looks like a failure.
  "$BLENDER" -b --factory-startup -noaudio --python-exit-code 1 --python "$@" 2>&1 | grep -E '^(derived|wrote) |Error|Traceback' || true
  return "${PIPESTATUS[0]}"
}

run_blender "$ROOT/scripts/blender/derive_samples.py" -- --assets "$ASSETS"
run_blender "$ROOT/scripts/blender/make_own_assets.py" -- --out "$ASSETS"

echo "samples ready in $ASSETS:"
ls -l "$ASSETS" | awk 'NR > 1 { printf "  %10d  %s\n", $5, $9 }'
