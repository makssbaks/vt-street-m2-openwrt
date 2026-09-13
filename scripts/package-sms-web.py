#!/usr/bin/env python3
"""Build the SMS frontend hotfix for offline installation on build 49."""
import hashlib
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
files = [
    'package/vtmodem/files/www/luci-static/resources/view/vtmodem/sms.js',
    'scripts/install-sms-web.sh',
    'scripts/tests/test-vtmodem-sms.js',
]
contents = {name: (root / name).read_bytes() for name in files}
contents['SHA256SUMS'] = ''.join(
    f'{hashlib.sha256(data).hexdigest()}  {name}\n'
    for name, data in contents.items()
).encode()
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'vt-sms-web-r1.zip'
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in contents.items():
        info = zipfile.ZipInfo('vt-sms-web/' + name, (2026, 9, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(f'{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}')
