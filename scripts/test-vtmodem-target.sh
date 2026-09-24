#!/usr/bin/env bash
# Test the actual target interpreter/libc/modules, after source/rootfs equality
# validation. Pure fixtures only: no physical device or live netifd is accessed.
set -euo pipefail
ROOT="${1:?extracted firmware root is required}"
QEMU="${QEMU_MIPSEL:-/usr/bin/qemu-mipsel-static}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$ROOT" && pwd)"
[[ -x "$QEMU" && -x "$ROOT/usr/bin/ucode" && -f "$ROOT/usr/lib/ucode/fs.so" ]] || {
  echo 'ERROR: actual target ucode/fs or QEMU runner unavailable' >&2
  exit 1
}
cd "$REPO"
for test in test-t99-control.uc test-vtmodem-sms-jobs.uc test-t99-control-rpc.uc test-vtmodem-connection.uc; do
  echo "===== ACTUAL MIPS/MUSL $test ====="
  timeout --kill-after=5s 30s "$QEMU" -L "$ROOT" "$ROOT/usr/bin/ucode" \
    -L "$ROOT/usr/lib/ucode/*.so" "scripts/tests/$test"
done
echo VT_MODEM_TARGET_TESTS_OK
