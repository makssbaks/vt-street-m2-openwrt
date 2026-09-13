# Historical hotfix packages

The four `package-*.py` builders for telemetry, SMS, Radio and Status are retired
in this integration tree. They exit before writing an archive. The firmware
package remains the complete source of runtime dependencies.

The builders originally selected only the files needed by one incremental
hotfix. Running them later on changed RPC/UI files could silently produce a
mixed release: for example telemetry r4 with Radio RPC methods but without the
Radio worker, menu or ACL. Reusing an old ZIP name and generating fresh hashes
would not detect this dependency error.

Previously delivered ZIPs are unchanged. Historical reproduction, if needed,
must use an isolated checkout of the complete original commit and its original
packaging script:

| Bundle | Source commit |
| --- | --- |
| t99-telemetry | `776871fdfc2a0ac905e7e4bee52b10b573586f20` |
| radio-web | `b7869e7e6b9a5fd948e05e26022cc3d38589b0ee` |
| sms-web | `2bfc608a3a378e5e715b917233f98afe9d0aeb39` |
| status-web | `0bd441138ff12eb7a5ccb1853af56239b27c76b8` |

Do not install a historical bundle over a newer version. New features and fixes
need a new, complete versioned package with dependency and installed-file
validation; the historic installers are retained only for archive provenance.
