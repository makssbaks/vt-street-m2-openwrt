#!/bin/sh
# Install the radio page and RPC helper; never change modem/network settings.
set -eu
cd "$(dirname "$0")/.."
test "$(cat /tmp/sysinfo/board_name)" = 'vertell,vt-mt7621d'
test "$(uci -q get network.modem.proto)" = 't99w175qmi'
command -v ucode >/dev/null
command -v flock >/dev/null
sha256sum -c SHA256SUMS
src=package/vtmodem/files
files='usr/share/vtmodem/t99-control.uc usr/share/vtmodem/control-worker.uc usr/libexec/vtmodem-radio usr/share/rpcd/ucode/vtmodem usr/share/rpcd/acl.d/luci-app-vtmodem.json usr/share/luci/menu.d/luci-app-vtmodem.json www/luci-static/resources/view/vtmodem/radio.js'

hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
check_base() {
	actual=$(hash_of "/$1")
	updated=$(hash_of "$src/$1")
	if [ "$actual" != "$2" ] && [ "$actual" != "$updated" ]; then
		echo "STOP: unexpected existing file /$1" >&2
		exit 1
	fi
}
check_base usr/share/rpcd/ucode/vtmodem 258046e839bd023e15f31c844e16119de5c06d94786d4973162f3d78544d9a47
check_base usr/share/rpcd/acl.d/luci-app-vtmodem.json 45668bd9659f905c38b126afb08f3c23690a97963bb214c6b1f90edd881f6b54
check_base usr/share/luci/menu.d/luci-app-vtmodem.json 6a09498f63bd43214f6122be91adb17564380c8e93805ea05b5bd0b0e1914aec
test "$(hash_of /usr/share/vtmodem/qmi.uc)" = 91dd9fdc6575ba80c4030ff6d85bdf92ce6cf44824dd142aa015b183fd4aabe7
for f in usr/share/vtmodem/t99-control.uc usr/share/vtmodem/control-worker.uc usr/libexec/vtmodem-radio www/luci-static/resources/view/vtmodem/radio.js; do
	if [ -e "/$f" ]; then
		test "$(hash_of "/$f")" = "$(hash_of "$src/$f")" || {
			echo "STOP: unexpected existing file /$f" >&2
			exit 1
		}
	fi
done
for f in $files; do
	if [ -L "/$f" ] || { [ -e "/$f" ] && [ ! -f "/$f" ]; }; then
		echo "STOP: expected regular file /$f" >&2
		exit 1
	fi
done

# Tests use fixtures and injected runners: no AT command is sent.
ucode scripts/tests/test-t99-control.uc
ucode scripts/tests/test-t99-control-rpc.uc
ucode -c -o /dev/null "$src/usr/share/vtmodem/control-worker.uc"
ucode -c -o /dev/null "$src/usr/share/rpcd/ucode/vtmodem"
sh -n "$src/usr/libexec/vtmodem-radio"

backup=$(mktemp -d /root/vt-radio-web-backup.XXXXXX)
mkdir -p "$backup/files"
for f in $files; do
	printf '%s\n' "$f" >> "$backup/paths"
	if [ -f "/$f" ]; then
		mkdir -p "$backup/files/$(dirname "$f")"
		cp -p "/$f" "$backup/files/$f"
	fi
done
cat > "$backup/restore.sh" <<'RESTORE'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
while IFS= read -r f; do
	case "$f" in
		usr/share/vtmodem/t99-control.uc|usr/share/vtmodem/control-worker.uc|usr/libexec/vtmodem-radio|usr/share/rpcd/ucode/vtmodem|usr/share/rpcd/acl.d/luci-app-vtmodem.json|usr/share/luci/menu.d/luci-app-vtmodem.json|www/luci-static/resources/view/vtmodem/radio.js) ;;
		*) echo 'STOP: invalid backup path' >&2; exit 1 ;;
	esac
	rm -f "/$f.vt-radio-new"
	if [ -f "files/$f" ]; then
		cp -p "files/$f" "/$f"
	else
		rm -f "/$f"
	fi
done < paths
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*.json
/etc/init.d/rpcd restart
echo VT_RADIO_WEB_RESTORED
RESTORE
chmod 700 "$backup/restore.sh"
echo "BACKUP=$backup"
rollback() {
	rc=$?
	trap - EXIT HUP INT TERM
	if sh "$backup/restore.sh"; then
		echo "INSTALL_FAILED: previous files restored from $backup" >&2
	else
		echo "INSTALL_FAILED: restore needs attention; backup is $backup" >&2
	fi
	exit "$rc"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for f in $files; do
	mkdir -p "/$(dirname "$f")"
	cp "$src/$f" "/$f.vt-radio-new"
	case "$f" in usr/libexec/*) chmod 755 "/$f.vt-radio-new" ;; *) chmod 644 "/$f.vt-radio-new" ;; esac
	mv -f "/$f.vt-radio-new" "/$f"
	cmp "$src/$f" "/$f"
done
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*.json
/etc/init.d/rpcd restart
trap - EXIT HUP INT TERM
echo VT_RADIO_WEB_INSTALLED
