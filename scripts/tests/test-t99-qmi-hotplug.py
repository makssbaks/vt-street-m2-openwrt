#!/usr/bin/env python3
"""Exercise firewall default selection and WDS monitor terminal conditions."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]
FILES=ROOT/'package/vtmodem/files'
HOTPLUG=FILES/'etc/hotplug.d/usb/03_t99w175'
LIB=FILES/'usr/share/vtmodem/t99-qmi.sh'

with tempfile.TemporaryDirectory() as tmp:
    work=Path(tmp)
    # Replace only the system include; all real zone-selection functions remain.
    source=HOTPLUG.read_text().replace('. /lib/functions.sh', ': # supplied UCI fixture functions')
    (work/'hotplug.sh').write_text(source)
    env=dict(os.environ, SOURCE=str(work/'hotplug.sh'), WORK=tmp)
    harness=r'''
INCLUDE_ONLY=1
. "$SOURCE"
config_load() { :; }
config_foreach() { "$1" "$WAN_SECTION"; "$1" guest; }
config_get() {
    case "$2/$3" in
        "$WAN_SECTION"/name) name=wan ;;
        "$WAN_SECTION"/network) networks=wan ;;
        guest/name) name=guest ;;
        guest/network) networks="$GUEST_NETWORK" ;;
    esac
}
uci() { printf '%s\n' "$*" >>"$WORK/trace"; }
log() { :; }
assign_initial_firewall_zone
'''
    for section in ['wan','@zone[1]']:
        for existing in ['', 'guest modem']:
            (work/'trace').write_text('')
            p=subprocess.run(['sh','-c',harness],env=dict(env,WAN_SECTION=section,GUEST_NETWORK=existing),capture_output=True,timeout=5)
            assert p.returncode==0,p.stderr
            trace=(work/'trace').read_text()
            assert ('add_list' in trace)==(existing==''),trace
            if not existing: assert f'firewall.{section}.network=modem' in trace,trace
    # Existing interface must not run zone assignment on later USB events.
    harness=r'''
INCLUDE_ONLY=1
. "$SOURCE"
uci() { [ "$*" = '-q get network.modem' ]; }
assign_initial_firewall_zone() { echo WRONG >>"$WORK/trace"; }
ensure_network_config
'''
    (work/'trace').write_text('')
    p=subprocess.run(['sh','-c',harness],env=env,capture_output=True,timeout=5)
    assert not (work/'trace').read_text(),'existing firewall placement changed'

    # Netifd owns this process: disconnect/USB loss exit; QMI read errors alone
    # keep the bearer, and no branch calls interface.up or a modem reset.
    for mode in ['disconnect','usb_changed','query_errors']:
        state=work/'session'
        state.mkdir(exist_ok=True)
        (work/'qmi/modem').mkdir(parents=True,exist_ok=True)
        for name,value in [('device','/dev/null'),('ifname','wwan0'),('cid_4','17')]:
            (state/name).write_text(value+'\n')
        harness=r'''
. "$LIB"
count=0
qmi_owned() {
    count=$((count+1))
    [ "$MODE" != usb_changed ] || [ "$count" -lt 2 ]
}
sleep() { :; }
logger() { printf '%s\n' "$*" >>"$WORK/trace"; }
qmi_packet_state() {
    if [ "$MODE" = disconnect ]; then echo disconnected
    else
        echo read >>"$WORK/reads"
        [ "$(wc -l <"$WORK/reads")" -lt 4 ] || : >"$QMI_STATE/cancelled"
    fi
}
if [ "$MODE" = query_errors ]; then
    qmi_owned() { [ ! -e "$QMI_STATE/cancelled" ]; }
fi
qmi_monitor modem "$WORK/session"
'''
        (state/'cancelled').unlink(missing_ok=True)
        (work/'trace').write_text('');(work/'reads').write_text('')
        p=subprocess.run(['sh','-c',harness],env=dict(env,LIB=str(LIB),MODE=mode,QMI_ROOT=str(work/'qmi')),capture_output=True,timeout=5)
        assert p.returncode==1,(mode,p.stderr)
        trace=(work/'trace').read_text()
        if mode=='disconnect': assert 'WDS disconnected' in trace,trace
        if mode=='usb_changed': assert not (work/'reads').read_text()
        if mode=='query_errors':
            assert 'preserving session' in trace,trace
            assert len((work/'reads').read_text().splitlines())==4

print('T99_QMI_HOTPLUG_TESTS_OK')
