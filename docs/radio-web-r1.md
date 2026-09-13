# T99W175 radio web controls, r1

This patch adds a Radio tab to VT Modem on the build 49 firmware with telemetry
r4 installed. It preserves the existing Status and SMS pages and protocol.
The installer updates the RPC helper, access rules, menu and Radio page. It
restarts rpcd to load the new methods; it does not restart netifd, WAN, USB or
the modem, and it sends no AT commands during installation.

## Verified input

User-provided T99W175 GC.004 query responses are stored as six fixtures:
permanent LTE-only mode, 30 supported LTE bands, LTE/NR5G B71 disabled, and
no configured priority or cell lock. Query support is hardware-verified;
the write paths still require hardware verification after installation.

## Controls

- Mode and persistence, restricted to the modem's reported capabilities.
- Desired enabled LTE band set, preserving 3G/5G settings.
- Ordered LTE scan priority (not a guarantee of the primary carrier).
- Up to eight PCI/EARFCN pairs and a separate unlock action.

Writes require the write ACL, an explicit confirmation, an unchanged snapshot,
and validated input. The helper reads settings again after writes. Unknown or
partial results never become success and are never retried or rolled back
automatically. The page preserves drafts and requires an explicit reread before
another action. A separate configuration flock covers the transaction; vt-at
retains exclusive ownership of its own AT-port lock.

BAND_PREF enable behavior is not assumed to be additive on every firmware.
When enabling is needed, a single desired list of at most 15 bands is sent.
Only exact replacement or additive readback is accepted. Extra enabled bands
are disabled in groups of at most 15 with exact readback after every group.
A desired set above 15 is supported only when all selected bands are already
enabled. The helper rejects band changes while a cell lock is configured.

Mode changes require the modem already to report CFUN=1. Priority and cell-lock
changes are reported as saved settings requiring a later modem reboot. This
patch never performs that reboot. BAND_PREF does not require a reboot. No bare
band reset or undocumented priority-clear command is exposed.

The conservative per-operation command budget is 55 seconds; the longest
supported sequence accounts for 52.5 seconds. HTTP requests use a dedicated
90-second deadline without changing LuCI's global timeout. rpcd's synchronous
helper can delay other rpcd requests during an operation. A transport failure
does not cancel or prove the absence of modem-side changes; reread before
another action.

## Verification and packaging

Run the ucode tests with the exact interpreter pinned by build49:

```
ucode scripts/tests/test-t99-control.uc
ucode scripts/tests/test-t99-control-rpc.uc
node scripts/tests/test-vtmodem-radio-controls.js
python3 scripts/package-radio-web.py /path/to/vt-radio-web-r1.zip
```

Tests use fixtures and injected runners; they never send live AT commands.
They cover actual query formats, malformed/unknown state, stale snapshots,
validation, lock conflicts, additive/replacement behavior, partial writes,
timeouts, readback mismatches, explicit confirmation, read-only access and
transport failures. Browser layout on the actual router remains to be checked.

The offline installer verifies exact telemetry-r4/baseline hashes, runs ucode
tests before replacing files, backs up old files and provides
`/root/vt-radio-web-backup.XXXXXX/restore.sh`. That script restores the files
and reloads rpcd; it does not revert radio settings stored by a later user action.

## References

- [MV31-W AT command set](https://www.codico.com/media/productattach/m/v/mv31_w_atc_v00058_2111538_1.pdf),
  sections 14.25, 14.32, 14.35, 14.48. This related-module reference is not a
  substitute for GC.004 hardware write verification.
- [LuCI RPC API](https://openwrt.github.io/luci/jsapi/rpc.js.html).
- [LuCI request implementation](https://github.com/openwrt/luci/blob/master/modules/luci-base/htdocs/luci-static/resources/luci.js).
