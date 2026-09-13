# VT Modem web integration — 2026-09-13

The router currently runs build49 plus the installed web updates. This source
candidate combines that verified state and prepares validation for the next
complete firmware image. No firmware build, merge or flash is part of this change.

## Verification record

| Component | Hardware evidence |
| --- | --- |
| T99 QMI and LuCI protocol | Connected session and working Interfaces editor |
| Telemetry r4 | Signal, temperature, B3+B1 aggregation, cells, ICCID, address, DNS and Raw IP display |
| SMS web r1 | Long Cyrillic incoming text grouped correctly; sending and deletion confirmed |
| Radio web r1 | Mode/band/priority/lock reads displayed; applying the current permanent LTE-only value correctly returned no change |
| Status web r1 | Russian labels and populated readings displayed; automatic timestamp update explicitly confirmed |

Radio writes that actually alter the selected setting are covered by mocked
fixtures, not by the hardware no-op test. L860 rendering remains covered by
fixtures; no new L860 hardware test occurred in this sequence.

The final runtime files from telemetry r4, SMS r1, Radio r1 and Status r1 match
the inherited source at `0bd441138ff12eb7a5ccb1853af56239b27c76b8` byte for byte.
The LuCI `t99w175qmi.js` protocol file also matches its previously installed hash.
All are installed by `package/vtmodem/Makefile`, release 18.

## Build gates

1. The startup handoff fixtures and firmware-root validator negative fixtures
   run before the firmware build.
2. CI builds host ucode from the pinned OpenWrt tree, including its patches and
   host `fs` module. Four Node suites and eight ucode suites must pass before the
   target firmware build starts. Tests use fixtures and do not address a modem.
3. Firmware collection checks the NAND upgrade handler, sysupgrade archive,
   legacy uImage header and the 4 MiB kernel limit.
4. It extracts the actual sysupgrade squashfs root with the build's
   `unsquashfs4`. Every VT package runtime source file must match exactly at its
   installed path; scripts must be executable. Compiled AT/SMS helpers must be
   executable 32-bit little-endian MIPS ELF files. The resulting hashes are
   saved in `VT_MODEM_FILES.txt` and `VALIDATION.txt`.

These checks catch missing, stale or incorrectly installed web files; they do
not prove radio connectivity or guarantee a successful firmware upgrade.
The OpenWrt source remains pinned to
`6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932`. Feeds still follow their configured
branches, so this is not a fully pinned reproduction of every build dependency.

## Remaining steps

- Launch a build from this integration branch after the build instruction.
- Inspect that run's final image, validation report, metadata and checksums.
- Provide an image-specific upgrade procedure; router flashing is a separate
  action from compilation and can interrupt the connection.
- Verify startup and the web pages after the full-image installation.

Status refresh tests have passed locally on the exact build49 host interpreter.
The new CI host-build sequence and extraction of the next real image will be
verified by the next build; neither has been reported as already completed.
