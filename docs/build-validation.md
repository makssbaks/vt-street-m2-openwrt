# Firmware build and defaults audit fixes

These changes address audit A09, A10 and A11. They do not initiate a firmware
build or alter a running router. A fresh firmware image must pass the complete
build pipeline and the separate hardware review before installation.

## Defaults and identity

`20-vt-mac` preserves a valid configured bridge/LAN MAC. It repairs only an
invalid bridge override when a valid LAN MAC already exists. On blank-Factory
units, a valid `/etc/vt-street-m2.mac` is restored before looking for a modem;
replacement or late enumeration of a T99 therefore does not change a saved
fallback address. A deterministic T99-derived address is provisioned only when
both configured/saved addresses and the Factory MAC are unavailable. A first
boot with blank Factory and no T99 serial still returns for retry; L860 hardware
provisioning is not claimed to be solved by this T99 fallback.

`apply-port.sh` replaces the board profile, including on reused OpenWrt trees,
instead of retaining an earlier profile. It also writes `/etc/vt-build.json`
into the image overlay with the port commit, OpenWrt commit, exact feed commits,
VT Modem package version and (in CI) the build run number. Tracked port changes
must be committed before producing this release identity.

## Reproducible feed selection

The main OpenWrt source stays at
`6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932`.
`config/feeds.conf.lock` now pins all five feed revisions. These are the
openwrt-25.12 heads reviewed on 2026-09-13, not a claim to reconstruct the
previous build49 feed state. No feed changes are fetched automatically at boot.

The build workflow copies the lock to `openwrt/feeds.conf`, updates feeds, checks
the actual checkout HEADs and tracked cleanliness, and then installs packages.
Manual builds must use that same sequence. A feed mismatch is an error; a stale
checkout is never silently accepted. Pin changes require review and fixture and
image checks. Host distribution dependencies and Actions major-version tags
remain external inputs; this is not a claim of complete bit-identical builds.

The approved additive vnstat2 patch lives in
`port/patches/vnstat2/910-vt-flush-exit-status.patch`. `apply-port.sh` copies it
into that package's patches directory without editing tracked upstream files.
The package version and source archive SHA256 must match reviewed vnstat 2.13.
Build identity checks every approved patch byte-for-byte, rejects unexpected
patch inputs, and records patch SHA256s separately from immutable feed commits.
The tracked-source cleanliness gate is unchanged.

Upstream vnstatd 2.13 returns success after a nonfatal final SQLite save error.
The patch makes its shutdown exit status reflect both final flush and database
close failure. The traffic supervisor requires the read-only
`--vt-flush-exit-status` capability marker before relying on this exit status;
an unpatched daemon cannot acknowledge a successful save. The probe returns
before configuration or database access. Normal traffic and modem sessions are
not affected by the accounting daemon's stop/save/restart operation.

## Actual image checks

`collect-and-validate.sh` requires a fresh artifact directory and exactly one
board-specific squashfs sysupgrade. Complete sysupgrade images are copied to the artifact directory only after all
image gates pass; validation logs and extracted diagnostic components may remain
after an error.

1. The pinned host `fwtool -i` extracts and CRC-checks appended metadata without
   modifying the image. Metadata must identify the correct target/profile and
   the exact supported board. The validator understands OpenWrt's compatibility
   1.1 format (`new_supported_devices` plus the legacy mismatch guard).
2. The tar must contain only the expected directory and regular `CONTROL`,
   `kernel` and `root` files. Duplicate paths, unexpected names and symlinks are
   rejected. Known members are copied individually, not extracted by tar.
3. The legacy uImage must fit the 4 MiB partition and have an exact payload
   length, valid header/data CRCs, Linux/MIPS/kernel/LZMA type and load/entry
   addresses `0x80001000`. These expectations follow the pinned ramips
   `Device/Default` and local NAND profile. The root must be squashfs and fit the
   UBI partition; the host unsquashfs tool then reads it.
4. The installed `lib/upgrade/platform.sh` must route this board to
   `nand_do_upgrade` and match the ported source byte-for-byte. Runtime package
   inventory and executable checks run against this same extracted root.
5. The embedded build identity must match source, feeds and package version.
   Metadata, feed lock and build identity are retained with the artifacts.

These checks reject structurally invalid images; they do not prove a bootloader
recovery route or replace the already required hardware boot validation.

Primary source references:

- [Pinned ramips image defaults](https://github.com/openwrt/openwrt/blob/6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932/target/linux/ramips/image/Makefile)
- [Pinned NAND profile](https://github.com/openwrt/openwrt/blob/6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932/target/linux/ramips/image/mt7621.mk)
- [Metadata and uImage commands](https://github.com/openwrt/openwrt/blob/6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932/include/image-commands.mk)
- [Pinned feed parser](https://github.com/openwrt/openwrt/blob/6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932/scripts/feeds)

Historical partial hotfix builders are retired, as documented in
[historical-hotfixes.md](historical-hotfixes.md). Their previously delivered ZIPs
are unaffected. They must not be regenerated from arbitrary newer source.

Local regression commands:

```sh
python3 scripts/tests/test-vt-image.py
python3 scripts/tests/test-vt-mac.py
python3 scripts/tests/test-vnstat-flush-patch.py
bash -n scripts/apply-port.sh scripts/collect-and-validate.sh
```

The tests cover malformed/CRC-valid wrong headers, archive/metadata routing,
actual feed checkout mismatch, repeat profile application, retired packaging and
MAC preservation using isolated UCI models. No NAND, modem, network service or
installed configuration is touched by these tests.

The vnstat regression fixture retains upstream's license and the exact
[`v2.13/src/vnstatd.c`](https://github.com/vergoh/vnstat/blob/v2.13/src/vnstatd.c)
contents (SHA256 `67aaca70427fe168141a80e600b9ff3ac4a75575e6e3fbffc1fd2aafda9a559f`).
The test applies the source patch with zero fuzz and executes compiled copies of
the actual patched shutdown/capability statements with database fault stubs.
It covers successful save, busy/locked/I/O/full-disk errors, close failure, and
preservation of the save error even if later cleanup clears the global error.
This is a host unit test, not a claim of a newly compiled or installed MIPS image.
