#!/usr/bin/env bash
# Host-only tests: no router access, modem commands or network requests.
set -euo pipefail

VT_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$VT_REPO_DIR"

# Use the runtime built by the same pinned OpenWrt tree as the firmware.
# Overrides support an existing build of that source, never a PATH fallback.
UCODE_BIN="${UCODE_BIN:-$VT_REPO_DIR/openwrt/staging_dir/hostpkg/bin/ucode}"
UCODE_LIB="${UCODE_LIB:-$VT_REPO_DIR/openwrt/staging_dir/hostpkg/lib/ucode}"
export UCODE_BIN UCODE_LIB

if [[ "$UCODE_BIN" != /* || ! -x "$UCODE_BIN" || "$UCODE_LIB" != /* || ! -f "$UCODE_LIB/fs.so" ]]; then
  echo 'ERROR: Build tools/cmake/compile and package/utils/ucode/host/compile in the pinned OpenWrt tree first.' >&2
  echo 'Or set UCODE_BIN and UCODE_LIB to absolute paths for a matching host build (including fs.so).' >&2
  exit 1
fi
for VT_TOOL in node timeout; do
  if ! command -v "$VT_TOOL" >/dev/null 2>&1; then
    echo "ERROR: Required host test tool is missing: $VT_TOOL" >&2
    exit 1
  fi
done

# Validate the shared-module search path before spawning supervisor children.
timeout --kill-after=5s 30s "$UCODE_BIN" -L "$UCODE_LIB/*.so" \
  -e 'import { readfile } from "fs"; assert(type(readfile) == "function");'

for VT_TEST in \
  test-vtmodem-status.js \
  test-vtmodem-status-refresh.js \
  test-vtmodem-sms.js \
  test-vtmodem-radio-controls.js; do
  printf 'Running %s\n' "$VT_TEST"
  timeout --kill-after=5s 30s node "scripts/tests/$VT_TEST"
done

for VT_TEST in \
  test-t99-qmi.uc \
  test-t99-qmi-supervisor.uc \
  test-t99-radio.uc \
  test-t99-at-status.uc \
  test-t99-rpc.uc \
  test-t99-session.uc \
  test-t99-control.uc \
  test-t99-control-rpc.uc; do
  printf 'Running %s\n' "$VT_TEST"
  timeout --kill-after=5s 30s "$UCODE_BIN" -L "$UCODE_LIB/*.so" "scripts/tests/$VT_TEST"
done

echo VT_MODEM_WEB_TESTS_OK
