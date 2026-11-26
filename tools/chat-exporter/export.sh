#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/secrets/.env"
ENV_ARGS=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ENV_ARGS+=(--env-file "$ENV_FILE")
fi

: "${WOC_INSTANCE_ID:?Set WOC_INSTANCE_ID in secrets/.env or environment}"
WOC_VOLUME="${WOC_VOLUME:-woc-data-${WOC_INSTANCE_ID}}"
EXPORT_OUT_DIR="${EXPORT_OUT_DIR:-${SCRIPT_DIR}/output}"
IMAGE_NAME="${EXPORTER_IMAGE:-woc-chat-exporter:local}"
DOCKER_CMD="${DOCKER_CMD:-docker}"

NET_ARGS=()
if [ -n "${PROXY_CONTAINER:-}" ]; then
  PROXY_NET=$($DOCKER_CMD inspect "$PROXY_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{break}}{{end}}' 2>/dev/null || true)
  if [ -n "$PROXY_NET" ]; then
    NET_ARGS+=(--network "$PROXY_NET")
  fi
fi

exec $DOCKER_CMD run --rm \
  "${NET_ARGS[@]}" \
  "${ENV_ARGS[@]}" \
  -e EXPORT_UID="${EXPORT_UID:-1000}" \
  -e EXPORT_GID="${EXPORT_GID:-10}" \
  -v "${WOC_VOLUME}:/config:ro" \
  -v "${SCRIPT_DIR}:/app:ro" \
  -v "${SCRIPT_DIR}/secrets:/secrets:ro" \
  -v "${EXPORT_OUT_DIR}:/output:rw" \
  "${IMAGE_NAME}" \
  python3 -u /app/export_contact.py "$@"
