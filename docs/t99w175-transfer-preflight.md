# T99W175 transfer preflight

This branch is a build/test candidate, NOT approval to flash the working router.
Base: 8c5e424296e0fcb8bfb1090305b7ff4a05fc2403.

## Scope

- Keep the standalone t99w175qmi protocol and existing internal SMS lock.
- Hand USB readiness to netifd even when UCI configuration is unchanged.
- Restore available=true after NO_DEVICE; use the non-reloading ubus up method
  only for an idle, auto-enabled t99w175qmi interface.
- Do not restart UP/PENDING interfaces or override auto=0/manual disconnect.
- Use bounded retries for a late network ubus object and an exclusive worker lock.
- Add an S95 boot-only USB reconciliation sweep, in addition to hotplug events.
- Do not reintroduce ModemExpert, observer/recovery scripts or a USB power cycle.
  USB power is already enabled by the board DTS. Whether a T99 needs a power
  cycle on this board is a hardware-test question, not settled by these tests.
- Separate network and firewall reloads; no delayed /sbin/ifup reload.

## Tests

Run: python3 scripts/test-t99w175-net-ready.py
The tests run in /bin/sh and, when installed, BusyBox ash. They mock USB readiness,
UCI, ubus and JSON field extraction and use a real host flock for serialization.
They do NOT test physical enumeration, the target netifd implementation,
registration, Internet traffic or SMS. CI runs them before building the image.

## Remaining gates before production installation

1. Successful firmware build and inspection of the image/installed helper,
   S95 symlink, dependencies, flash metadata, kernel size and NAND offsets.
2. Private backup of the WORKING router's configuration and custom scripts,
   copied OFF the router; separately verify the recovery image/procedure.
   A configuration archive is not a full NAND backup or a recovery guarantee.
3. Check the working SIM selector and any required TTL/radio settings. Do not
   infer missing options from a filtered network dump or publish private values.
4. Do not restore the old configuration wholesale, or the SMS shell-lock test
   wrapper on top of the internally locking SMS binary.
5. Hardware acceptance on T99: clean boot and reboot, automatic QMI address,
   default route, DNS and client Internet. Then receive/send multipart SMS.
   Operator whitelist restrictions alone must never trigger modem resets.

Current agreed WAN values are APN internet, authentication none and IPv4;
LAN remains 192.168.1.1/24. No working router changes are made by this branch.
