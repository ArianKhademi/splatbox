#!/usr/bin/env bash
# Rebuilds the demo assets bundled with the web viewer (web/public/demo) from the sample set.
# Run `npm run samples` first. Needs Blender 4.5 LTS (PATH or BLENDER_BIN).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/samples/assets"
DEMO="$ROOT/web/public/demo"

if [[ -z "${BLENDER_BIN:-}" && -f "$ROOT/.env" ]]; then
  BLENDER_BIN="$(grep -E '^BLENDER_BIN=' "$ROOT/.env" | cut -d= -f2- || true)"
fi
BLENDER="${BLENDER_BIN:-blender}"

blender_py() {
  "$BLENDER" -b --factory-startup -noaudio --python-exit-code 1 --python "$@" 2>&1 | grep -E '^wrote |SPLATBOX_ERROR|Traceback' || true
  return "${PIPESTATUS[0]}"
}

cd "$ROOT"
cp "$ASSETS/Fox.glb" "$DEMO/fox.glb"
blender_py scripts/blender/make_demo_fixtures.py -- --fox "$ASSETS/Fox.glb" --walker "$ASSETS/CesiumMan.glb" --out "$DEMO"
blender_py worker/blender/convert.py -- --in "$ASSETS/CesiumMan.glb" --out "$DEMO/pair-motion.glb" --draco
blender_py worker/blender/convert.py -- --in "$ASSETS/own_mannequin.glb" --out "$DEMO/mannequin.glb" --draco
npx tsx scripts/make_splat.ts "$ASSETS/Avocado.glb" "$DEMO/avocado.splat" 60000

ls -l "$DEMO" | awk 'NR > 1 { printf "  %9d  %s\n", $5, $9 }'
