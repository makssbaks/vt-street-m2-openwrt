#!/usr/bin/env python3
"""Build the WH3000 eMMC image using a verified official ImageBuilder.

No Vertell DTS, MAC migration, QMI hotplug or modem flash is used by this target.
Usage: python3 scripts/build-wh3000.py /path/to/extracted/imagebuilder /path/to/output
ImageBuilder archive and 5G Modem apk must be downloaded/verified first.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
ib, out = (Path(s).resolve() for s in sys.argv[1:3])
cfg = json.loads((repo / 'profiles/wh3000/build.json').read_text())
assert (ib / 'Makefile').is_file() and '25.12.6-mediatek-filogic' in ib.name
third = ib / 'packages/luci-app-5gmodem-3.9.14-r1.apk'
assert hashlib.sha256(third.read_bytes()).hexdigest() == cfg['modem_ui_apk_sha256'], '5G Modem checksum mismatch'
out.mkdir(parents=True, exist_ok=True)
stage = out / 'vtcell-root'
shutil.copytree(repo / 'package/vtcell/files', stage, dirs_exist_ok=True)
license_dir = stage / 'usr/share/licenses/luci-app-vtcell'
license_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(repo / 'package/vtcell/LICENSE', license_dir / 'LICENSE')
for rel in ['usr/libexec/vtcell-collector', 'etc/init.d/vtcell']:
    (stage / rel).chmod(0o755)
apk = ib / 'staging_dir/host/bin/apk'
pkg = ib / 'packages/luci-app-vtcell-1.0.0-r1.apk'
cmd = [str(apk), 'mkpkg', '--files', str(stage), '--output', str(pkg),
       '--info', 'name:luci-app-vtcell', '--info', 'version:1.0.0-r1',
       '--info', 'arch:noarch', '--info', 'license:ISC',
       '--info', 'description:Cell signal dashboard for ModemManager',
       '--info', 'depends:luci-base modemmanager ucode ucode-mod-fs rpcd-mod-ucode flock',
       '--info', 'url:https://github.com/makssbaks/vt-street-m2-openwrt',
       '--sign-key', str(ib / 'keys/local-private-key.pem')]
subprocess.run(cmd, check=True, cwd=ib)
overlay = out / 'overlay'
shutil.copytree(repo / 'profiles/wh3000/files', overlay, dirs_exist_ok=True)
(overlay / 'etc/uci-defaults/99-wh3000-vtcell').chmod(0o755)
identity = dict(cfg)
identity['source_commit'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
identity['source_tree_dirty'] = bool(subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip())
identity['hardware_tested'] = False
(overlay / 'etc/wh3000-build.json').write_text(json.dumps(identity,indent=2)+'\n')
subprocess.run(['make', 'image', 'PROFILE='+cfg['profile'], 'PACKAGES='+' '.join(cfg['packages']),
                'FILES='+str(overlay), 'BIN_DIR='+str(out / 'images'),
                'DISABLED_SERVICES='+' '.join(cfg['disabled_services']),
                'EXTRA_IMAGE_NAME=vtcell-r1', 'ADD_LOCAL_KEY=1'], cwd=ib, check=True)
shutil.copy2(pkg, out / pkg.name)
print('WH3000_IMAGE_BUILD_COMPLETE')
