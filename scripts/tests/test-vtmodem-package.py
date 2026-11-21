#!/usr/bin/env python3
"""Execute actual package prepare/compile/install macros with a host compiler.

Checks inventory and permissions, not MIPS ABI or firmware bootability.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--include', help='Optional sqlite3.h directory for this host')
p.add_argument('--sqlite-so', help='Optional existing libsqlite3 shared library')
a = p.parse_args()
root = Path(__file__).resolve().parents[2]
package = root / 'package/vtmodem'
source = package / 'files'
with tempfile.TemporaryDirectory(prefix='vt-package-') as temp:
    temp = Path(temp)
    (temp/'include').mkdir()
    (temp/'rules.mk').write_text('')
    (temp/'include/package.mk').write_text('')
    if a.sqlite_so:
        (temp/'libsqlite3.so').symlink_to(Path(a.sqlite_so).resolve())
    staged = temp/'root'
    staged.mkdir()
    make = temp/'host.mk'
    make.write_text(f'''TOPDIR := {temp}
INCLUDE_DIR := {temp}/include
PKG_BUILD_DIR := {temp}/build
TARGET_CC := {os.environ.get('CC', 'cc')}
TARGET_CFLAGS := -O2 -Wall -Wextra -Werror {'-I'+a.include if a.include else ''}
TARGET_LDFLAGS := -L{temp}
CP := cp -fpR
INSTALL_DIR := install -d -m0755
INSTALL_BIN := install -m0755
INSTALL_DATA := install -m0644
INSTALL_CONF := install -m0600
include {package}/Makefile
.PHONY: host-install
host-install:
\t$(call Build/Prepare)
\t$(call Build/Compile)
\t$(call Package/vtmodem/install,{staged})
''')
    subprocess.run(['make','--no-print-directory','-s','-f',str(make),'host-install'],cwd=package,check=True,timeout=45)
    renamed={'usr/bin/vt-at-locked':'usr/bin/vt-at','usr/bin/vt-sms-locked':'usr/bin/vt-sms'}
    executable=('etc/hotplug.d/','etc/init.d/','etc/uci-defaults/','lib/netifd/proto/','usr/bin/','usr/libexec/')
    count=0
    for path in source.rglob('*'):
        if not path.is_file(): continue
        relative=path.relative_to(source).as_posix()
        target=staged/renamed.get(relative,relative)
        assert target.is_file() and not target.is_symlink(), f'Missing install: {relative}'
        assert target.read_bytes()==path.read_bytes(), f'Stale install: {relative}'
        if relative.startswith(executable): assert target.stat().st_mode & 0o111, relative
        count+=1
    for name in ['vt-at.real','vt-sms.real','vt-traffic-db']:
        target=staged/'usr/bin'/name
        assert target.read_bytes().startswith(b'\x7fELF') and target.stat().st_mode & 0o111, name
    # Dependencies which are not guaranteed by a minimal luci-base installation.
    make_text=(package/'Makefile').read_text()
    for dependency in ['+ucode','+ucode-mod-fs','+vnstat2','+libsqlite3','+flock','+qmi-utils']:
        assert dependency in make_text, dependency
    config=(root/'config/seed.config').read_text()
    for setting in ['CONFIG_BUSYBOX_CUSTOM=y','CONFIG_BUSYBOX_CONFIG_TIMEOUT=y']:
        assert setting in config, setting
    print(f'VT_PACKAGE_INSTALL_TESTS_OK: {count} payload files and 3 compiled host binaries')
