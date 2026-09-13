#!/bin/sh
# Install only the SMS frontend. No service or modem connection is restarted.
set -eu
cd "$(dirname "$0")/.."
test "$(cat /tmp/sysinfo/board_name)" = 'vertell,vt-mt7621d'
test "$(uci -q get network.modem.proto)" = 't99w175qmi'
sha256sum -c SHA256SUMS

src=package/vtmodem/files/www/luci-static/resources/view/vtmodem/sms.js
target=/www/luci-static/resources/view/vtmodem/sms.js
expected_base=6105f7d120e43a9fbddba6b818f7f7468d29d0836f961145756951230d31ef50
actual=$(sha256sum "$target" | cut -d ' ' -f 1)
updated=$(sha256sum "$src" | cut -d ' ' -f 1)
if [ "$actual" = "$updated" ]; then
	echo VT_SMS_WEB_INSTALLED
	exit 0
fi
if [ "$actual" != "$expected_base" ]; then
	echo "STOP: unexpected existing file $target" >&2
	exit 1
fi

backup=$(mktemp -d /root/vt-sms-web-backup.XXXXXX)
cp -p "$target" "$backup/sms.js"
echo "BACKUP=$backup"

rollback() {
	rc=$?
	trap - EXIT HUP INT TERM
	set +e
	rm -f "$target.vt-new"
	if cp -p "$backup/sms.js" "$target"; then
		echo "INSTALL_FAILED: previous SMS page restored from $backup" >&2
	else
		echo "INSTALL_FAILED: rollback needs attention; backup is $backup" >&2
	fi
	exit "$rc"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$src" "$target.vt-new"
chmod 644 "$target.vt-new"
mv -f "$target.vt-new" "$target"
cmp "$src" "$target"
trap - EXIT HUP INT TERM
echo VT_SMS_WEB_INSTALLED
