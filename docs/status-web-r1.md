# Status web update r1

This update adds automatic refresh and Russian labels to the verified telemetry
r4 Status page. It is layered on the radio web r1 branch; SMS and Radio controls
are unchanged.

## Behavior

- Refresh is enabled at 30 seconds by default. Choices are Off, 10, 30, and 60
  seconds. The next interval starts after the previous request completes.
- Manual refresh reads the status RPC without reloading the page. Concurrent
  frontend refresh attempts share the pending request.
- The page shows the browser-local time of the last successful response. Failed
  reads keep the previous values and display an error. Initial failure leaves a
  usable retry button; a valid `present: false` response shows modem absence.
- Hidden tabs pause automatic reads. Returning to a visible tab reads once when
  automatic refresh is enabled. Off also disables this automatic resume read.
- Navigation removes timers and listeners. Mobile browser Back/Forward cache
  suspension and restoration preserve the selected interval.
- Existing T99W175 QMI, temperature, carrier, SIM, session, DNS and Raw IP fields
  are preserved. L860 rendering remains supported. Only exactly duplicated
  operator phrases are collapsed.

This limits concurrent frontend requests; a browser transport timeout does not
prove that an already dispatched backend operation has stopped. The backend and
its existing timeouts are not modified by this update. Refresh selection is local
to the page and resets to 30 seconds on a new page load.

## Package and installation

Build a reproducible offline archive:

```sh
python3 scripts/package-status-web.py /tmp/vt-status-web-r1.zip
```

Copy the extracted `vt-status-web` directory into the router's `/tmp`, then run:

```sh
sh /tmp/vt-status-web/scripts/install-status-web.sh
```

The installer verifies the archive manifest, board, protocol, and the exact
telemetry r4 Status page baseline. It accepts a repeated install of the same
update, backs up the prior page with a `restore.sh`, and replaces only
`/www/luci-static/resources/view/vtmodem/status.js`. It does not restart services,
write radio settings, or flash firmware. Reopen the page with a fresh browser
cache after installation.

## Validation

```sh
node scripts/tests/test-vtmodem-status.js
node scripts/tests/test-vtmodem-status-refresh.js
sh -n scripts/install-status-web.sh
```

Rendering fixtures cover the existing telemetry fields and labels. Deterministic
refresh tests cover timing, request coalescing, error recovery, valid modem
absence, hidden tabs, interval changes, detachment and Back/Forward cache
lifecycle. Installation and automatic refresh on the router require the next
user verification; the preceding radio no-op apply has already been confirmed.
