#!/usr/bin/env bash
# Usage: smoke.sh <X.Y.Z> <full-sha> <release-worktree> [out-dir]
# Extracts the repo release skill's registry/loopback smoke block with version and SHA filled in,
# refuses an empty or unfilled extraction, and runs it.
set -euo pipefail
ver=$1; sha=$2; wt=$3; out=${4:-${TMPDIR:-/tmp}}
skill="$wt/.agents/skills/release/SKILL.md"
[ -f "$skill" ] || { echo "no release skill at $skill" >&2; exit 1; }
script="$out/smoke-$ver.sh"
awk '/^### Anonymous registry copies/{f=1} f&&/^```bash$/{g=1;next} g&&/^```$/{exit} g' "$skill" \
  | sed -e "s/^release_version='X.Y.Z'/release_version='$ver'/" -e "s/^release_sha='FULL_APPROVED_SHA'/release_sha='$sha'/" > "$script"
lines=$(wc -l < "$script")
[ "$lines" -gt 100 ] || { echo "extracted smoke script has only $lines lines; refusing" >&2; exit 1; }
if ! grep -q "^release_version='$ver'$" "$script" || ! grep -q "^release_sha='$sha'$" "$script"; then
  echo "version/SHA placeholders not filled; refusing" >&2; exit 1
fi
if lsof -nP -iTCP:18080 -sTCP:LISTEN >/dev/null 2>&1; then
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  sed -i '' "s/^release_port=18080$/release_port=$port/" "$script"
fi
set +e
bash "$script" > "$out/smoke-$ver.log" 2>&1; rc=$?
set -e
grep -E 'identity verified|All four|^Site:|HTTP/1.1 101|Removed disposable|Cleanup incomplete|failed|denied|Blocked' "$out/smoke-$ver.log" || true
echo "smoke exit=$rc (full log: $out/smoke-$ver.log)"
exit $rc
