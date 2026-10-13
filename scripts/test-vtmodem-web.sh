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
for VT_TOOL in node timeout python3 cc make; do
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
  test-vtmodem-dashboard.js \
  test-vtmodem-status-view.js \
  test-vtmodem-sms.js \
  test-vtmodem-radio-controls.js \
  test-vtmodem-connection.js; do
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
  test-t99-control-rpc.uc \
  test-vtmodem-collector.uc \
  test-vtmodem-sms-jobs.uc \
  test-vtmodem-traffic.uc \
  test-vtmodem-connection.uc; do
  printf 'Running %s\n' "$VT_TEST"
  timeout --kill-after=5s 30s "$UCODE_BIN" -L "$UCODE_LIB/*.so" "scripts/tests/$VT_TEST"
done

for VT_TEST in \
  scripts/test-t99w175-net-ready.py \
  scripts/tests/test-t99-qmi-lifecycle.py \
  scripts/tests/test-t99-qmi-hotplug.py \
  scripts/tests/test-t99-qmi-sysfs.py \
  scripts/tests/test-vtmodem-c.py \
  scripts/tests/test-vtmodem-root.py \
  scripts/tests/test-vt-image.py \
  scripts/tests/test-build-workflow.py \
  scripts/tests/test-vt-mac.py \
  scripts/tests/test-vnstat-flush-patch.py \
  scripts/tests/test-vt-traffic-service.py \
  scripts/tests/test-vt-stability.py \
  scripts/tests/test-vt-runtime.py; do
  printf 'Running %s\n' "$VT_TEST"
  timeout --kill-after=5s 120s python3 "$VT_TEST"
done

VT_SQLITE_ARGS=()
VT_PACKAGE_ARGS=()
if [[ -n "${VT_SQLITE_INCLUDE:-}" ]]; then
  VT_SQLITE_ARGS+=(--include "$VT_SQLITE_INCLUDE")
  VT_PACKAGE_ARGS+=(--include "$VT_SQLITE_INCLUDE")
fi
if [[ -n "${VT_SQLITE_LIB:-}" ]]; then
  VT_SQLITE_ARGS+=("--sqlite-lib=$VT_SQLITE_LIB")
fi
if [[ -n "${VT_SQLITE_SO:-}" ]]; then
  VT_PACKAGE_ARGS+=(--sqlite-so "$VT_SQLITE_SO")
fi
timeout --kill-after=5s 30s python3 scripts/tests/test-vnstat-db-errors.py "${VT_SQLITE_ARGS[@]}"
timeout --kill-after=5s 30s python3 scripts/tests/test-vt-traffic-db.py "${VT_SQLITE_ARGS[@]}"
timeout --kill-after=5s 60s python3 scripts/tests/test-vtmodem-package.py "${VT_PACKAGE_ARGS[@]}"

echo VT_MODEM_WEB_TESTS_OK
