#!/usr/bin/env bash
# Only run in an explicitly authorized disposable Docker environment.
set -euo pipefail
: "${WOC_TEST_DOCKER_ALLOWED:?Set to 1 only for a disposable test Docker daemon}"
[[ "$WOC_TEST_DOCKER_ALLOWED" == 1 ]]
image=${1:?instance image reference required}
name="woc-nc-test-${RANDOM}-${RANDOM}"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# No production volume/name/network/port. /config is an anonymous disposable volume.
docker run -d --name "$name" --network none --security-opt seccomp=unconfined --shm-size=1g \
  -e PUID=1000 -e PGID=1000 -e WOC_APP_TYPE=wechat "$image" >/dev/null
ready=0
for _ in $(seq 1 40); do
  if docker exec "$name" pgrep xsettingsd >/dev/null 2>&1; then ready=1; break; fi
  sleep 3
done
[[ "$ready" == 1 ]]
docker exec "$name" bash -ec '
  for bin in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$bin"; then echo "Forbidden standalone browser: $bin" >&2; exit 1; fi
  done
  if dpkg-query -W -f="\${binary:Package}\n" 2>/dev/null | grep -E "^(chromium|chromium-common|chromium-sandbox|google-chrome[^ ]*)$"; then exit 1; fi
  DISPLAY=:1 dump_xsettings | grep -q "Xft/DPI 98304"
  pgrep Xvnc
  pgrep openbox
  command -v xclip
  command -v xdotool
  test -x /woc/wechat-ctl.sh
  for pkg in libnss3 libgtk-3-0 libcups2 libxcb-cursor0 libasound2 libgbm1; do
    dpkg-query -W -f="\${db:Status-Status}" "$pkg" | grep -q installed
  done
  . /woc/app-defs.sh; woc_app_def wechat
  test "$APP_BIN" = /config/wechat/opt/wechat/wechat
'
docker logs "$name" 2>&1 | grep -q '尚未安装'
sleep 10
if docker logs --since 10s "$name" 2>&1 | grep -q '已退出'; then echo 'Unexpected app crash loop' >&2; exit 1; fi
# Verify the retired launcher fails without calling it against any persisted data.
if docker exec "$name" bash -c '. /woc/app-defs.sh; woc_app_def chromium'; then exit 1; fi
echo 'PASS: no standalone browser, shared libraries, desktop, DPI, waiting-for-WeChat-install, retired launcher'
echo 'NOT VERIFIED: real WeChat install/login, WeChatAppEx ldd, IME/clipboard/file-transfer UX'
