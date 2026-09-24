#!/usr/bin/env bash
set -euo pipefail

OPENWRT_DIR="${1:-$PWD/openwrt}"
ARTIFACT_DIR="${2:-$PWD/artifacts}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ARTIFACT_DIR"
if [[ -n "$(find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "ERROR: use an empty artifact directory to avoid stale images: $ARTIFACT_DIR" >&2
  exit 1
fi

TARGET_DIR="$OPENWRT_DIR/bin/targets/ramips/mt7621"
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: target output directory not found: $TARGET_DIR" >&2
  exit 1
fi

cp "$OPENWRT_DIR/.config" "$ARTIFACT_DIR/openwrt.config"
(
  cd "$OPENWRT_DIR"
  git rev-parse HEAD
) > "$ARTIFACT_DIR/OPENWRT_COMMIT.txt"

mapfile -t IMAGES < <(find "$TARGET_DIR" -maxdepth 1 -type f \
  -name '*vertell_vt-mt7621d-squashfs-sysupgrade.bin' -print)
if (( ${#IMAGES[@]} != 1 )); then
  echo "ERROR: expected exactly one VT-STREET-M2 squashfs sysupgrade image" >&2
  exit 1
fi
SYSUPGRADE="${IMAGES[0]}"

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
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FWTOOL="$OPENWRT_DIR/staging_dir/host/bin/fwtool"
if [[ ! -x "$FWTOOL" ]]; then
  echo 'ERROR: OpenWrt host fwtool is missing' >&2
  exit 1
fi
# fwtool verifies the appended metadata CRC; do not truncate the original.
"$FWTOOL" -i "$ARTIFACT_DIR/sysupgrade.metadata.json" "$SYSUPGRADE"
python3 "$REPO_DIR/scripts/validate-vt-image.py" --image "$SYSUPGRADE" \
  --metadata "$ARTIFACT_DIR/sysupgrade.metadata.json" --extract-to "$TMP/members" \
  | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
KERNEL="$TMP/members/kernel"
ROOTFS="$TMP/members/root"
cp "$KERNEL" "$ARTIFACT_DIR/vertell-vt-street-m2-kernel.uImage"

DTB="$(find "$OPENWRT_DIR/build_dir" -type f -name 'image-mt7621_vertell_vt-mt7621d.dtb' -print -quit 2>/dev/null || true)"
if [[ -n "$DTB" ]]; then
  cp "$DTB" "$ARTIFACT_DIR/mt7621_vertell_vt-mt7621d.dtb"
  DTC="$OPENWRT_DIR/staging_dir/host/bin/dtc"
  if [[ -x "$DTC" ]]; then
    "$DTC" -I dtb -O dts -o "$ARTIFACT_DIR/mt7621_vertell_vt-mt7621d.compiled.dts" "$DTB" 2>/dev/null || true
  fi
fi

# Export the compiled helper itself, not /usr/bin/vt-sms from the package
# image (that path is the locking shell wrapper in vtmodem release >= 8).
VT_SMS="$(find "$OPENWRT_DIR/build_dir" -type f -path '*/vtmodem/vt-sms' -perm -111 -print -quit 2>/dev/null || true)"
if [[ -n "$VT_SMS" ]]; then
  cp "$VT_SMS" "$ARTIFACT_DIR/vt-sms.real.mipsel"
  VT_SMS_FILE="$(file "$ARTIFACT_DIR/vt-sms.real.mipsel")"
  {
    echo
    echo '===== VT-SMS REAL HELPER ====='
    echo "$VT_SMS_FILE"
    sha256sum "$ARTIFACT_DIR/vt-sms.real.mipsel"
  } | tee -a "$ARTIFACT_DIR/VALIDATION.txt"

  if [[ "$VT_SMS_FILE" != *ELF* || "$VT_SMS_FILE" != *MIPS* ]]; then
    echo 'ERROR: exported vt-sms helper is not a MIPS ELF executable' | tee -a "$ARTIFACT_DIR/VALIDATION.txt" >&2
    exit 1
  fi
else
  echo 'ERROR: compiled vt-sms helper binary not found for standalone export' | tee -a "$ARTIFACT_DIR/VALIDATION.txt" >&2
  exit 1
fi

UNSQUASHFS="$OPENWRT_DIR/staging_dir/host/bin/unsquashfs4"
if [[ -z "$ROOTFS" || ! -x "$UNSQUASHFS" ]]; then
  echo 'ERROR: sysupgrade root or OpenWrt unsquashfs4 tool is missing' | tee -a "$ARTIFACT_DIR/VALIDATION.txt" >&2
  exit 1
fi
# The package lives under these paths. Avoid unrelated device nodes in /dev
# when extracting as an unprivileged CI user.
"$UNSQUASHFS" -no-progress -d "$TMP/firmware-root" "$ROOTFS" bin sbin etc lib usr www
python3 "$REPO_DIR/scripts/validate-vtmodem-root.py" "$TMP/firmware-root" \
  | tee "$ARTIFACT_DIR/VT_MODEM_FILES.txt" | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
python3 "$REPO_DIR/scripts/validate-vt-image.py" \
  --platform "$TMP/firmware-root/lib/upgrade/platform.sh" \
  | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
cmp "$UPGRADE_FILE" "$TMP/firmware-root/lib/upgrade/platform.sh"
python3 "$REPO_DIR/scripts/build-identity.py" --verify "$OPENWRT_DIR" "$TMP/firmware-root"
cp "$TMP/firmware-root/etc/vt-build.json" "$ARTIFACT_DIR/vt-build.json"
cp "$OPENWRT_DIR/feeds.conf" "$ARTIFACT_DIR/feeds.conf.lock"
python3 "$REPO_DIR/scripts/validate-vt-runtime.py" "$TMP/firmware-root" \
  | tee "$ARTIFACT_DIR/VT_RUNTIME.txt" | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
bash "$REPO_DIR/scripts/test-vtmodem-target.sh" "$TMP/firmware-root" \
  | tee "$ARTIFACT_DIR/TARGET_TESTS.txt" | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
# Promote the candidate images only after every validation gate has passed.
cp -a "$TARGET_DIR"/* "$ARTIFACT_DIR"/

{
  echo
  echo '===== RESULT ====='
  echo 'uImage CRC, payload length, MIPS/LZMA/load-entry and sysupgrade metadata validated.'
  echo 'VT-STREET-M2 NAND sysupgrade routing validated.'
  echo 'VT Modem runtime files match the source inside the actual firmware root.'
  echo 'Build validation passed; hardware boot/recovery testing remains a separate step.'
} | tee -a "$ARTIFACT_DIR/VALIDATION.txt"
