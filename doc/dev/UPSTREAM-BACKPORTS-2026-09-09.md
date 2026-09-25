# NAS upstream backports — 2026-09-09

This is a selective source backport onto the NAS working tree, not a wholesale
upstream merge or a deployment. Upstream reviewed: Gloridust/WechatOnCloud main
`98b6495741601772d47c8d8939283b529b3b44e4` (latest tag `v1.4.9`).

## Applied

| Upstream | NAS adaptation |
| --- | --- |
| `94b591e` | XSETTINGS DPI corrected from 96 to 98304 in both autostart and font application; new instance Docker logs capped at 20m x 2. Unrelated upgrade UI and image deletion omitted. |
| `7dc2053`, `9ec3ea2` | Explicit restart, heal, watchdog and identity-reset paths preserve the current image ID. Image existence is checked before removing the old container. Permission errors and failed removal propagate instead of being treated as absence. Both VNC TCP connections use keepalive. |
| `91a220d`, `9644b31` | Installer resumes downloads, reports disk failures and logs progress. Kernel flock replaces stale-PID lock removal; mirrors have separate partial files; full data archive is validated; failed installation swap attempts to restore the old installation. util-linux is declared in the future image build. |
| `1261e96` | Admin diagnostic export includes bounded installation status and last 50 log lines. No chat history is added. |
| `01a00f3` | Fixed VNC rejection reason codes, bounded 60-second deduplication, no raw cookies/URLs/header values in new rejection logs. Existing LAN Host policy is retained. |
| `3ce8065` | New image supplies WOC_VERSION even when old image metadata cannot be inspected; custom instance image pin and runtime configuration remain preserved. |
| `0347405` | Manual panel forwarding gains an automatic-Return checkbox, OFF on each page load and instance change. No persistent opt-in or extra function-key panel. Bridge approval remains independent. |
| `896a788` (behavioral adaptation) | The NAS branch lacks upstream's manifest-probe/version-coupling subsystem. Rather than importing it and its latest fallback, explicit upgrade now propagates pull failure before rebuilding. Existing WOC_WECHAT_IMAGE pin stays unchanged. |

## Preserved / deferred

- Preserved: active VNC viewer watchdog protection, Chromium metrics cleanup,
  private credential-file modes, Access reauthentication, retired PWA caching,
  existing Compose and all deployment configuration.
- Deferred: automatic old-image removal, registry latest fallback, browser
  version/CI migration, login/session/UI restructuring, Tailscale/IPv6 allowlist
  expansion and Telegram bot changes.
- No Bridge source, whitelist, API, approval state or test-stage gate changed.
- No running container restart/rebuild, real installation, screenshot, input,
  clipboard operation or message send performed by this backport.

## Tests (isolated Mac copy)

```sh
cd panel/server
npm ci --ignore-scripts --no-audit --no-fund
./node_modules/.bin/tsc --noEmit
node --import tsx --test tests/upstream-backports.test.ts
cd ../web
npm ci --ignore-scripts --no-audit --no-fund
npm run build
cd ../..
python3 -m unittest discover -s docker/tests -v
bash -n docker/wechat-ctl.sh docker/autostart
git diff --check
```

Results: 9 service tests + 7 installer tests passed; TypeScript, Vite build,
shell parsing and patch whitespace checks passed. Installer tests use only
temporary directories, local mock downloads/Docker and mocked pkill. Real Linux
image build, real deb install and WeChat UI validation were not performed.

## Deployment and rollback

The source now requires util-linux/flock in newly built instance images. Do not
copy the installer alone into an image that lacks it. Build and pin custom
panel/instance image digests as a separate release. Recheck screenshot scale
and all Bridge coordinates after any display/client image change.

Before writing back, original modified files are backed up under an adjacent
`WechatOnCloud-src-backport-20260909.*` directory on the NAS. Its `manifest.json`
records old/new SHA-256 hashes, and `backport.patch` records the exact source
change. Restore only the listed files after confirming they have not acquired
later changes; remove newly added files only if their hash still matches the
manifest. No runtime rollback is required because no image was deployed.

The NAS Git HEAD points to unavailable object `281e317...`; even an isolated
copy excluding SMB AppleDouble files cannot read it. Original Git metadata is
untouched. The baseline snapshot, patch and hashes preserve a reviewable change
without inventing or overwriting the missing history.
