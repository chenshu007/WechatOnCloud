#!/usr/bin/env bash
# Explicit local pair build. Never pushes or deploys.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WOC_TEST_DOCKER_ALLOWED:?Only use an authorized disposable build/test Docker environment}"
[[ "$WOC_TEST_DOCKER_ALLOWED" == 1 ]]
: "${WOC_VERSION:?Example: 1.5.0-no-chromium.1}"
[[ "$WOC_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-no-chromium\.[0-9]+$ ]]
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit source before building'; exit 1; }
upstream_version=$(python3 -c 'import json; print(json.load(open("maintenance/upstream.json"))["tag"].removeprefix("v"))')
[[ "$WOC_VERSION" == "$upstream_version"-no-chromium.* ]] || { echo 'Version does not match tracked upstream release'; exit 1; }
revision=$(git rev-parse HEAD)
platform=${WOC_PLATFORM:?Set linux/arm64 or linux/amd64}
[[ "$platform" == linux/arm64 || "$platform" == linux/amd64 ]]
bash scripts/check-no-chromium.sh
for spec in 'woc-panel panel' 'wechat-on-cloud docker'; do
  read -r image context <<< "$spec"
  docker buildx build --load --platform "$platform" --provenance=false --sbom=false \
    --build-arg "WOC_VERSION=$WOC_VERSION" --build-arg "WOC_SOURCE_REVISION=$revision" \
    -t "ghcr.io/chenshu007/$image:$WOC_VERSION" "$context"
done
bash scripts/smoke-no-chromium.sh "ghcr.io/chenshu007/wechat-on-cloud:$WOC_VERSION"
printf 'Built both images from %s; no push/deploy performed. Registry digests are not available until publication.\n' "$revision"
