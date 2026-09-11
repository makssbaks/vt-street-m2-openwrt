#!/usr/bin/env bash
set -euo pipefail

OPENWRT_DIR="${1:-$PWD/openwrt}"
ARTIFACT_DIR="${2:-$PWD/artifacts}"
mkdir -p "$ARTIFACT_DIR"

TARGET_DIR="$OPENWRT_DIR/bin/targets/ramips/mt7621"
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: target output directory not found: $TARGET_DIR" >&2
  exit 1
fi

cp -a "$TARGET_DIR"/* "$ARTIFACT_DIR"/ 2>/dev/null || true
cp "$OPENWRT_DIR/.config" "$ARTIFACT_DIR/openwrt.config"
(
  cd "$OPENWRT_DIR"
  git rev-parse HEAD
) > "$ARTIFACT_DIR/OPENWRT_COMMIT.txt"

SYSUPGRADE="$(find "$TARGET_DIR" -maxdepth 1 -type f -name '*vertell*sysupgrade.bin' -print -quit)"
if [[ -z "$SYSUPGRADE" ]]; then
  echo "ERROR: VT-STREET-M2 sysupgrade image was not produced" >&2
  exit 1
fi

{
  echo '===== VT-STREET-M2 BUILD VALIDATION ====='
  echo "OpenWrt commit: $(cat "$ARTIFACT_DIR/OPENWRT_COMMIT.txt")"
  echo "Sysupgrade: $(basename "$SYSUPGRADE")"
  echo
  echo '===== SHA256 ====='
  sha256sum "$SYSUPGRADE"
  echo
  echo '===== SYSUPGRADE TAR ====='
  tar -tf "$SYSUPGRADE"
} | tee "$ARTIFACT_DIR/VALIDATION.txt"

UPGRADE_FILE="$OPENWRT_DIR/target/linux/ramips/mt7621/base-files/lib/upgrade/platform.sh"
python3 - "$UPGRADE_FILE" <<'PY' | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
entry = '\tvertell,vt-mt7621d|\\\n'
start = s.find(entry)
end = s.find('\n\t\t;;', start)
print('\n===== SYSUPGRADE ROUTING =====')
if start < 0 or end < 0:
    raise SystemExit('ERROR: VT-STREET-M2 missing from platform_do_upgrade')
block = s[start:end]
if 'nand_do_upgrade "$1"' not in block:
    raise SystemExit('ERROR: VT-STREET-M2 does not use nand_do_upgrade')
print('vertell,vt-mt7621d -> nand_do_upgrade: OK')
PY

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -xf "$SYSUPGRADE" -C "$TMP"
KERNEL="$(find "$TMP" -type f -name kernel -print -quit)"
if [[ -z "$KERNEL" ]]; then
  echo "ERROR: kernel member not found inside sysupgrade image" | tee -a "$ARTIFACT_DIR/VALIDATION.txt" >&2
  exit 1
fi

cp "$KERNEL" "$ARTIFACT_DIR/vertell-vt-street-m2-kernel.uImage"
KERNEL_SIZE="$(stat -c '%s' "$KERNEL")"

{
  echo
  echo '===== KERNEL ====='
  echo "Kernel bytes: $KERNEL_SIZE"
  echo "Kernel partition limit: 4194304"
} | tee -a "$ARTIFACT_DIR/VALIDATION.txt"

if (( KERNEL_SIZE > 4194304 )); then
  echo 'ERROR: kernel exceeds 4 MiB partition' | tee -a "$ARTIFACT_DIR/VALIDATION.txt" >&2
  exit 1
fi

python3 - "$KERNEL" <<'PY' | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
from pathlib import Path
import struct, sys
p = Path(sys.argv[1])
b = p.read_bytes()[:64]
if len(b) != 64:
    raise SystemExit('ERROR: kernel is shorter than uImage header')
magic,hcrc,ts,size,load,entry,dcrc,os_,arch,typ,comp,name = struct.unpack('>7I4B32s', b)
name = name.split(b'\0',1)[0].decode('ascii','replace')
print(f'uImage magic: 0x{magic:08x}')
print(f'Payload bytes: {size}')
print(f'Load address: 0x{load:08x}')
print(f'Entry point: 0x{entry:08x}')
print(f'OS/arch/type/comp: {os_}/{arch}/{typ}/{comp}')
print(f'Name: {name}')
if magic != 0x27051956:
    raise SystemExit('ERROR: invalid legacy uImage magic')
PY

DTB="$(find "$OPENWRT_DIR/build_dir" -type f -name 'image-mt7621_vertell_vt-mt7621d.dtb' -print -quit 2>/dev/null || true)"
if [[ -n "$DTB" ]]; then
  cp "$DTB" "$ARTIFACT_DIR/mt7621_vertell_vt-mt7621d.dtb"
  DTC="$OPENWRT_DIR/staging_dir/host/bin/dtc"
  if [[ -x "$DTC" ]]; then
    "$DTC" -I dtb -O dts -o "$ARTIFACT_DIR/mt7621_vertell_vt-mt7621d.compiled.dts" "$DTB" 2>/dev/null || true
  fi
fi

VT_SMS="$(find "$OPENWRT_DIR/build_dir" -type f -name vt-sms -perm -111 -print -quit 2>/dev/null || true)"
if [[ -n "$VT_SMS" ]]; then
  cp "$VT_SMS" "$ARTIFACT_DIR/vt-sms.mipsel"
  {
    echo
    echo '===== VT-SMS HELPER ====='
    file "$ARTIFACT_DIR/vt-sms.mipsel"
    sha256sum "$ARTIFACT_DIR/vt-sms.mipsel"
  } | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
else
  echo 'WARNING: vt-sms helper binary not found for standalone export' | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
fi

{
  echo
  echo '===== RESULT ====='
  echo 'Basic build checks passed.'
  echo 'VT-STREET-M2 NAND sysupgrade routing validated.'
  echo 'FLASHING IS NOT YET APPROVED; inspect DTB/MTD and sysupgrade metadata first.'
} | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
