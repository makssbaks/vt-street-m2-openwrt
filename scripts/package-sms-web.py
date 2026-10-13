#!/usr/bin/env python3
"""Retired historical hotfix builder; never mix current sources into old ZIPs."""
raise SystemExit(
    "ERROR: This historical hotfix builder is retired in the integration tree.\n"
    "Current RPC/UI/helpers must be released together with matching dependencies.\n"
    "For historical reproduction only, use an isolated checkout of\n"
    "2bfc608a3a378e5e715b917233f98afe9d0aeb39\n"
    "and its original packaging script. Do not install that old bundle over a newer release.\n"
    "See docs/historical-hotfixes.md. No archive was written."
)
