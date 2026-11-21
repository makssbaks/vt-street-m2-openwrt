#!/bin/sh

[ -n "$INCLUDE_ONLY" ] || {
	. /lib/functions.sh
	. ../netifd-proto.sh
	init_proto "$@"
}

. "${T99_QMI_LIBRARY:-/usr/share/vtmodem/t99-qmi.sh}"

proto_t99w175qmi_init_config() {
	available=1
	no_device=1
	teardown_on_l3_link_down=1
	proto_config_add_int delay
	proto_config_add_int registration_timeout
	proto_config_add_string pdptype
	proto_config_add_string apn
	proto_config_add_string auth
	proto_config_add_string username
	proto_config_add_string password
	proto_config_add_boolean sourcefilter
	proto_config_add_boolean delegate
	proto_config_add_defaults
}

qmi_setup_transaction() {
	local interface="$1"
	local devname devpath
	local apn auth username password delay registration_timeout pdptype
	local defaultroute peerdns sourcefilter delegate ip4table
	local cid pdh cid_4 pdh_4 cid_6 pdh_6 raw family
	local ip_4 subnet_4 gateway_4 dns1_4 dns2_4 mtu_4
	local ip_6 ip_prefix_6 gateway_6 dns1_6 dns2_6
	local $PROTO_DEFAULT_OPTIONS

	json_get_vars delay registration_timeout pdptype apn auth username password
	json_get_vars sourcefilter delegate ip4table defaultroute peerdns

	case "$delay" in ''|*[!0-9]*) delay=0 ;; esac
	[ "$delay" -le 120 ] || delay=120
	[ "$delay" -eq 0 ] || sleep "$delay"
	case "$registration_timeout" in ''|*[!0-9]*) registration_timeout=60 ;; esac
	[ "$registration_timeout" -gt 0 ] && [ "$registration_timeout" -le 600 ] || registration_timeout=60
	# qmicli key=value values are quoted below. Reject characters that cannot
	# be represented safely in that grammar instead of silently truncating.
	for raw in "$apn" "$username" "$password"; do
		case "$raw" in *"'"*|*'
'*|*"$(printf '\r')"*) proto_notify_error "$interface" INVALID_CREDENTIALS; return 1 ;; esac
	done
	[ -n "$apn" ] || apn="internet"

	auth="$(printf '%s' "$auth" | tr '[:lower:]' '[:upper:]')"
	case "$auth" in
		PAP|CHAP) ;;
		*) auth=NONE ;;
	esac

	pdptype="$(printf '%s' "$pdptype" | tr '[:upper:]' '[:lower:]')"
	case "$pdptype" in
		ip|ipv6|ipv4v6) ;;
		*) pdptype=ip ;;
	esac

	device="$(readlink -f "$device" 2>/dev/null)"
	[ -c "$device" ] || {
		proto_notify_error "$interface" NO_DEVICE
		proto_set_available "$interface" 0
		return 1
	}

	devname="$(basename "$device")"
	devpath="$(readlink -f "/sys/class/usbmisc/$devname/device" 2>/dev/null)"
	ifname="$(ls "$devpath/net" 2>/dev/null | head -n1)"
	[ -n "$ifname" ] || {
		proto_notify_error "$interface" NO_IFACE
		return 1
	}

	qmi_new_state || { proto_notify_error "$interface" STATE_FAILED; return 1; }
	qmi_call -d "$device" -p --dms-set-operating-mode=online >/dev/null 2>&1 || true

	qmi_prepare_raw_ip "$device" "$ifname" || {
		proto_notify_error "$interface" RAW_IP_FAILED
		return 1
	}

	echo "Waiting for T99W175 network registration"
	qmi_wait_registered "$device" "$registration_timeout" || {
		proto_notify_error "$interface" NETWORK_REGISTRATION_FAILED
		return 1
	}

	# Persist every allocated CID before starting a bearer. A failed family
	# aborts the transaction, so dual stack never leaves an unreported session.
	for family in 4 6; do
		[ "$family:$pdptype" != '4:ipv6' ] || continue
		[ "$family:$pdptype" != '6:ip' ] || continue
		cid="$(qmi_alloc_wds_cid "$device" "$family")" || {
			proto_notify_error "$interface" CLIENT_ALLOCATION_FAILED; return 1;
		}
		qmi_call -d "$device" -p --client-cid="$cid" --client-no-release-cid \
			--wds-set-ip-family="$family" >/dev/null 2>&1 || {
			proto_notify_error "$interface" IP_FAMILY_FAILED; return 1;
		}
		pdh="$(qmi_start_bearer "$device" "$cid" "$family" "$apn" "$auth" "$username" "$password")" || {
			proto_notify_error "$interface" CALL_FAILED; return 1;
		}
		[ "$(qmi_packet_state "$device" "$cid")" = connected ] || {
			proto_notify_error "$interface" CALL_FAILED; return 1;
		}
		if [ "$family" = 4 ]; then cid_4="$cid"; pdh_4="$pdh"; else cid_6="$cid"; pdh_6="$pdh"; fi
	done

	if [ -n "$cid_4" ]; then
		raw="$(qmi_call -d "$device" -p --client-cid="$cid_4" --client-no-release-cid \
			--wds-get-current-settings 2>/dev/null)" || {
			proto_notify_error "$interface" SETTINGS_FAILED; return 1;
		}
		ip_4="$(printf '%s\n' "$raw" | awk '/IPv4 address:/{print $NF; exit}')"
		subnet_4="$(printf '%s\n' "$raw" | awk '/IPv4 subnet mask:/{print $NF; exit}')"
		gateway_4="$(printf '%s\n' "$raw" | awk '/IPv4 gateway address:/{print $NF; exit}')"
		dns1_4="$(printf '%s\n' "$raw" | awk '/IPv4 primary DNS:/{print $NF; exit}')"
		dns2_4="$(printf '%s\n' "$raw" | awk '/IPv4 secondary DNS:/{print $NF; exit}')"
		mtu_4="$(printf '%s\n' "$raw" | awk '/MTU:/{print $NF; exit}')"

		qmi_valid_ip4 "$ip_4" && qmi_valid_mask4 "$subnet_4" || {
			proto_notify_error "$interface" NO_ADDRESS; return 1;
		}
		[ -z "$gateway_4" ] || qmi_valid_ip4 "$gateway_4" || {
			proto_notify_error "$interface" INVALID_GATEWAY; return 1;
		}
	fi

	if [ -n "$cid_6" ]; then
		raw="$(qmi_call -d "$device" -p --client-cid="$cid_6" --client-no-release-cid \
			--wds-get-current-settings 2>/dev/null)" || {
			proto_notify_error "$interface" SETTINGS_FAILED; return 1;
		}
		ip_6="$(printf '%s\n' "$raw" | awk '/IPv6 address:/{print $NF; exit}')"
		if printf '%s' "$ip_6" | grep -q '/'; then
			ip_prefix_6="${ip_6##*/}"
			ip_6="${ip_6%%/*}"
		else
			ip_prefix_6="$(printf '%s\n' "$raw" | awk '/[Pp]refix.len/{print $NF; exit}')"
		fi
		gateway_6="$(printf '%s\n' "$raw" | awk '/IPv6 gateway/{print $NF; exit}' | cut -d/ -f1)"
		dns1_6="$(printf '%s\n' "$raw" | awk '/IPv6 primary DNS/{print $NF; exit}')"
		dns2_6="$(printf '%s\n' "$raw" | awk '/IPv6 secondary DNS/{print $NF; exit}')"

		qmi_valid_ip6 "$ip_6" || {
			proto_notify_error "$interface" NO_ADDRESS; return 1;
		}
		case "$ip_prefix_6" in ''|*[!0-9]*) ip_prefix_6=128 ;; esac
		[ "$ip_prefix_6" -le 128 ] || { proto_notify_error "$interface" NO_ADDRESS; return 1; }
		[ -z "$gateway_6" ] || qmi_valid_ip6 "$gateway_6" || {
			proto_notify_error "$interface" INVALID_GATEWAY; return 1;
		}
	fi

	qmi_owned || { proto_notify_error "$interface" DEVICE_CHANGED; return 1; }
	proto_run_command "$interface" /usr/libexec/t99w175-session monitor "$interface" "$QMI_STATE" || return 1
	# One final publication includes validated addresses, routes and ownership.
	proto_init_update "$ifname" 1
	proto_add_data
	json_add_string qmi_generation "$(cat "$QMI_STATE/generation")"
	[ -z "$cid_4" ] || { json_add_string cid_4 "$cid_4"; json_add_string pdh_4 "$pdh_4"; }
	[ -z "$cid_6" ] || { json_add_string cid_6 "$cid_6"; json_add_string pdh_6 "$pdh_6"; }
	proto_close_data
	if [ -n "$cid_4" ]; then
		proto_add_ipv4_address "$ip_4" "$subnet_4"
		[ -z "$gateway_4" ] || proto_add_ipv4_route "$gateway_4" 32
		[ "$defaultroute" = 0 ] || [ -z "$gateway_4" ] || proto_add_ipv4_route 0.0.0.0 0 "$gateway_4"
		if [ "$peerdns" != 0 ]; then
			qmi_valid_ip4 "$dns1_4" && proto_add_dns_server "$dns1_4"
			qmi_valid_ip4 "$dns2_4" && proto_add_dns_server "$dns2_4"
		fi
	fi
	if [ -n "$cid_6" ]; then
		proto_add_ipv6_address "$ip_6" 128
		# A WDS address prefix is not DHCPv6 prefix delegation. Do not announce
		# it as a delegated LAN prefix without a separate PD transaction.
		[ -z "$gateway_6" ] || proto_add_ipv6_route "$gateway_6" 128
		[ "$defaultroute" = 0 ] || [ -z "$gateway_6" ] || proto_add_ipv6_route ::0 0 "$gateway_6" '' '' "$ip_6/128"
		if [ "$peerdns" != 0 ]; then
			qmi_valid_ip6 "$dns1_6" && proto_add_dns_server "$dns1_6"
			qmi_valid_ip6 "$dns2_6" && proto_add_dns_server "$dns2_6"
		fi
	fi
	qmi_owned || return 1
	proto_send_update "$interface" || return 1
	case "$mtu_4" in
		''|*[!0-9]*) ;;
		*) [ "$mtu_4" -ge 1280 ] && [ "$mtu_4" -le 9000 ] && ip link set dev "$ifname" mtu "$mtu_4" >/dev/null 2>&1 ;;
	esac
	return 0
}

proto_t99w175qmi_setup() {
	local interface="$1" device=/dev/cdc-wdm0 ifname QMI_STATE rc
	case "$interface" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
	umask 077
	mkdir -p "$QMI_ROOT/$interface" || return 1
	exec 9>>"$QMI_ROOT/$interface/lock" || return 1
	# A cancelled bounded QMI child or cleanup worker may still own this lock.
	flock -w 12 9 || { exec 9>&-; proto_notify_error "$interface" CLEANUP_BUSY; return 1; }
	qmi_drain_states || {
		exec 9>&-
		proto_notify_error "$interface" CLEANUP_UNCERTAIN
		proto_block_restart "$interface"
		return 1
	}
	trap '[ -z "$QMI_STATE" ] || : >"$QMI_STATE/cancelled"; exit 1' INT TERM
	qmi_setup_transaction "$interface"
	rc=$?
	if [ "$rc" -ne 0 ] && [ -n "$QMI_STATE" ]; then
		: >"$QMI_STATE/cancelled"
		qmi_cleanup_state "$QMI_STATE" || proto_notify_error "$interface" CLEANUP_UNCERTAIN
	fi
	trap - INT TERM
	exec 9>&-
	return "$rc"
}

proto_t99w175qmi_teardown() {
	local interface="$1" state
	case "$interface" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
	state="$(cat "$QMI_ROOT/$interface/current" 2>/dev/null)"
	case "$state" in "$QMI_ROOT/$interface"/session.*) [ ! -d "$state" ] || : >"$state/cancelled" ;; esac
	proto_kill_command "$interface"
	# netifd allows only five seconds here. The private cleanup worker waits
	# for a cancelled child (at most eight seconds), then releases both CIDs
	# in parallel. Future setup drains this same state before any allocation.
	case "$state" in
		"$QMI_ROOT/$interface"/session.*)
			/usr/libexec/t99w175-session cleanup "$interface" "$state" </dev/null >/dev/null 2>&1 &
			;;
	esac
	return 0
}

[ -n "$INCLUDE_ONLY" ] || add_protocol t99w175qmi
