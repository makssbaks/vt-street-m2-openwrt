#!/bin/sh
# Apply the standalone telemetry bundle to build 49 with the LuCI protocol fix.
# The caller runs this file with sh; no network service is restarted.
set -eu

cd "$(dirname "$0")/.."
test "$(cat /tmp/sysinfo/board_name)" = 'vertell,vt-mt7621d'
test "$(uci -q get network.modem.proto)" = 't99w175qmi'
sha256sum -c SHA256SUMS
command -v ucode >/dev/null

src=package/vtmodem/files
rpc=usr/share/rpcd/ucode/vtmodem
ui=www/luci-static/resources/view/vtmodem/status.js
files="usr/share/vtmodem/qmi.uc usr/share/vtmodem/qmi-status.uc $rpc $ui"

hash_of() {
	sha256sum "$1" | cut -d ' ' -f 1
}

check_base() {
	actual=$(hash_of "/$1")
	updated=$(hash_of "$src/$1")
	if [ "$actual" != "$2" ] && [ "$actual" != "$updated" ]; then
		echo "STOP: unexpected existing file /$1" >&2
		exit 1
	fi
}

check_base "$rpc" 1240a0ba09cbaa073efddbadd60a49cbeb6a4a17559d5668aa5be48f792685f8
check_base "$ui" 6d1ed0f7c3b397c28d0ad09e8ad004e136cf7585ec4c917f06f13b2e0ac0b0f6
for rel in usr/share/vtmodem/qmi.uc usr/share/vtmodem/qmi-status.uc; do
	if [ -e "/$rel" ] && ! cmp -s "/$rel" "$src/$rel"; then
		echo "STOP: unexpected existing file /$rel" >&2
		exit 1
	fi
done

# Validate on the router's own interpreter, before changing installed files.
ucode scripts/tests/test-t99-qmi.uc
ucode scripts/tests/test-t99-qmi-supervisor.uc
ucode -c -o /dev/null "$src/usr/share/vtmodem/qmi-status.uc"
ucode -c -o /dev/null "$src/$rpc"

backup=$(mktemp -d /root/vt-telemetry-backup.XXXXXX)
for rel in $files; do
	mkdir -p "$backup/$(dirname "$rel")"
	if [ -e "/$rel" ]; then
		cp -p "/$rel" "$backup/$rel"
	else
		: > "$backup/$rel.absent"
	fi
done
echo "BACKUP=$backup"

rollback() {
	rc=$?
	trap - EXIT HUP INT TERM
	set +e
	restored=1
	for rel in $files; do
		rm -f "/$rel.vt-new" || restored=0
		if [ -e "$backup/$rel.absent" ]; then
			rm -f "/$rel" || restored=0
		else
			cp -p "$backup/$rel" "/$rel" || restored=0
		fi
	done
	/etc/init.d/rpcd restart || restored=0
	if [ "$restored" = 1 ]; then
		echo "INSTALL_FAILED: previous files restored from $backup" >&2
	else
		echo "INSTALL_FAILED: rollback needs attention; backup is $backup" >&2
	fi
	exit "$rc"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for rel in $files; do
	mkdir -p "/$(dirname "$rel")"
	cp "$src/$rel" "/$rel.vt-new"
	chmod 644 "/$rel.vt-new"
	mv -f "/$rel.vt-new" "/$rel"
done

/etc/init.d/rpcd restart
ready=0
for attempt in 1 2 3 4 5; do
	if ubus -t 2 -v list vtmodem 2>/dev/null | grep -q '"status"'; then
		ready=1
		break
	fi
	sleep 1
done
test "$ready" = 1

trap - EXIT HUP INT TERM
echo T99_TELEMETRY_INSTALLED
