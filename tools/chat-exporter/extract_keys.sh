#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/secrets/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${WOC_INSTANCE_ID:?Set WOC_INSTANCE_ID in secrets/.env or environment}"
WOC_CONTAINER="${WOC_CONTAINER:-woc-wx-${WOC_INSTANCE_ID}}"
WOC_VOLUME="${WOC_VOLUME:-woc-data-${WOC_INSTANCE_ID}}"
IMAGE_NAME="${EXPORTER_IMAGE:-woc-chat-exporter:local}"
DOCKER_CMD="${DOCKER_CMD:-docker}"

mkdir -p "${SCRIPT_DIR}/secrets"
chmod 700 "${SCRIPT_DIR}/secrets"

exec $DOCKER_CMD run --rm --name "woc-key-extract-once" \
  --pid="container:${WOC_CONTAINER}" \
  --cap-add=SYS_PTRACE \
  -v "${WOC_VOLUME}:/config:ro" \
  -v "${SCRIPT_DIR}:/app:ro" \
  -v "${SCRIPT_DIR}/secrets:/secrets:rw" \
  "${IMAGE_NAME}" \
  python3 -u /app/extract_keys.py
