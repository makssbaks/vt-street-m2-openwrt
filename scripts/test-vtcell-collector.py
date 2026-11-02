#!/usr/bin/env python3
"""Exercise one collector cycle with fixture mmcli processes and real ucode IO.

Usage: python3 scripts/test-vtcell-collector.py /path/to/ucode '/path/to/*.so'
The production collector is unchanged; only command/cache paths and loop count
are replaced in a temporary copy. Fixtures contain synthetic identifiers.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[1]
source = repo / 'package/vtcell/files/usr/share/vtcell'
with tempfile.TemporaryDirectory(prefix='vtcell-test-') as tmp:
    tmp = Path(tmp)
    for name in ('core.uc', 'io.uc'):
        shutil.copy2(source / name, tmp / name)
    fixture = tmp / 'fixture.json'
    counter = tmp / 'count'
    mock = tmp / 'mmcli'
    mock.write_text('''#!/usr/bin/env python3
import json,sys
from pathlib import Path
p=Path(__file__).parent
d=json.loads((p/'fixture.json').read_text())
if '--list-modems' in sys.argv: out=d['list']
elif '--get-cell-info' in sys.argv: out=d['cells']
elif '--signal-get' in sys.argv: out=d['signal']
else:
 c=p/'count'; n=int(c.read_text()) if c.exists() else 0
 c.write_text(str(n+1)); out=d['general'][min(n,len(d['general'])-1)]
print(json.dumps(out))
''')
    mock.chmod(0o755)
    output = tmp / 'status.json'
    collector = (source / 'collector.uc').read_text()
    collector = collector.replace("'/usr/bin/mmcli'", json.dumps(str(mock)))
    collector = collector.replace("'/var/run/vtcell/status.json'", json.dumps(str(output)))
    collector = collector.replace('\tsleep(10000);', '\tbreak;')
    (tmp / 'collector.uc').write_text(collector)
    general = {'modem': {'generic': {
        'state': 'connected', 'device': '/sys/devices/mock',
        'device-identifier': 'fixture-only', 'sim': '/SIM/fixture',
        'model': 'fixture', 'current-bands': ['eutran-7']},
        '3gpp': {'operator-name': 'Test', 'operator-code': '00101', 'imei': 'fixture-secret'}}}
    data = {
        'list': {'modem-list': ['/org/freedesktop/ModemManager1/Modem/7']},
        'general': [general],
        'cells': {'modem': {'generic': {'cell-info': [
            'cell type: lte, serving: yes, operator id: 00101, tac: 1234, ci: 1234502, physical ci: 17C, earfcn: 2850, rsrp: -82, rsrq: -9']}}},
        'signal': {'modem': {'signal': {'lte': {'rssi': '-95'}}}}
    }
    def run():
        fixture.write_text(json.dumps(data))
        counter.unlink(missing_ok=True)
        subprocess.run([sys.argv[1], '-L', sys.argv[2], str(tmp/'collector.uc')], check=True, timeout=20)
        return json.loads(output.read_text())

    result = run()
    assert result['available'] and result['cells'][0]['enb'] == 74565
    assert result['signal']['lte']['rssi'] == -95 and result['signal']['lte']['snr'] is None
    assert result['extra'] is None and result['monotonic_ms'] > 0
    assert 'fixture-secret' not in output.read_text() and 'identity' not in result['modem']
    changed = json.loads(json.dumps(general))
    changed['modem']['generic']['sim'] = '/SIM/changed'
    data['general'] = [general, changed]
    result = run()
    assert not result['available'] and not result['cells']
    data['general'] = [general]
    data['cells'] = {'error': 'unavailable'}
    result = run()
    assert result['available'] and result['cells'] == [] and result['error']
    data['list']['modem-list'].append('/org/freedesktop/ModemManager1/Modem/8')
    assert not run()['available']
print('VT_CELL_COLLECTOR_TESTS_OK')
