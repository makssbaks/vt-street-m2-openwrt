#!/usr/bin/env python3
"""Use actual canonical USB-directory nesting; replace only sysfs/dev roots."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]
FILES=ROOT/'package/vtmodem/files'
with tempfile.TemporaryDirectory() as tmp:
    work=Path(tmp);sys=work/'sys';dev=work/'dev'
    usb=sys/'devices/platform/usb1/1-1'
    usb.mkdir(parents=True);dev.mkdir()
    for name,value in [('idVendor','05c6'),('idProduct','9025'),('busnum','1'),('devnum','4')]:
        (usb/name).write_text(value+'\n')
    def link(path,target):
        path.parent.mkdir(parents=True,exist_ok=True)
        path.symlink_to(target)
    for number,protocol in [(0,'30'),(2,'40'),(3,'60'),(4,'00')]:
        interface=usb/f'1-1:1.{number}'
        interface.mkdir();(interface/'bInterfaceProtocol').write_text(protocol+'\n')
        if number!=4:
            tty=interface/f'ttyUSB{number}';tty.mkdir()
            link(sys/f'class/tty/ttyUSB{number}/device',tty)
            link(dev/f'ttyUSB{number}','/dev/null')
    qmi=usb/'1-1:1.4'
    (qmi/'net/wwan0').mkdir(parents=True)
    link(sys/'class/usbmisc/cdc-wdm0/device',qmi)
    link(sys/'class/net/wwan0/device',qmi)
    link(sys/'bus/usb/devices/1-1',usb)
    link(dev/'cdc-wdm0','/dev/null')
    link(dev/'t99w175-at',dev/'ttyUSB2')
    (work/'ready').write_text('1-1\n')
    # Absolute entry points are redirected, without replacing any functions.
    for name,path in [('qmi','usr/share/vtmodem/t99-qmi.sh'),('ready','usr/libexec/t99w175-net-ready'),('hotplug','etc/hotplug.d/usb/03_t99w175')]:
        source=(FILES/path).read_text().replace('/sys/',str(sys)+'/').replace('/dev/',str(dev)+'/')
        source=source.replace('/tmp/t99w175-hotplug.ready',str(work/'ready'))
        (work/f'{name}.sh').write_text(source)
    env=dict(os.environ,WORK=tmp,USB=str(usb))
    harness=r'''
INCLUDE_ONLY=1
# Character devices cannot be created in the host sandbox. Only canonicalize
# the AT alias to its synthetic tty path; its target is /dev/null for -c.
readlink() {
    case "$*" in
        "-f $WORK/dev/t99w175-at") printf '%s\n' "$WORK/dev/ttyUSB2" ;;
        *) command readlink "$@" ;;
    esac
}
. "$WORK/qmi.sh"
gen="$(qmi_usb_generation /dev/cdc-wdm0)" || exit 10
case "$gen" in "$USB":1:4:*) ;; *) echo "$gen"; exit 11 ;; esac
. "$WORK/ready.sh"
device_ready || exit 12
. "$WORK/hotplug.sh"
MODEM="$(find_modem)"
[ "$MODEM" = "$USB" ] || exit 13
[ "$(find_tty_by_protocol 40)" = "$WORK/dev/ttyUSB2" ] || exit 14
ready_state "$MODEM" || exit 15
'''
    p=subprocess.run(['sh','-c',harness],env=env,text=True,capture_output=True,timeout=5)
    assert p.returncode==0,(p.returncode,p.stdout,p.stderr)
    # Move QMI alone to a different USB parent with a prefix-similar name.
    other=sys/'devices/platform/usb1/1-10/1-10:1.4';other.mkdir(parents=True)
    (sys/'class/usbmisc/cdc-wdm0/device').unlink();link(sys/'class/usbmisc/cdc-wdm0/device',other)
    harness=r'''
INCLUDE_ONLY=1
readlink() {
    case "$*" in "-f $WORK/dev/t99w175-at") echo "$WORK/dev/ttyUSB2" ;; *) command readlink "$@" ;; esac
}
. "$WORK/ready.sh"
device_ready && exit 20
. "$WORK/hotplug.sh"
ready_state "$USB" && exit 21
exit 0
'''
    p=subprocess.run(['sh','-c',harness],env=env,text=True,capture_output=True,timeout=5)
    assert p.returncode==0,(p.returncode,p.stderr)

print('T99_QMI_SYSFS_TESTS_OK')
