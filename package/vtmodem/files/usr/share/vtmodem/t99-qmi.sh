#!/bin/sh
# Shared QMI lifecycle primitives. State is private, volatile and never sourced.
QMI_ROOT="${QMI_ROOT:-/tmp/vt-qmi}"

qmi_now() { cut -d. -f1 /proc/uptime; }

qmi_usb_generation() {
	local path root bus num inode value
	path="$(readlink -f "/sys/class/usbmisc/${1##*/}/device" 2>/dev/null)"
	[ -n "$path" ] || return 1
	# Canonical sysfs nests interfaces below the USB device directory:
	# .../usb1/1-1/1-1:1.4, not .../usb1/1-1:1.4.
	root="${path%/*}"
	[ "$(cat "$root/idVendor" 2>/dev/null)" = 05c6 ] || return 1
	[ "$(cat "$root/idProduct" 2>/dev/null)" = 9025 ] || return 1
	bus="$(cat "$root/busnum" 2>/dev/null)"
	num="$(cat "$root/devnum" 2>/dev/null)"
	# BusyBox stat is disabled in the base profile; ls -di is available.
	inode="$(ls -di "$root" 2>/dev/null | awk '{ print $1 }')"
	for value in "$bus" "$num" "$inode"; do
		case "$value" in ''|*[!0-9]*) return 1 ;; esac
	done
	printf '%s:%s:%s:%s\n' "$root" "$bus" "$num" "$inode"
}

qmi_same_device() {
	local saved current
	[ -d "$QMI_STATE" ] || return 1
	saved="$(cat "$QMI_STATE/generation" 2>/dev/null)" || return 1
	[ -n "$saved" ] || return 1
	current="$(qmi_usb_generation "$device")" || return 1
	[ "$saved" = "$current" ]
}

qmi_owned() {
	qmi_same_device && [ ! -e "$QMI_STATE/cancelled" ]
}

qmi_call() {
	if [ -n "$QMI_STATE" ]; then
		qmi_same_device || return 125
		[ "$QMI_CLEANUP" = 1 ] || [ ! -e "$QMI_STATE/cancelled" ] || return 125
	fi
	# Integer seconds work with the BusyBox timeout/sleep configuration.
	LC_ALL=C timeout -s KILL "${QMI_TIMEOUT:-8}" qmicli "$@"
}

qmi_new_state() {
	local generation
	generation="$(qmi_usb_generation "$device")" || return 1
	QMI_STATE="$(mktemp -d "$QMI_ROOT/$interface/session.XXXXXX")" || return 1
	printf '%s\n' "$generation" >"$QMI_STATE/generation"
	printf '%s\n' "$device" >"$QMI_STATE/device"
	printf '%s\n' "$ifname" >"$QMI_STATE/ifname"
	printf '%s\n' "$QMI_STATE" >"$QMI_ROOT/$interface/current.new"
	mv "$QMI_ROOT/$interface/current.new" "$QMI_ROOT/$interface/current"
}

qmi_alloc_wds_cid() {
	local device="$1" family="$2" output rc cid
	output="$QMI_STATE/alloc_$family"
	# Keep the output outside the setup process. If netifd kills that process,
	# the bounded child still owns lock fd 9 until its output has been stored.
	: >"$QMI_STATE/alloc_pending_$family"
	qmi_call -d "$device" -p --wds-noop --client-no-release-cid >"$output" 2>/dev/null
	rc=$?
	cid="$(awk -F"'" '/CID:/ && $2 ~ /^[0-9]+$/ { print $2; exit }' "$output")"
	if [ -n "$cid" ]; then
		printf '%s\n' "$cid" >"$QMI_STATE/cid_$family"
		printf '%s\n' "$cid"
	elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
		: >"$QMI_STATE/uncertain"
	fi
	rm -f "$QMI_STATE/alloc_pending_$family"
	[ "$rc" -eq 0 ] && [ -n "$cid" ]
}

qmi_start_bearer() {
	local device="$1" cid="$2" family="$3" apn="$4" auth="$5" user="$6" pass="$7"
	local args="ip-type=$family" pdh output
	# Setup rejects single quotes/newlines; quoted values preserve spaces/commas.
	[ -n "$apn" ] && args="$args,apn='$apn'"
	[ "$auth" = NONE ] || args="$args,auth=$auth"
	[ -n "$user" ] && args="$args,username='$user'"
	[ -n "$pass" ] && args="$args,password='$pass'"
	output="$QMI_STATE/start_$family"
	qmi_call -d "$device" -p --client-cid="$cid" --client-no-release-cid \
		--wds-start-network="$args" >"$output" 2>/dev/null || return 1
	pdh="$(awk -F"'" '/Packet data handle:/ && $2 ~ /^[0-9]+$/ { print $2; exit }' "$output")"
	[ -n "$pdh" ] || return 1
	printf '%s\n' "$pdh" >"$QMI_STATE/pdh_$family"
	printf '%s\n' "$pdh"
}

qmi_packet_state() {
	qmi_call -d "$1" -p --client-cid="$2" --client-no-release-cid \
		--wds-get-packet-service-status 2>/dev/null |
		awk -F"'" '/Connection status:/ { print $2; exit }'
}

qmi_prepare_raw_ip() {
	local device="$1" ifname="$2" rawfile="${QMI_SYSNET:-/sys/class/net}/$2/qmi/raw_ip" raw
	[ -r "$rawfile" ] || return 1
	qmi_call -d "$device" -p --wda-set-data-format=link-layer-protocol=raw-ip >/dev/null 2>&1 || true
	# A failed/unsupported setter is acceptable only if a read confirms Raw IP.
	raw="$(qmi_call -d "$device" -p --wda-get-data-format 2>/dev/null)" || return 1
	printf '%s\n' "$raw" | grep -Eq "Link layer protocol: *'raw-ip'" || return 1
	if ! grep -qx Y "$rawfile"; then
		[ -w "$rawfile" ] || return 1
		ip link set dev "$ifname" down >/dev/null 2>&1 || return 1
		printf 'Y\n' >"$rawfile" || return 1
	fi
	grep -qx Y "$rawfile" || return 1
	ip link set dev "$ifname" up >/dev/null 2>&1
}

qmi_wait_registered() {
	local device="$1" deadline state remaining QMI_TIMEOUT
	deadline=$(($(qmi_now) + $2))
	while :; do
		remaining=$((deadline - $(qmi_now)))
		[ "$remaining" -gt 0 ] || return 1
		QMI_TIMEOUT="$remaining"
		[ "$QMI_TIMEOUT" -le 8 ] || QMI_TIMEOUT=8
		state="$(qmi_call -d "$device" -p --nas-get-serving-system 2>/dev/null |
			awk -F"'" '/Registration state:/ { print $2; exit }')"
		[ "$state" = registered ] && return 0
		qmi_owned || return 1
		sleep 1
	done
}

qmi_valid_ip4() {
	printf '%s\n' "$1" | awk -F. 'NF != 4 { exit 1 } { for (i=1;i<=4;i++) if ($i !~ /^[0-9]+$/ || $i>255) exit 1; if ($1==0 || $1>=224) exit 1 }'
}

qmi_valid_mask4() {
	printf '%s\n' "$1" | awk -F. 'NF != 4 { exit 1 } { zero=0; for(i=1;i<=4;i++) { if ($i !~ /^[0-9]+$/ || (zero && $i!=0)) exit 1; if ($i!=255) { if ($i!=254 && $i!=252 && $i!=248 && $i!=240 && $i!=224 && $i!=192 && $i!=128 && $i!=0) exit 1; zero=1 } } }'
}

qmi_valid_ip6() {
	printf '%s\n' "$1" | awk '
	function groups(s, a,n,i) {
		if (s=="") return 0;
		n=split(s,a,":");
		for(i=1;i<=n;i++) if (a[i]=="" || length(a[i])>4) return -1;
		return n;
	}
	/[^0-9a-fA-F:]/ || !/:/ || /^::$/ { exit 1 }
	{
		n=split($0,a,"::");
		if (n==1) { if (groups($0)!=8) exit 1; }
		else if (n==2) { l=groups(a[1]); r=groups(a[2]); if(l<0 || r<0 || l+r>=8) exit 1; }
		else exit 1;
	}'
}

qmi_cleanup_family() {
	local family="$1" cid pdh rc
	# An abort can occur after qmicli returned but before the parent parsed it.
	cid="$(cat "$QMI_STATE/cid_$family" 2>/dev/null)"
	[ -n "$cid" ] || cid="$(awk -F"'" '/CID:/ && $2 ~ /^[0-9]+$/ { print $2; exit }' "$QMI_STATE/alloc_$family" 2>/dev/null)"
	case "$cid" in
		''|*[!0-9]*)
			[ ! -e "$QMI_STATE/alloc_pending_$family" ] || { : >"$QMI_STATE/uncertain"; return 1; }
			return 0 ;;
	esac
	[ ! -e "$QMI_STATE/release_uncertain_$family" ] || return 1
	pdh="$(cat "$QMI_STATE/pdh_$family" 2>/dev/null)"
	[ -n "$pdh" ] || pdh="$(awk -F"'" '/Packet data handle:/ && $2 ~ /^[0-9]+$/ { print $2; exit }' "$QMI_STATE/start_$family" 2>/dev/null)"
	case "$pdh" in ''|*[!0-9]*) pdh=disable-autoconnect ;; esac
	qmi_call -d "$device" -p --client-cid="$cid" --client-no-release-cid \
		--wds-stop-network="$pdh" >/dev/null 2>&1 || true
	if [ "$pdh" != disable-autoconnect ]; then
		qmi_call -d "$device" -p --client-cid="$cid" --client-no-release-cid \
			--wds-stop-network=disable-autoconnect >/dev/null 2>&1 || true
	fi
	qmi_same_device || return 1
	qmi_call -d "$device" -p --client-cid="$cid" --wds-noop >/dev/null 2>&1
	rc=$?
	if [ "$rc" -eq 0 ]; then
		rm -f "$QMI_STATE/cid_$family" "$QMI_STATE/pdh_$family" \
			"$QMI_STATE/alloc_$family" "$QMI_STATE/start_$family"
	else
		# A lost release acknowledgement makes CID ownership ambiguous. Never
		# retry that numeric CID: another client may already have received it.
		: >"$QMI_STATE/release_uncertain_$family"
		return 1
	fi
}

qmi_cleanup_state() {
	local QMI_STATE="$1" device QMI_CLEANUP=1 QMI_TIMEOUT=1 p4 p6 rc=0
	device="$(cat "$QMI_STATE/device" 2>/dev/null)"
	if ! qmi_same_device; then
		rm -rf "$QMI_STATE"
		return 0
	fi
	qmi_cleanup_family 4 & p4=$!
	qmi_cleanup_family 6 & p6=$!
	wait "$p4" || rc=1
	wait "$p6" || rc=1
	[ ! -e "$QMI_STATE/uncertain" ] || rc=1
	[ "$rc" -eq 0 ] && rm -rf "$QMI_STATE"
	return "$rc"
}

qmi_drain_states() {
	local state rc=0
	for state in "$QMI_ROOT/$interface"/session.*; do
		[ -d "$state" ] || continue
		qmi_cleanup_state "$state" || rc=1
	done
	return "$rc"
}

qmi_monitor() {
	local interface="$1" QMI_STATE="$2" device ifname cid family status unknown=0 failed
	device="$(cat "$QMI_STATE/device" 2>/dev/null)"
	ifname="$(cat "$QMI_STATE/ifname" 2>/dev/null)"
	trap 'exit 0' INT TERM
	while qmi_owned; do
		sleep 15 & wait $! || return 0
		qmi_owned || break
		failed=0
		for family in 4 6; do
			cid="$(cat "$QMI_STATE/cid_$family" 2>/dev/null)"
			[ -n "$cid" ] || continue
			status="$(
				exec 9>>"$QMI_ROOT/$interface/lock" || exit 1
				flock -w 1 9 || exit 1
				qmi_owned || exit 1
				qmi_packet_state "$device" "$cid"
			)"
			case "$status" in
				connected) ;;
				disconnected) logger -t t99w175-qmi "WDS disconnected on $ifname (IPv$family)"; return 1 ;;
				*) failed=1 ;;
			esac
		done
		if [ "$failed" -eq 0 ]; then unknown=0; else unknown=$((unknown + 1)); fi
		# Query errors alone do not prove session loss; report them without
		# resetting a working session or relying on filtered Internet pings.
		[ "$unknown" -ne 3 ] || logger -t t99w175-qmi 'WDS status unavailable; preserving session'
	done
	logger -t t99w175-qmi 'USB generation changed or session cancelled'
	# Exiting the netifd-owned process causes teardown/retry. Netifd decides
	# whether autostart is still enabled, including an intervening manual Stop.
	return 1
}
