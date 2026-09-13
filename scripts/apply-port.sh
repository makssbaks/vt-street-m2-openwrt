#!/usr/bin/env bash
set -euo pipefail

OPENWRT_DIR="${1:-$PWD/openwrt}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$OPENWRT_DIR/include/toplevel.mk" ]]; then
  echo "ERROR: OpenWrt source tree not found: $OPENWRT_DIR" >&2
  exit 1
fi

# Keep upstream feed commits immutable. The one additive package patch is
# separately verified against tracked port source and recorded in the image.
python3 "$REPO_DIR/scripts/build-identity.py" --install-feed-patches "$OPENWRT_DIR"

cp "$REPO_DIR/port/mt7621_vertell_vt-mt7621d.dts" \
  "$OPENWRT_DIR/target/linux/ramips/dts/mt7621_vertell_vt-mt7621d.dts"

PROFILE_FILE="$OPENWRT_DIR/target/linux/ramips/image/mt7621.mk"
python3 "$REPO_DIR/scripts/apply-device-profile.py" "$PROFILE_FILE" \
  "$REPO_DIR/port/vertell-profile.mk"

NETWORK_FILE="$OPENWRT_DIR/target/linux/ramips/mt7621/base-files/etc/board.d/02_network"
python3 - "$NETWORK_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = '\tcase $board in\n'
insert = (
    '\tcase $board in\n'
    '\tvertell,vt-mt7621d)\n'
    '\t\tucidef_set_interface_lan "lan1"\n'
    '\t\t;;\n'
)
if '\tvertell,vt-mt7621d)\n' not in s:
    if needle not in s:
        raise SystemExit('ERROR: case anchor not found in 02_network')
    s = s.replace(needle, insert, 1)
    p.write_text(s)
PY

# This board uses a raw 4 MiB kernel MTD partition plus a separate UBI MTD
# partition. It must use nand_do_upgrade(); falling back to default_do_upgrade()
# treats the sysupgrade tar as a raw firmware image and can leave the kernel
# invalid, causing U-Boot to enter FACTORY UPDATE.
UPGRADE_FILE="$OPENWRT_DIR/target/linux/ramips/mt7621/base-files/lib/upgrade/platform.sh"
python3 - "$UPGRADE_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
entry = '\tvertell,vt-mt7621d|\\\n'
if entry not in s:
    needle = '\tcase "$board" in\n\tampedwireless,ally-00x19k|\\\n'
    insert = '\tcase "$board" in\n' + entry + '\tampedwireless,ally-00x19k|\\\n'
    if needle not in s:
        raise SystemExit('ERROR: NAND upgrade case anchor not found in platform.sh')
    s = s.replace(needle, insert, 1)
    p.write_text(s)

start = s.find(entry)
end = s.find('\n\t\t;;', start)
if start < 0 or end < 0 or 'nand_do_upgrade "$1"' not in s[start:end]:
    raise SystemExit('ERROR: VT-STREET-M2 is not routed to nand_do_upgrade')
PY

# Install our vendor-independent modem package into the OpenWrt package tree.
rm -rf "$OPENWRT_DIR/package/vtmodem"
cp -a "$REPO_DIR/package/vtmodem" "$OPENWRT_DIR/package/vtmodem"

cp "$REPO_DIR/config/seed.config" "$OPENWRT_DIR/.config"
python3 "$REPO_DIR/scripts/build-identity.py" "$OPENWRT_DIR"

cd "$OPENWRT_DIR"
make defconfig

echo "Applied VT-STREET-M2 port to: $OPENWRT_DIR"
grep -E '^CONFIG_TARGET_ramips(_mt7621)?(=|_)' .config | head -n 30 || true
