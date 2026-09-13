#!/usr/bin/env python3
"""Package the reviewed T99 telemetry files for offline SCP installation."""
import hashlib
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
files = [
    'package/vtmodem/files/usr/share/vtmodem/qmi.uc',
    'package/vtmodem/files/usr/share/vtmodem/qmi-status.uc',
    'package/vtmodem/files/usr/share/rpcd/ucode/vtmodem',
    'package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js',
    'scripts/install-t99-telemetry.sh',
    'scripts/tests/test-t99-qmi.uc',
    'scripts/tests/test-t99-qmi-supervisor.uc',
    'scripts/tests/fixtures/t99-signal.txt',
    'scripts/tests/fixtures/t99-radio.txt',
]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'vt-t99-telemetry.zip'
contents = {name: (root / name).read_bytes() for name in files}
contents['SHA256SUMS'] = ''.join(
    f'{hashlib.sha256(data).hexdigest()}  {name}\n'
    for name, data in contents.items()
).encode()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in contents.items():
        info = zipfile.ZipInfo('vt-t99-telemetry/' + name, (2026, 9, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(f'{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}')
