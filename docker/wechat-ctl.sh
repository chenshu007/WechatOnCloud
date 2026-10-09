#!/bin/bash
# 微信下载/解压控制脚本。由面板经 docker exec 触发（不再用共享卷/守护进程）：
#   install / update   下载官方 deb、dpkg-deb -x 解压到 /config/wechat、原子替换、pkill 让 autostart 用新版重启
#   status             输出当前状态 JSON（面板轮询用）
# 用 docker exec --user abc 调用，文件归属与微信运行用户一致。
set -u

STATE_DIR="${WOC_STATE_DIR:-/config/.woc-state}"
STATUS_FILE="$STATE_DIR/status.json"

INSTALL_DIR="${WOC_INSTALL_DIR:-/config/wechat}" # opt/wechat/wechat under this root
WORK_DIR="${WOC_WORK_DIR:-/config/.woc-dl}"     # Same filesystem as INSTALL_DIR
VERSION_FILE="$INSTALL_DIR/.woc-version"

CDN_MAIN="${WECHAT_CDN:-https://dldir1v6.qq.com/weixin/Universal/Linux}"
CDN_FALLBACK="${WECHAT_CDN_FALLBACK:-https://dldir1.qq.com/weixin/Universal/Linux}"
UA="Mozilla/5.0"

wechat_bin() { echo "$INSTALL_DIR/opt/wechat/wechat"; }
is_installed() { [ -x "$(wechat_bin)" ]; }
cur_version() { [ -f "$VERSION_FILE" ] && cat "$VERSION_FILE" || echo ""; }

deb_filename() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) echo "WeChatLinux_x86_64.deb" ;;
    arm64) echo "WeChatLinux_arm64.deb" ;;
    *) echo "" ;;
  esac
}

# write_status <phase> <percent> <message>
# phase: idle|downloading|extracting|installing|done|error
write_status() {
  local phase="$1" percent="$2" message="$3"
  local installed=false version
  is_installed && installed=true
  version="$(cur_version)"
  mkdir -p "$STATE_DIR"
  cat > "$STATUS_FILE.tmp" <<EOF
{"phase":"$phase","percent":$percent,"installed":$installed,"version":"$version","message":"$message","updatedAt":$(date +%s)}
EOF
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Read the kernel's lock table; never take/unlink the install lock in a status query.
# 0 = held, 1 = absent, 2 = cannot prove. Inherited child locks also count as active.
installer_lock_state() {
  [ -r /proc/locks ] || return 2
  local info dev inode major minor key
  [ -e "$STATE_DIR/.install.flock" ] || return 1
  info="$(stat -Lc '%d %i' "$STATE_DIR/.install.flock" 2>/dev/null)" || return 2
  read -r dev inode <<< "$info"
  case "$dev:$inode" in *[!0-9:]*|:) return 2 ;; esac
  major=$(( ((dev >> 8) & 4095) | ((dev >> 32) & 4294963200) ))
  minor=$(( (dev & 255) | ((dev >> 12) & 4294967040) ))
  printf -v key '%x:%x:%s' "$major" "$minor" "$inode"
  awk -v key="$key" '
    function norm(k, a) { split(k,a,":"); sub(/^0+/,"",a[1]); sub(/^0+/,"",a[2]); return (a[1]==""?"0":a[1]) ":" (a[2]==""?"0":a[2]) ":" a[3] }
    $2 == "FLOCK" && norm($6) == key { found=1 }
    END { exit !found }
  ' /proc/locks
}

curl_failure_reason() {
  case "$1" in
    5) echo "代理域名解析失败（DNS）" ;;
    6) echo "下载域名解析失败（DNS）" ;;
    7) echo "无法建立网络连接" ;;
    18|56) echo "下载传输中断" ;;
    22) echo "下载服务器返回 HTTP 错误" ;;
    23) echo "本地写入失败" ;;
    28) echo "请求超时（连接或下载阶段）" ;;
    33|36) echo "服务器无法继续断点续传" ;;
    35) echo "TLS 握手失败" ;;
    60) echo "TLS 证书验证失败" ;;
    *) echo "下载失败（curl $1）" ;;
  esac
}

# Only pre-transfer failures qualify. A timeout after connecting is not proof
# of an unreachable server. Never shortcut an existing/increased partial file.
pretransfer_failure() {
  [ "$2" -eq 0 ] && [ "$3" -eq 0 ] || return 1
  case "$1" in
    5|6|7|35|60) return 0 ;;
    28) [ "$4" = "000" ] && [ "$5" = "0.000000" ] ;;
    *) return 1 ;;
  esac
}

print_status() {
  if [ -f "$STATUS_FILE" ]; then
    local snapshot lock_state
    snapshot="$(cat "$STATUS_FILE")"
    if printf '%s' "$snapshot" | grep -Eq '"phase"[[:space:]]*:[[:space:]]*"(busy|downloading|extracting|installing)"'; then
      installer_lock_state; lock_state=$?
      # Recheck snapshot and lock to avoid declaring a newly started install stale.
      if [ "$lock_state" -eq 1 ] && [ "$snapshot" = "$(cat "$STATUS_FILE")" ]; then
        installer_lock_state; lock_state=$?
        if [ "$lock_state" -eq 1 ]; then
          local installed=false; is_installed && installed=true
          printf '{"phase":"error","percent":0,"installed":%s,"version":"%s","message":"上次安装已中断，请重新点击安装或更新以重试","updatedAt":%s}\n' "$installed" "$(cur_version)" "$(date +%s)"
          return
        fi
      fi
    fi
    printf '%s\n' "$snapshot"
  elif is_installed; then
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"$(cur_version)\",\"message\":\"已安装\",\"updatedAt\":$(date +%s)}"
  else
    echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
  fi
}

log() { echo "[$(date '+%F %T')] $*" >> "$STATE_DIR/install.log" 2>/dev/null; }

do_install() (
  local file tmp pid total cur pct rc=1 attempt=0 unreachable_rounds=0
  local before http_code connect_time metrics unreachable main_reason fallback_reason failed_pretransfer
  file="$(deb_filename)"
  if [ -z "$file" ]; then
    write_status error 0 "不支持的架构：微信仅提供 x86_64 / arm64"
    return
  fi

  mkdir -p "$STATE_DIR" "$WORK_DIR"
  # Kernel lock: no stale-PID removal race, released when this subshell exits.
  # Never unlink the lock inode: another process may already be waiting on it.
  command -v flock >/dev/null 2>&1 || { write_status error 0 "镜像缺少 flock，请先更新实例镜像"; return 1; }
  exec 9>>"$STATE_DIR/.install.flock" || return 1
  if ! flock -n 9; then return 0; fi
  # Bound the install log while holding the same lock as the writer.
  if [ -f "$STATE_DIR/install.log" ]; then
    tail -c 65536 "$STATE_DIR/install.log" > "$STATE_DIR/install.log.tmp" &&
      mv "$STATE_DIR/install.log.tmp" "$STATE_DIR/install.log"
  fi
  log "开始安装 file=$file"

  tmp="$WORK_DIR/wechat.deb"

  # 取总大小用于进度 + 完整性判断（HEAD 可能失败，失败则进度走不确定值 -1）
  for base in "$CDN_MAIN" "$CDN_FALLBACK"; do
    total="$(curl -fsSLI --connect-timeout 20 --max-time 30 -A "$UA" "$base/$file" 2>/dev/null | tr -d '\r' \
            | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')"
    [ -n "${total:-}" ] && break
  done
  : "${total:=0}"
  case "$total" in *[!0-9]*|'') total=0 ;; esac

  # 磁盘空间预检（NAS 小盘写满是「卡进度/干脆没进度」头号真凶）：
  # 盘满时 curl 以退出码 23=本地写失败告终，连 status.json 都写不进去（面板遂显示无进度），
  # 极易被误当网络/代理问题（真实案例：用户为此查了半天梯子）。这里提前 df 判定，给可执行的磁盘报错。
  # 需求 ≈ deb 本体 + dpkg-deb -x 解压(约 3× deb) + 更新时新旧并存余量 → 取 deb 4 倍，不低于 900MB 兜底。
  local deb_kb need_kb avail_kb
  deb_kb=$(( ( total > 0 ? total : 220000000 ) / 1024 ))
  need_kb=$(( deb_kb * 4 )); [ "$need_kb" -lt 921600 ] && need_kb=921600
  avail_kb="$(df -Pk "$WORK_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "${avail_kb:-}" ] && [ "$avail_kb" -lt "$need_kb" ] 2>/dev/null; then
    log "磁盘空间不足：$WORK_DIR 可用 $((avail_kb/1024))MB < 需要 $((need_kb/1024))MB"
    write_status error 0 "磁盘空间不足：约需 $((need_kb/1024))MB 空闲，当前仅 $((avail_kb/1024))MB。请在宿主清理磁盘/旧镜像（docker image prune）后重试"
    return
  fi

  write_status downloading 0 "正在下载微信安装包"
  # 断点续传下载（-C -）：网络半路中断/被中间设备掐断时，下次从已下字节【继续】而非从 0 重来
  #（这正是"反复卡在同一百分比退出"的解药）。不用 curl 自带的 --retry：它重试前会把本次已下的部分截掉、从本次起点
  # 重下（实测进度从 35% 掉回 0%，重试请求不带 Range）。中断 / 60 秒无进度一律交给外层循环，按已下字节续传，
  # 并在主备地址间轮换（移植自上游 a18c706）。
  # 关键：绝不在重试前删 $tmp —— 保留部分文件才能续传。
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt+1))
    failed_pretransfer=0
    for base in "$CDN_MAIN" "$CDN_FALLBACK"; do
      # Keep each mirror's partial download separate. A fallback must not append
      # bytes from a different CDN/version to the first mirror's partial file.
      if [ "$base" = "$CDN_MAIN" ]; then tmp="$WORK_DIR/wechat-main.deb";
      else tmp="$WORK_DIR/wechat-fallback.deb"; fi
      if [ "$(cat "$tmp.url" 2>/dev/null || true)" != "$base/$file" ]; then
        rm -f "$tmp"
        printf '%s' "$base/$file" > "$tmp.url"
      fi
      before="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
      metrics="$tmp.metrics"
      curl -fSL -C - --connect-timeout 20 \
           --max-time 600 --speed-time 60 --speed-limit 1024 \
           --write-out '%{http_code} %{time_connect}\n' \
           -A "$UA" -o "$tmp" "$base/$file" > "$metrics" & pid=$!
      while kill -0 "$pid" 2>/dev/null; do
        if [ "${total:-0}" -gt 0 ] 2>/dev/null; then
          cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
          pct=$(( cur * 90 / total )); [ "$pct" -gt 90 ] && pct=90
          write_status downloading "$pct" "正在下载微信安装包"
        else
          write_status downloading -1 "正在下载微信安装包"
        fi
        sleep 1
      done
      wait "$pid"; rc=$?
      http_code=""; connect_time=""
      read -r http_code connect_time < "$metrics" || true
      rm -f "$metrics"
      [ "$rc" -eq 0 ] && break 2
      cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
      if pretransfer_failure "$rc" "$before" "$cur" "$http_code" "$connect_time"; then
        failed_pretransfer=$((failed_pretransfer+1))
      fi
      if [ "$base" = "$CDN_MAIN" ]; then main_reason="$(curl_failure_reason "$rc")";
      else fallback_reason="$(curl_failure_reason "$rc")"; fi
      log "curl 退出码 ${rc}（attempt=${attempt}），已下 $(stat -c%s "$tmp" 2>/dev/null || echo 0) 字节"
      # Local write failures should stop immediately, not spend six rounds retrying.
      [ "$rc" -eq 23 ] && break 2
      # A server without Range support needs a fresh attempt; don't loop forever
      # against an unresumable partial file. Ordinary network errors retain it.
      if [ "$rc" -eq 33 ] || [ "$rc" -eq 36 ]; then rm -f "$tmp"; fi
    done
    # 两个地址都一个字节没拿到（DNS / 连接 / TLS 失败）且连续两轮如此才快速失败：没有 curl 自带重试兜底后，
    # 只看一轮会把一次偶发抖动当成连不上。
    if [ "$failed_pretransfer" -eq 2 ]; then unreachable_rounds=$((unreachable_rounds+1)); else unreachable_rounds=0; fi
    if [ "$unreachable_rounds" -ge 2 ]; then
      log "两个下载地址均未开始传输，停止外层重试：主地址 ${main_reason}；备用地址 ${fallback_reason}"
      write_status error 0 "两个微信下载地址均不可用：主地址 ${main_reason}；备用地址 ${fallback_reason}。请检查 NAS 的 DNS、网络、代理或证书后重试"
      return 1
    fi
    write_status downloading -1 "下载中断，正在续传重试（$attempt/6）"
    sleep 2
  done
  if [ "$rc" -ne 0 ]; then
    log "下载最终失败 rc=${rc}，已下 $(stat -c%s "$tmp" 2>/dev/null || echo 0)/$total"
    # curl 退出码 23=本地写失败：几乎总是盘写满（本场景最常见）。别误导用户查网络——
    # 再 df 复查一次，剩余空间过低同样判为磁盘问题，给磁盘专属报错。
    avail_kb="$(df -Pk "$WORK_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
    if [ "$rc" -eq 23 ] || { [ -n "${avail_kb:-}" ] && [ "${avail_kb:-0}" -lt 51200 ] 2>/dev/null; }; then
      log "判定为磁盘空间不足（rc=${rc}，$WORK_DIR 可用 ${avail_kb:-?}KB）"
      write_status error 0 "磁盘空间不足，下载无法写入。请在宿主清理磁盘/旧镜像（docker image prune）后重试"
      return
    fi
    write_status error 0 "$(curl_failure_reason "$rc")；多次续传仍未完成，已有下载片段保留，请检查网络后重试"
    return
  fi

  write_status extracting 92 "正在解压安装"
  # Validate both control metadata and the complete data archive before swap.
  if ! dpkg-deb -f "$tmp" Version >/dev/null 2>&1 ||
     ! (set -o pipefail; dpkg-deb --fsys-tarfile "$tmp" | tar -tf - >/dev/null) 2>/dev/null; then
    log "包不完整/损坏，删除重下"
    rm -f "$tmp"
    write_status error 0 "安装包不完整或损坏，已清理，请再次点击安装（将重新下载）"
    return
  fi
  local newroot="$WORK_DIR/new"
  rm -rf "$newroot"; mkdir -p "$newroot"
  if ! dpkg-deb -x "$tmp" "$newroot" 2>/dev/null; then
    write_status error 0 "解压失败，安装包可能损坏"
    rm -rf "$WORK_DIR"; return
  fi
  local ver; ver="$(dpkg-deb -f "$tmp" Version 2>/dev/null || echo "")"

  if [ ! -x "$newroot/opt/wechat/wechat" ]; then
    write_status error 0 "解压后未找到微信可执行文件"
    rm -rf "$WORK_DIR"; return
  fi

  write_status installing 96 "正在安装"
  # 原子替换：先挪走旧版再就位新版，最后清理
  rm -rf "$INSTALL_DIR.old"
  if [ -e "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$INSTALL_DIR.old" || { write_status error 0 "无法备份旧安装，已停止"; return 1; }
  fi
  if ! mv "$newroot" "$INSTALL_DIR"; then
    [ ! -e "$INSTALL_DIR.old" ] || mv "$INSTALL_DIR.old" "$INSTALL_DIR"
    write_status error 0 "安装替换失败，已尝试恢复旧安装"
    return 1
  fi
  echo "$ver" > "$VERSION_FILE"
  rm -rf "$INSTALL_DIR.old" "$WORK_DIR"

  write_status done 100 "安装完成"
  # 让 autostart 循环用新版本重启微信（若正在运行）
  pkill -f "$INSTALL_DIR/opt/wechat/wechat" 2>/dev/null || true
)

case "${1:-status}" in
  status)
    print_status
    ;;
  install|update)
    do_install
    ;;
  *)
    echo "用法: $0 {install|update|status}" >&2; exit 1 ;;
esac
