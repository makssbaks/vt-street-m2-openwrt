#!/usr/bin/env python3
"""Replace this board's profile on both fresh and reused OpenWrt trees."""
from pathlib import Path
import re
import sys


def apply_profile(text, profile):
    block = r'^define Device/vertell_vt-mt7621d\n.*?^endef\n?'
    target = r'^TARGET_DEVICES\s*\+=\s*vertell_vt-mt7621d\s*$\n?'
    if len(re.findall(block, text, re.M | re.S)) > 1:
        raise ValueError('duplicate Vertell profile blocks')
    text = re.sub(block, '', text, flags=re.M | re.S)
    text = re.sub(target, '', text, flags=re.M)
    return text.rstrip() + '\n\n' + profile.rstrip() + '\n'


if __name__ == '__main__':
    dest, source = map(Path, sys.argv[1:])
    dest.write_text(apply_profile(dest.read_text(), source.read_text()))
