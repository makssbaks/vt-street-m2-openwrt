#!/usr/bin/env python3
"""Build an offline radio-page hotfix on top of telemetry r4 / SMS web r1."""
import hashlib
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
files = [
    'package/vtmodem/files/usr/share/vtmodem/qmi.uc',
    'package/vtmodem/files/usr/share/vtmodem/t99-control.uc',
    'package/vtmodem/files/usr/share/vtmodem/control-worker.uc',
    'package/vtmodem/files/usr/libexec/vtmodem-radio',
    'package/vtmodem/files/usr/share/rpcd/ucode/vtmodem',
    'package/vtmodem/files/usr/share/rpcd/acl.d/luci-app-vtmodem.json',
    'package/vtmodem/files/usr/share/luci/menu.d/luci-app-vtmodem.json',
    'package/vtmodem/files/www/luci-static/resources/view/vtmodem/radio.js',
    'scripts/install-radio-web.sh',
    'scripts/tests/test-t99-control.uc',
    'scripts/tests/test-t99-control-rpc.uc',
    'scripts/tests/test-vtmodem-radio-controls.js',
]
files += [str(p.relative_to(root)) for p in sorted((root / 'scripts/tests/fixtures').glob('t99-control-*.txt'))]
contents = {name: (root / name).read_bytes() for name in files}
contents['SHA256SUMS'] = ''.join(
    f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in contents.items()
).encode()
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'vt-radio-web-r1.zip'
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in contents.items():
        info = zipfile.ZipInfo('vt-radio-web/' + name, (2026, 9, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if name.endswith('.sh') or name.endswith('/vtmodem-radio') else 0o100644) << 16
        archive.writestr(info, data)
print(f'{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}')
