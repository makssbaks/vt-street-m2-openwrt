# sysupgrade sources /lib/upgrade/*.sh before both config backup and upgrade.
# Snapshot through SQLite's backup API. Copying a live database with tar/cp
# alone can capture an incomplete transaction; do not advertise that as backup.
vtmodem_traffic_backup() {
	[ -x /usr/bin/vt-traffic-db ] || {
		[ ! -f /etc/vtmodem/traffic/vnstat.db ] && return 0
		echo 'VT Modem traffic snapshot helper is missing; configuration backup stopped.' >&2
		exit 1
	}
	/usr/libexec/vtmodem-traffic-backup || {
		echo 'VT Modem traffic database backup failed; configuration backup stopped.' >&2
		exit 1
	}
	for file in /etc/vtmodem/traffic-backup.db /etc/vtmodem/traffic-backup.time; do
		[ ! -f "$file" ] || echo "$file" >> "$1"
	done
}

append sysupgrade_init_conffiles vtmodem_traffic_backup
