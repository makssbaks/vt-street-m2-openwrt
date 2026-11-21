# VT Modem release 21 — image audit and connection controls

## Audited baseline (not a hardware certification)

The completed build 53 uses source `8f3882f0ea7148ea21aed5575d7ecc1f2d971140`.
OpenWrt remains pinned at `6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932`.

- Artifact ZIP SHA256: `b7bd56e46313520c65cd53f128e97a757ffa71dc0f2c48f5ae3a75f400ee5033`.
- Sysupgrade SHA256: `2dcd96f6226a85ee56417a50defa8232abe296847a852455230e93c7d905b150`.
- Image metadata: `vertell,vt-mt7621d`, `ramips/mt7621`, compatibility 1.1.
- uImage: 3,423,538 bytes, valid header/payload CRCs, MIPS/LZMA,
  load/entry `0x80001000`; fits the existing 4 MiB kernel partition.
- All 42 VT package/runtime files checked against the immutable baseline.
- All 193 ELF files were 32-bit little-endian MIPS; 443 DT_NEEDED library
  references resolved inside the extracted root, including absolute symlinks.
- The actual build-53 target ucode/musl/fs runtime passed control, SMS-job and
  RPC fixtures under QEMU. This is additional to the existing host CI tests.
- No personal SSH keys or pre-generated Dropbear host keys were found in the
  factory image. Clean installation has the standard empty root password:
  configure credentials locally before exposing management access.

## Changes in release 21

### Mobile data session controls on the Status page

`Включить интернет`, `Отключить интернет`, `Переподключить`, and a read-only
`Проверить соединение` are placed together above the telemetry overview.

Only `network.interface.modem` with `proto=t99w175qmi` is eligible. Mutations
require a write ACL, explicit confirmation, a fresh boot/session token and a
32-hex-character request ID. An exclusive transaction lock and bounded private
RAM receipts prevent overlapping actions and same-ID transport replays.

Reconnect sends `down` then `up` from a single isolated server-side worker;
closing the browser does not split these into two browser-dependent actions.
An up request is made once even if the down acknowledgement is lost; such a
case is reported uncertain, not successful. Receipts are stored before actions,
retained for one hour (maximum 64), and never silently evicted to admit a write.
A worker crash is not a reason to replay a possibly completed operation.

No USB reset, AT/CFUN command, radio/band/cell-lock change, whole-network reload,
router reboot or persistent UCI change is issued. Runtime Stop lasts until
explicit Up or a subsequent router boot. Existing hotplug code already respects
netifd's `autostart=false`; its tests are retained. Netifd/QMI own teardown,
cleanup and reconnection, rather than a second direct QMI session owner.

The UI never equates `up=true` with unrestricted Internet. It polls live state
only after a requested action, with a finite observation budget, and does not
repeat writes on timeout. Normal telemetry polling is not increased.

### Actual parser/validation issues

- Accept a single trailing comma after parenthesized `LTE_LOCK` pairs, as seen
  in the hardware transcript (`^LTE_LOCK:(213,1275),`). Reject duplicate pairs,
  extra commas/garbage and invalid bounds as before.
- Correct the release-20 assumption about priority: empty/OK-only responses or
  an empty `^BAND_PRI:` field are **unknown**, not confirmed unset. An explicit
  missing-priority message is recognized, with optional command echo/prefix.
  Failed field reads now expose bounded diagnostic code/output instead of
  conflating all failures. Unknown fields remain non-writable.
- Align the minimum SMS fingerprint to the C helper: two bytes/four hex
  characters, even length, uppercase hex, maximum 512 bytes. UI also checks
  ID/part-count bounds. The release-20 regexp fix and protection against
  repeating uncertain SMS operations remain enabled.

### Remove redundant components, preserve working networking

- Remove unused `uqmi` and its `wwan` helper package from seed/device defaults.
  The custom protocol uses `qmi-utils`/`qmicli`; its USB/QMI drivers are retained.
- Disable stock vnstat service autostart on first boot/upgrade; the VT traffic
  service already manages its own vnstatd and database. The binary, history
  backup, flush checks and custom counter service remain installed.
- Declare the `rpcd-mod-ucode` runtime dependency explicitly.
- Keep existing QMI lifecycle, USB hotplug, board/DTS/NAND layout, L860 support,
  firewall, DNS, NTP, watchdog and bounded helper timeouts. Do not add an
  operator-ICMP-triggered reset loop or unverified offload/MTU/TTL tuning.

## Validation added

The connection API/UI have isolated fixtures for confirmation, read-only ACLs,
stale session/boot tokens, duplicate IDs, cancelled modals, hidden/detached tabs,
limited polling, unknown outcomes, server-side down/up and storage failures.
Image promotion now additionally requires ELF dependency/inventory checks and
pure fixtures on the **actual MIPS/musl interpreter from the built image**.
Host tests cannot alone catch target-libc regexp limitations.

The traffic lifecycle test uses bounded event waits instead of racing process
startup/logging with fixed 100–200 ms sleeps; no production traffic lifecycle
was changed for that test adjustment. The outer Python-suite deadline is now
120 seconds on loaded CI hosts (a complete local lifecycle run took 87 seconds);
all assertions and production modem deadlines remain unchanged.

## Remaining acceptance on the real router

No working router was accessed or modified during this audit. Static and QEMU
checks do not establish RF quality, operator policy, physical NAND/USB stability,
or successful cold boot/recovery. After a separately authorized upgrade with a
backup, validate LAN/SSH access, fresh telemetry, SMS operations, manual Stop/Up,
new QMI session on Reconnect, and sustained traffic on the actual SIM. The UI
control cannot remove an operator whitelist or SIM activation restriction.
