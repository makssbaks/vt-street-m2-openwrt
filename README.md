# VT-STREET-M2 OpenWrt 25.x port

Experimental board-support tree and GitHub Actions build for the Vertell VT-STREET-M2 router.

Hardware baseline:
- MediaTek MT7621
- 128 MiB NAND, 128 MiB RAM
- MT7530 switch, one exposed Ethernet port (`lan1`)
- M.2 modem over USB
- modem variants: Fibocom L860-GL-16 and Dell/Foxconn T99W175

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

The `vtmodem` package supplies the modem backend and LuCI interface without
ModemExpert. The current integration candidate includes:

- T99 USB detection, startup handoff, QMI networking and the LuCI protocol editor.
- Status telemetry: signal, temperature, carrier aggregation, cells, SIM identity,
  session address and DNS; Russian labels and automatic refresh.
- Multipart SMS display, send and delete controls.
- T99 mode, LTE bands, search priority and cell-lock controls with explicit
  confirmation and readback.
- Release 19 source changes: transactional QMI lifecycle, bounded AT/SMS,
  asynchronous SMS jobs, shared cached telemetry, persistent traffic totals in
  decimal GB, current rates and antenna-alignment graphs/comparisons.

The test router runs build49 plus the verified web updates. T99 Status readings
and automatic refresh, long Cyrillic SMS receive/send/delete, and Radio settings
read/no-op apply have been confirmed on the router. Actual radio setting changes
remain hardware-unverified in this candidate; L860 has rendering fixtures but
was not retested during this T99 web integration.

The next full firmware build has not been launched. The CI configuration retains
OpenWrt commit `6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932` and adds web/backend
fixtures using the host ucode runtime from that pinned source. The final
sysupgrade root is checked for the expected VT Modem source files and executable
helpers, in addition to the kernel limit and NAND upgrade routing checks.

See [the integration record](docs/web-integration-20260913.md) for verified scope,
build gates and the remaining image review. The audit follow-up now pins all
five feed revisions, preserves configured/saved LAN MACs and strengthens the
actual-image checks. See [build validation](docs/build-validation.md) and
[retired historical hotfixes](docs/historical-hotfixes.md). These source changes
have not yet been built into a new firmware or tested on the router.

See [the release 19 implementation record](docs/firmware-r19-20260913.md) for the
audit-to-fix mapping, host tests, traffic persistence limits and next build/device
checks. The current runtime and release 19 source candidate are distinct versions.
