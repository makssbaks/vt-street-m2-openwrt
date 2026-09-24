#!/usr/bin/env python3
"""Run the installed shell functions with fake QMI/sysfs/netifd; no modem needed."""
import os
import fcntl
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FILES = ROOT / 'package/vtmodem/files'
LIB = FILES / 'usr/share/vtmodem/t99-qmi.sh'
PROTO = FILES / 'lib/netifd/proto/t99w175qmi.sh'

QMICLI = r'''#!/usr/bin/env python3
import os,sys,time
from pathlib import Path
a=sys.argv[1:]; line=' '.join(a); root=Path(os.environ['CASE_ROOT']); scenario=os.environ['SCENARIO']
with open(root/'trace','a') as f: f.write('QMI '+line+'\n')
cid=next((x.split('=',1)[1] for x in a if x.startswith('--client-cid=')),None)
if '--wds-noop' in a and '--client-no-release-cid' in a:
 p=root/'counter'; n=int(p.read_text())+1 if p.exists() else 17; p.write_text(str(n)); print("CID: '%s'"%n,flush=True)
elif '--wda-get-data-format' in a:
 print("Link layer protocol: '%s'" % ('802-3' if scenario=='raw_mismatch' else 'raw-ip'))
elif any(x.startswith('--wda-set-data-format') for x in a):
 if scenario in ('raw_already','raw_mismatch'): sys.exit(1)
elif '--nas-get-serving-system' in a:
 print("Registration state: 'registered'")
elif any(x.startswith('--wds-start-network=') for x in a):
 print("Packet data handle: '%s'" % ('100'+cid),flush=True)
 if scenario=='cancel_start':
  (root/'started').touch(); time.sleep(4)
elif '--wds-get-packet-service-status' in a:
 print("Connection status: '%s'" % ('disconnected' if scenario=='wds_down' else 'connected'))
elif '--wds-get-current-settings' in a:
 if scenario=='empty' or (scenario=='dual_empty6' and cid=='18'): sys.exit(0)
 if os.environ['CASE_PDP']=='ipv6' or cid=='18':
  print('IPv6 address: 2001:db8::10/64\nIPv6 gateway address: fe80::1\nIPv6 primary DNS: 2001:4860:4860::8888')
 else:
  print('IPv4 address: %s\nIPv4 subnet mask: 255.255.255.248\nIPv4 gateway address: 10.169.86.164\nIPv4 primary DNS: 85.249.22.248\nMTU: 1500' % ('999.1.1.1' if scenario=='invalid_ip' else '10.169.86.163'))
elif '--wds-noop' in a and scenario=='release_timeout': time.sleep(3)
'''

HARNESS = r'''
INCLUDE_ONLY=1
. "$PROTO"
trace() { printf '%s\n' "$*" >>"$CASE_ROOT/trace"; }
PROTO_DEFAULT_OPTIONS='defaultroute peerdns metric'
json_get_vars() { pdptype="$CASE_PDP"; registration_timeout=2; apn=internet; }
readlink() { case "$*" in '-f /dev/cdc-wdm0') echo /dev/null;; *) echo "$CASE_ROOT/sysdev";; esac; }
ls() { echo wwan0; }
qmi_usb_generation() { cat "$CASE_ROOT/generation"; }
proto_init_update() { trace "INIT $1 $2"; }
proto_send_update() { trace "UP $1"; }
proto_set_keep() { :; }
proto_add_data() { :; }
proto_close_data() { :; }
proto_add_ipv4_address() { trace "ADDR4 $*"; }
proto_add_ipv6_address() { trace "ADDR6 $*"; }
proto_add_ipv4_route() { trace "ROUTE4 $*"; }
proto_add_ipv6_route() { trace "ROUTE6 $*"; }
proto_add_dns_server() { trace "DNS $*"; }
proto_add_ipv6_prefix() { trace "PD $*"; }
json_add_string() { trace "DATA $1=$2"; }
proto_notify_error() { trace "ERROR $2"; }
proto_set_available() { trace "AVAILABLE $2"; }
proto_block_restart() { trace BLOCK; }
proto_run_command() { trace "MONITOR $*"; }
proto_t99w175qmi_setup modem
rc=$?
trace "RC $rc"
exit "$rc"
'''


def environment(base, scenario='ok', pdp='ip'):
    (base / 'bin').mkdir()
    (base / 'net/wwan0/qmi').mkdir(parents=True)
    (base / 'net/wwan0/qmi/raw_ip').write_text('Y\n')
    (base / 'generation').write_text('usb-generation-1\n')
    (base / 'trace').touch()
    for name, data in [('qmicli', QMICLI), ('ip', '#!/bin/sh\nexit 0\n')]:
        p = base / 'bin' / name
        p.write_text(data)
        p.chmod(0o755)
    return dict(os.environ, PATH=str(base / 'bin') + ':' + os.environ['PATH'],
                CASE_ROOT=str(base), QMI_ROOT=str(base / 'state'), PROTO=str(PROTO),
                T99_QMI_LIBRARY=str(LIB), QMI_SYSNET=str(base / 'net'),
                SCENARIO=scenario, CASE_PDP=pdp)


def run_setup(scenario, pdp, success):
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp); env = environment(base, scenario, pdp)
        p = subprocess.run(['sh', '-c', HARNESS], env=env, capture_output=True, text=True, timeout=15)
        trace = (base / 'trace').read_text()
        assert (p.returncode == 0) == success, (scenario, pdp, trace, p.stderr)
        if success:
            assert trace.count('UP modem') == 1, trace
            assert trace.index('--wds-get-current-settings') < trace.index('UP modem'), trace
            assert trace.index('MONITOR ') < trace.index('UP modem'), trace
            assert ('ADDR4 ' in trace) == (pdp != 'ipv6'), trace
            assert ('ADDR6 ' in trace) == (pdp != 'ip'), trace
            assert '\nPD ' not in trace, 'WDS address incorrectly advertised as delegated prefix'
        else:
            assert 'UP modem' not in trace, trace
            for cid in ([17, 18] if pdp == 'ipv4v6' else [17]):
                if '--wds-start-network=' in trace:
                    assert f'--client-cid={cid} --wds-noop' in trace, trace
            assert not list((base / 'state/modem').glob('session.*')), trace


def cleanup_checks():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp); env = environment(base)
        state = base / 'state/modem/session.old'; state.mkdir(parents=True)
        for name, value in [('device', '/dev/null'), ('generation', 'usb-generation-1'), ('cid_4','17'), ('pdh_4','10017')]:
            (state / name).write_text(value + '\n')
        cleanup = '. "$T99_QMI_LIBRARY"; qmi_usb_generation() { cat "$CASE_ROOT/generation"; }; qmi_cleanup_state "$QMI_ROOT/modem/session.old"'
        # New USB generation must never receive old CIDs, even if node name matches.
        (base / 'generation').write_text('usb-generation-2\n')
        p = subprocess.run(['sh', '-c', cleanup], env=env, capture_output=True, timeout=5)
        assert p.returncode == 0 and not state.exists()
        assert not (base / 'trace').read_text(), 'old CID sent to replacement USB device'
        state.mkdir()
        for name, value in [('device','/dev/null'), ('generation','usb-generation-2'), ('cid_4','17')]:
            (state/name).write_text(value+'\n')
        env['SCENARIO']='release_timeout'; start=time.monotonic()
        p = subprocess.run(['sh','-c',cleanup],env=env,capture_output=True,timeout=5)
        assert p.returncode != 0 and time.monotonic()-start < 3
        assert (state/'release_uncertain_4').exists()
        before=(base/'trace').read_text()
        subprocess.run(['sh','-c',cleanup],env=env,capture_output=True,timeout=5)
        assert (base/'trace').read_text()==before, 'ambiguous released CID was retried'


def cancellation_check():
    with tempfile.TemporaryDirectory() as tmp:
        base=Path(tmp); env=environment(base,'cancel_start')
        p=subprocess.Popen(['sh','-c',HARNESS],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+6
        while not (base/'started').exists() and time.monotonic()<deadline:
            time.sleep(.02)
        assert (base/'started').exists()
        p.terminate()
        # Match netifd's one-second setup-abort budget; SIGKILL is intentional.
        try: p.wait(timeout=1)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        cleanup=r'''. "$T99_QMI_LIBRARY"
interface=modem
qmi_usb_generation() { cat "$CASE_ROOT/generation"; }
exec 9>>"$QMI_ROOT/modem/lock"
flock -w 10 9 || exit 2
qmi_drain_states
'''
        p=subprocess.run(['sh','-c',cleanup],env=env,capture_output=True,timeout=10)
        trace=(base/'trace').read_text()
        assert p.returncode==0 and 'UP modem' not in trace, trace
        assert '--client-cid=17 --wds-noop' in trace, trace
        assert not list((base/'state/modem').glob('session.*'))


def delayed_cleanup_check():
    with tempfile.TemporaryDirectory() as tmp:
        base=Path(tmp); env=environment(base)
        directory=base/'state/modem'; directory.mkdir(parents=True)
        old=directory/'session.old'; new=directory/'session.new'
        for state,cid in [(old,'17'),(new,'18')]:
            state.mkdir()
            for name,value in [('generation','usb-generation-1'),('device','/dev/null'),('cid_4',cid),('pdh_4','100'+cid)]:
                (state/name).write_text(value+'\n')
        shim=base/'library.sh'
        shim.write_text('. "$T99_QMI_LIBRARY"\nqmi_usb_generation() { cat "$CASE_ROOT/generation"; }\n')
        helper=base/'session-helper.sh'
        helper.write_text((FILES/'usr/libexec/t99w175-session').read_text().replace('/usr/share/vtmodem/t99-qmi.sh',str(shim)))
        with (directory/'lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            p=subprocess.Popen(['sh',str(helper),'cleanup','modem',str(old)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            time.sleep(.05)
            assert p.poll() is None,'cleanup did not wait for transaction ownership'
            fcntl.flock(lock,fcntl.LOCK_UN)
        out,err=p.communicate(timeout=5)
        trace=(base/'trace').read_text()
        assert p.returncode==0,(out,err)
        assert not old.exists() and new.exists()
        assert '--client-cid=17' in trace and '--client-cid=18' not in trace,trace


for pdp in ['ip','ipv6','ipv4v6']:
    run_setup('ok',pdp,True)
    run_setup('empty',pdp,False)
run_setup('dual_empty6','ipv4v6',False)
run_setup('invalid_ip','ip',False)
run_setup('raw_already','ip',True)
run_setup('raw_mismatch','ip',False)
cleanup_checks()
cancellation_check()
delayed_cleanup_check()
print('T99_QMI_LIFECYCLE_TESTS_OK')
