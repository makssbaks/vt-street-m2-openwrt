# WH3000 Pro eMMC — OpenWrt 25.12.6

This is a separate target. The existing Vertell MT7621 build and its QMI
implementation remain unchanged. Do not flash a Vertell image on the WH3000.

## Hardware and upgrade scope

The observed device is `huasifei,wh3000-pro`, MT7981, eMMC (~8 GB), with a 16 MiB
kernel partition and 2 GiB rootfs partition. Its current upgrade script uses
`emmc_do_upgrade` and `emmc_copy_config`. Upstream 25.12.6's
`huasifei_wh3000-pro-emmc` profile includes the old compatible ID.

This image is intended only for an upgrade preserving the already inspected
configuration. It is not a factory image or a NAND image. Verify SHA256 and run
`sysupgrade -T` on the actual router before flashing. Never use `-F` to bypass a
failure. Keep an off-device configuration backup and a copy of the original
vendor image. The supplied config archive is not a complete recovery image.

### Migration from the old board name

The first r1 image's SHA256 is
`77d8ef6c158f69a964e803658e13a6ca32ff10a87f26da417197befc1b0b2af8`.
Although its fwtool metadata includes the old board ID, the 24.10.3 tar check
also requires `sysupgrade-huasifei_wh3000-pro/CONTROL`. The canonical eMMC
image instead contains `sysupgrade-huasifei_wh3000-pro-emmc/CONTROL`, so the
old check rejects it with `invalid sysupgrade file`. This failure was reproduced
with the upstream 24.10.3 checking code before preparing the migration image.

For this confirmed eMMC device, run `scripts/wh3000-legacy-image.py SOURCE OUTPUT
--fwtool /path/to/fwtool`. It accepts only the pinned r1 input, renames the tar
directory and CONTROL board field, verifies that kernel/root payloads remain
byte-identical, and preserves all fwtool compatibility metadata. It does not
change bootloader, device tree, partition labels or router validation scripts.
The old `emmc_upgrade_tar()` discovers the archive directory independently of
the board name and uses the same `kernel` and `rootfs` partitions.

The migration image is only for the first transition from the old board name.
After booting as `huasifei,wh3000-pro-emmc`, use canonical eMMC images. In both
cases run `sysupgrade -T` on the actual router and stop on any rejection;
never force an upgrade. Host checks do not validate physical boot or cooling.

## Modem software

* ModemManager + cdc_mbim owns the working `05c6:90d5` data connection.
* Pinned [5G Modem v3.9.14](https://github.com/fildunsky/luci-app-5gmodem/tree/9356b1fe9ab278d79b32447dd7e88a46d110ae0a)
  provides radio settings, SMS merging/operations, USSD, traffic statistics and
  vendor telemetry. Its license is GPL-3.0; all upstream notices are retained.
* The new VT Cell page is read-only. It obtains LTE/NR cell information via
  `mmcli`, with separate background collection and an authenticated cache-only
  LuCI RPC. It never opens AT ports or changes network/modem settings.
* Additional SNR/CA/temperature data are read from the documented 5G Modem
  telemetry files only when their age, Cell ID, PCI and channel match. Missing
  metrics remain unavailable. Serving/neighbor cells are never counted as CA.
* SMS and USSD default to ModemManager. These operations still require a live
  hardware check; availability is firmware/operator-dependent.
* Operator-site failures do not trigger the 5G Modem internet healing/failover
  engine. Automatic band locks, SMS remote commands, forwarding, TTL overrides
  and additional public telemetry endpoints are not enabled.

The existing MBIM UCI interfaces are retained. No SIM credentials, SSH keys,
passwords, MAC addresses or private backup files are embedded in this image.
VLESS is not configured: no server profile was supplied and the backup contains
no recoverable VLESS configuration. Check separately before replacing a vendor
firmware that may hold such settings outside the backup.

## Cooling and configuration

The official board profile includes `kmod-hwmon-pwmfan`; its kernel thermal
policy drives the fan. The vendor `fancontrol` package is not in the official
feed. Its old configuration file does not install its daemon. Kernel defaults
use active thresholds 60/85/115 °C with 50/75/100% PWM and 2 °C hysteresis.
Inspect the actual fan and thermal readings immediately after first boot;
the old vendor 45 °C policy has not been reproduced or hardware-tested.

The existing Wi-Fi settings are retained. The supplied backup used open APs:
set a personal WPA2/WPA3 password during commissioning. No preset public password
is put into the image. The mode-button vendor helper was not included in the
backup and cannot be restored from it.

## Build and tests

Use the official 25.12.6 filogic ImageBuilder, SHA256 recorded in `build.json`.
Put the matching 5G Modem APK in its `packages/` directory, check its pinned hash,
then run `scripts/build-wh3000.py IMAGEBUILDER OUTPUT`.

Parser tests use ucode commit `85922056ef7abeace3cca3ab28bc1ac2d88e31b1` from
OpenWrt 25.12.6. Run `scripts/tests/test-vtcell.uc` and
`scripts/tests/test-vtcell-io.uc` with that interpreter and its `fs.so` module,
then `node scripts/tests/test-vtcell.js`. Also run
`python3 scripts/test-vtcell-collector.py /path/to/ucode '/path/to/*.so'`.
Tests cover hexadecimal IDs, NR/LTE separation, unavailable/sentinel values,
staleness, identity mismatch, zero SNR, command timeouts, shell quoting, private
cache permissions and full collector cycles against synthetic mmcli processes.
The frontend was rendered at desktop and 390 px mobile widths with no JavaScript
errors or page overflow; this is a UI fixture check, not a live LuCI integration test.

Build success and fixture tests do not confirm boot, Wi-Fi, cooling, AT-port
selection, SMS send/receive, CA or reconnection on the physical router.
