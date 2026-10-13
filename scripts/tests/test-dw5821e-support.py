#!/usr/bin/env python3
"""Release-22 DW5821e support invariants. Host-only; no modem/network access."""
from pathlib import Path
import subprocess, tempfile
R=Path(__file__).resolve().parents[2]; F=R/'package/vtmodem/files'
HOT=F/'etc/hotplug.d/usb/04_dw5821e'; READY=F/'usr/libexec/dw5821e-net-ready'
for p in [HOT,READY,F/'etc/init.d/vtmodem-startup',F/'etc/hotplug.d/usb/03_t99w175',F/'lib/netifd/proto/t99w175qmi.sh']:
    subprocess.run(['sh','-n',str(p)],check=True)
hot=HOT.read_text()
assert '413c:81d7' in hot and 'echo 1 >"$dev/bConfigurationValue"' in hot
assert '/dev/dw5821e-at' in hot and '/dev/cdc-wdm0' in hot and '/sys/class/net/wwan0' in hot
for bad in ['reboot','power_usb/value','AT+CFUN','ifdown modem','ifup modem']: assert bad not in hot
assert '413c:81d7' in (F/'usr/share/vtmodem/t99-qmi.sh').read_text()
assert "type: 'dell-dw5821e'" in (F/'usr/share/vtmodem/telemetry-cache.uc').read_text()
assert "modem.type == 'dell-dw5821e'" in (F/'usr/share/vtmodem/collector-core.uc').read_text()
assert "data.type === 'dell-dw5821e'" in (F/'www/luci-static/resources/vtmodem/connection.js').read_text()
assert '04_dw5821e' in (F/'etc/init.d/vtmodem-startup').read_text()
assert 'PKG_RELEASE:=22' in (R/'package/vtmodem/Makefile').read_text()
with tempfile.TemporaryDirectory() as td:
    d=Path(td)/'modem'; d.mkdir(); (d/'bConfigurationValue').write_text('2\n')
    src=f'''INCLUDE_ONLY=1
. "{HOT}"
log() {{ :; }}
sleep() {{ :; }}
ensure_config1 "{d}"
cat "{d}/bConfigurationValue"
'''
    p=subprocess.run(['sh','-c',src],text=True,capture_output=True,timeout=5)
    assert p.returncode==0,p.stderr
    assert p.stdout.strip()=='1',p.stdout
print('DW5821E_RELEASE22_TESTS_OK')
