#!/bin/sh
# Update only the Status page; no service restart or modem command.
set -eu
cd "$(dirname "$0")/.."
test "$(cat /tmp/sysinfo/board_name)" = 'vertell,vt-mt7621d'
test "$(uci -q get network.modem.proto)" = 't99w175qmi'
sha256sum -c SHA256SUMS
src=package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js
target=/www/luci-static/resources/view/vtmodem/status.js
test -f "$target"
test ! -L "$target"
expected_base=2c23385ef3d7188a6a361e066e4b2f916a223fcd16353fe37664581f5b52c85b
actual=$(sha256sum "$target" | cut -d ' ' -f 1)
updated=$(sha256sum "$src" | cut -d ' ' -f 1)
if [ "$actual" = "$updated" ]; then
	echo VT_STATUS_WEB_INSTALLED
	exit 0
fi
if [ "$actual" != "$expected_base" ]; then
	echo "STOP: unexpected existing file $target" >&2
	exit 1
fi

backup=$(mktemp -d /root/vt-status-web-backup.XXXXXX)
cp -p "$target" "$backup/status.js"
cat > "$backup/restore.sh" <<'RESTORE'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
target=/www/luci-static/resources/view/vtmodem/status.js
cp -p status.js "$target.vt-status-restore"
mv -f "$target.vt-status-restore" "$target"
echo VT_STATUS_WEB_RESTORED
RESTORE
chmod 700 "$backup/restore.sh"
echo "BACKUP=$backup"
rollback() {
	rc=$?
	trap - EXIT HUP INT TERM
	rm -f "$target.vt-status-new"
	if sh "$backup/restore.sh"; then
		echo "INSTALL_FAILED: previous Status page restored from $backup" >&2
	else
		echo "INSTALL_FAILED: restore needs attention; backup is $backup" >&2
	fi
	exit "$rc"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$src" "$target.vt-status-new"
chmod 644 "$target.vt-status-new"
mv -f "$target.vt-status-new" "$target"
cmp "$src" "$target"
trap - EXIT HUP INT TERM
echo VT_STATUS_WEB_INSTALLED
