# Build 51: first boot on the offline L860 test router

These observations come from the user's physical VT-STREET-M2 test router.
They do not establish cellular connectivity or modify the working T99 router.

## Installed image

- Build run: `51`; VT Modem: `release-19`.
- Port commit: `7f9f32eca371b89397eefc186fdcc69b027482db`.
- OpenWrt commit: `6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932`.
- Sysupgrade SHA256:
  `7df946e454ea279557ffa44ec382a9607bdc5c3112a11726a0d175d4ac7edca8`.
- The image hash matched on Windows and the router; `sysupgrade -T` returned 0.
- The configuration backup was copied to Windows and its hash matched.
- An upgrade preserving configuration completed, and SSH/LuCI became accessible.
- `/etc/vt-build.json` confirmed the build and source identity after boot.

## Observed runtime state

- `vtmodem-collector` and `vtmodem-traffic` reported `running`.
- Detection returned `fibocom-l860`, `present: true`, and SIM `READY`.
- The overall telemetry cache was fresh, with no collector error.
- Three network devices were bound to `cdc_ncm`: `wwan0` on USB interface 6,
  `wwan1` on interface 8, and `wwan2` on interface 10. All three were down.
- `ifstatus modem` returned `Interface modem not found`.
- The router clock was still at the image's September 10 date. Traffic status
  was `waiting_for_time`, with no enrolled interfaces or history.
- `vt-at -t 3000 /dev/ttyACM0 AT+XMCI=1` returned no stdout and exit status 0.
  Build 51 classified that sample as `unrecognized_reply`.

An empty successful XMCI result establishes the absence of measurement text in
that response. It does not independently establish registration state, modem
failure, or a particular reason for the absence of measurements. The source
fix accepts this specific empty L860 response and clears an older cell value;
nonempty unrecognized replies and failed queries remain errors. That fix is
not part of the installed build 51.

## Integration limits and remaining checks

Build 51 includes L860 USB drivers, detection, and telemetry. Its automatic
network setup and dedicated netifd protocol are T99-specific. The traffic
collector enrolls only an up `network.interface.modem` using `t99w175qmi` and
a valid `wwanN` device. Thus correcting the clock alone cannot enable L860
traffic accounting. Merely summing all three NCM devices, or assigning the T99
protocol to L860, would not establish the correct data-session binding.

Next offline checks are setting the real router time, exercising the web
clock-confirmation path, and inspecting the UI when no data interface is
available. Real L860 connection setup, the NCM/PDP mapping, and L860 accounting
need separate implementation and validation. Cellular data, real CA, SMS,
traffic growth/history persistence, modem removal/reappearance, and bootloader
recovery have not been verified by these observations.
