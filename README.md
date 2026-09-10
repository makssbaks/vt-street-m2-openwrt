# VT-STREET-M2 OpenWrt 25.x port

Experimental board-support tree and GitHub Actions build for the Vertell VT-STREET-M2 router.

Hardware baseline:
- MediaTek MT7621
- 128 MiB NAND, 128 MiB RAM
- MT7530 switch, one exposed Ethernet port (`lan1`)
- M.2 modem over USB
- tested hardware variants: Fibocom L860-GL-16 and Dell/Foxconn T99W175

Current bring-up scope:
- board DTS
- exact NAND partition layout from the running vendor firmware
- Factory MAC at offset `0x28`
- reset GPIO4
- system LED GPIO13
- WAN/internet LED GPIO14
- USB power GPIO5
- SIM select GPIO16
- SIM variant GPIO3 as input
- USB drivers for CDC-ACM/CDC-NCM and QMI/option
- LuCI and basic diagnostic tools

Not included yet:
- ModemExpert
- custom `vt-modem-core`
- L860/T99 modem backends
- `luci-app-vtmodem`
- SMS backend

The first build is based on the official OpenWrt `openwrt-25.12` branch, pinned in CI to a known commit for reproducibility.

**Do not flash a produced image just because CI succeeds.** The first image must be checked for uImage header, kernel size, DTB/partition layout and sysupgrade contents before flashing the test router.
