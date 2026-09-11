#!/bin/sh

[ -n "$INCLUDE_ONLY" ] || {
	. /lib/functions.sh
	. ../netifd-proto.sh
	init_proto "$@"
}

proto_t99w175qmi_init_config() {
	available=1
	no_device=1
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

qmi_alloc_wds_cid() {
	qmicli -d "$1" -p --wds-noop --client-no-release-cid 2>/dev/null |
		awk -F"'" '/CID:/{print $2; exit}'
}

qmi_release_wds_cid() {
	local device="$1" cid="$2"
	[ -n "$cid" ] || return 0
	qmicli -d "$device" -p --client-cid="$cid" --wds-noop >/dev/null 2>&1 || true
}

qmi_reg_state() {
	qmicli -d "$1" -p --nas-get-serving-system 2>/dev/null |
		awk -F"'" '/Registration state:/{print $2; exit}'
}

qmi_start_bearer() {
	local device="$1" cid="$2" iptype="$3"
	local apn="$4" auth="$5" user="$6" pass="$7"
	local args="ip-type=$iptype"

	[ -n "$apn" ] && args="$args,apn=$apn"
	[ -n "$auth" ] && [ "$auth" != "NONE" ] && args="$args,auth=$auth"
	[ -n "$user" ] && args="$args,username=$user"
	[ -n "$pass" ] && args="$args,password=$pass"

	qmicli -d "$device" -p \
		--client-cid="$cid" --client-no-release-cid \
		--wds-start-network="$args" 2>/dev/null |
		awk -F"'" '/Packet data handle:/{print $2; exit}'
}

qmi_is_connected() {
	qmicli -d "$1" -p \
		--client-cid="$2" --client-no-release-cid \
		--wds-get-packet-service-status 2>/dev/null |
		grep -q "'connected'"
}

qmi_stop_bearer() {
	local device="$1" cid="$2" pdh="$3"
	[ -n "$cid" ] || return 0

	[ -n "$pdh" ] && qmicli -d "$device" -p \
		--client-cid="$cid" --client-no-release-cid \
		--wds-stop-network="$pdh" >/dev/null 2>&1 || true

	qmicli -d "$device" -p \
		--client-cid="$cid" --client-no-release-cid \
		--wds-stop-network=disable-autoconnect >/dev/null 2>&1 || true

	qmi_release_wds_cid "$device" "$cid"
}

qmi_prepare_raw_ip() {
	local device="$1" ifname="$2"

	qmicli -d "$device" -p \
		--wda-set-data-format="link-layer-protocol=raw-ip" >/dev/null 2>&1 || true

	if [ -w "/sys/class/net/$ifname/qmi/raw_ip" ] && \
	   ! grep -q '^Y' "/sys/class/net/$ifname/qmi/raw_ip" 2>/dev/null; then
		ip link set dev "$ifname" down >/dev/null 2>&1 || true
		echo Y >"/sys/class/net/$ifname/qmi/raw_ip" || return 1
		ip link set dev "$ifname" up >/dev/null 2>&1 || true
	fi

	return 0
}

qmi_wait_registered() {
	local device="$1" timeout="$2"
	local elapsed=0 state

	while [ "$elapsed" -lt "$timeout" ]; do
		state="$(qmi_reg_state "$device")"
		[ "$state" = "registered" ] && return 0
		case "$state" in
			searching|not-registered|unknown|'') ;;
			*) echo "T99W175 registration state: $state" ;;
		esac
		sleep 1
		elapsed=$((elapsed + 1))
	done

	return 1
}

proto_t99w175qmi_setup() {
	local interface="$1"
	local device="/dev/cdc-wdm0" devname devpath ifname
	local apn auth username password delay registration_timeout pdptype
	local defaultroute peerdns sourcefilter delegate ip4table
	local cid_4 pdh_4 cid_6 pdh_6 raw
	local ip_4 subnet_4 gateway_4 dns1_4 dns2_4 mtu_4
	local ip_6 ip_prefix_6 gateway_6 dns1_6 dns2_6
	local $PROTO_DEFAULT_OPTIONS

	json_get_vars delay registration_timeout pdptype apn auth username password
	json_get_vars sourcefilter delegate ip4table defaultroute peerdns

	[ -n "$delay" ] && [ "$delay" -gt 0 ] && sleep "$delay"
	[ -n "$registration_timeout" ] || registration_timeout=60
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

	qmicli -d "$device" -p --dms-set-operating-mode=online >/dev/null 2>&1 || true

	qmi_prepare_raw_ip "$device" "$ifname" || {
		proto_notify_error "$interface" RAW_IP_FAILED
		return 1
	}

	echo "Waiting for T99W175 network registration"
	qmi_wait_registered "$device" "$registration_timeout" || {
		proto_notify_error "$interface" NETWORK_REGISTRATION_FAILED
		return 1
	}

	if [ "$pdptype" = "ip" ] || [ "$pdptype" = "ipv4v6" ]; then
		cid_4="$(qmi_alloc_wds_cid "$device")"
		if [ -n "$cid_4" ]; then
			qmicli -d "$device" -p --client-cid="$cid_4" --client-no-release-cid \
				--wds-set-ip-family=4 >/dev/null 2>&1 || true
			pdh_4="$(qmi_start_bearer "$device" "$cid_4" 4 "$apn" "$auth" "$username" "$password")"
			if [ -z "$pdh_4" ] || ! qmi_is_connected "$device" "$cid_4"; then
				qmi_stop_bearer "$device" "$cid_4" "$pdh_4"
				cid_4=""; pdh_4=""
			fi
		fi
	fi

	if [ "$pdptype" = "ipv6" ] || [ "$pdptype" = "ipv4v6" ]; then
		cid_6="$(qmi_alloc_wds_cid "$device")"
		if [ -n "$cid_6" ]; then
			qmicli -d "$device" -p --client-cid="$cid_6" --client-no-release-cid \
				--wds-set-ip-family=6 >/dev/null 2>&1 || true
			pdh_6="$(qmi_start_bearer "$device" "$cid_6" 6 "$apn" "$auth" "$username" "$password")"
			if [ -z "$pdh_6" ] || ! qmi_is_connected "$device" "$cid_6"; then
				qmi_stop_bearer "$device" "$cid_6" "$pdh_6"
				cid_6=""; pdh_6=""
			fi
		fi
	fi

	[ -n "$cid_4" ] || [ -n "$cid_6" ] || {
		proto_notify_error "$interface" CALL_FAILED
		return 1
	}

	proto_init_update "$ifname" 1
	proto_set_keep 1
	proto_add_data
	[ -n "$cid_4" ] && {
		json_add_string cid_4 "$cid_4"
		json_add_string pdh_4 "$pdh_4"
	}
	[ -n "$cid_6" ] && {
		json_add_string cid_6 "$cid_6"
		json_add_string pdh_6 "$pdh_6"
	}
	proto_close_data
	proto_send_update "$interface"

	if [ -n "$cid_4" ]; then
		raw="$(qmicli -d "$device" -p --client-cid="$cid_4" --client-no-release-cid \
			--wds-get-current-settings 2>/dev/null)"
		ip_4="$(printf '%s\n' "$raw" | awk '/IPv4 address:/{print $NF; exit}')"
		subnet_4="$(printf '%s\n' "$raw" | awk '/IPv4 subnet mask:/{print $NF; exit}')"
		gateway_4="$(printf '%s\n' "$raw" | awk '/IPv4 gateway address:/{print $NF; exit}')"
		dns1_4="$(printf '%s\n' "$raw" | awk '/IPv4 primary DNS:/{print $NF; exit}')"
		dns2_4="$(printf '%s\n' "$raw" | awk '/IPv4 secondary DNS:/{print $NF; exit}')"
		mtu_4="$(printf '%s\n' "$raw" | awk '/MTU:/{print $NF; exit}')"

		[ -n "$ip_4" ] && [ -n "$subnet_4" ] || {
			qmi_stop_bearer "$device" "$cid_4" "$pdh_4"
			proto_notify_error "$interface" NO_ADDRESS
			return 1
		}

		proto_init_update "$ifname" 1
		proto_set_keep 1
		proto_add_ipv4_address "$ip_4" "$subnet_4"
		[ -n "$gateway_4" ] && proto_add_ipv4_route "$gateway_4" 32
		[ "$defaultroute" = 0 ] || [ -z "$gateway_4" ] || proto_add_ipv4_route 0.0.0.0 0 "$gateway_4"
		[ "$peerdns" = 0 ] || {
			[ -n "$dns1_4" ] && proto_add_dns_server "$dns1_4"
			[ -n "$dns2_4" ] && proto_add_dns_server "$dns2_4"
		}
		proto_send_update "$interface"

		case "$mtu_4" in
			''|*[!0-9]*) ;;
			*) [ "$mtu_4" -gt 0 ] && ip link set dev "$ifname" mtu "$mtu_4" >/dev/null 2>&1 ;;
		esac
	fi

	if [ -n "$cid_6" ]; then
		raw="$(qmicli -d "$device" -p --client-cid="$cid_6" --client-no-release-cid \
			--wds-get-current-settings 2>/dev/null)"
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

		if [ -n "$ip_6" ]; then
			proto_init_update "$ifname" 1
			proto_set_keep 1
			proto_add_ipv6_address "$ip_6" 128
			[ -n "$ip_prefix_6" ] && proto_add_ipv6_prefix "$ip_6/$ip_prefix_6"
			[ -n "$gateway_6" ] && proto_add_ipv6_route "$gateway_6" 128
			[ "$defaultroute" = 0 ] || [ -z "$gateway_6" ] || \
				proto_add_ipv6_route ::0 0 "$gateway_6" "" "" "$ip_6/$ip_prefix_6"
			[ "$peerdns" = 0 ] || {
				[ -n "$dns1_6" ] && proto_add_dns_server "$dns1_6"
				[ -n "$dns2_6" ] && proto_add_dns_server "$dns2_6"
			}
			proto_send_update "$interface"
		fi
	fi
}

proto_t99w175qmi_teardown() {
	local interface="$1" device cid_4 pdh_4 cid_6 pdh_6

	device="$(readlink -f /dev/cdc-wdm0 2>/dev/null)"
	json_load "$(ubus call network.interface."$interface" status 2>/dev/null)"
	json_select data 2>/dev/null
	json_get_vars cid_4 pdh_4 cid_6 pdh_6

	[ -c "$device" ] && {
		qmi_stop_bearer "$device" "$cid_4" "$pdh_4"
		qmi_stop_bearer "$device" "$cid_6" "$pdh_6"
	}

	proto_kill_command "$interface"
}

[ -n "$INCLUDE_ONLY" ] || add_protocol t99w175qmi
