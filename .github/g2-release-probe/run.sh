#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] ||
  fail 'Requires a disposable GitHub-hosted Linux runner.'
[[ $# == 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || fail "usage: $0 PLUGIN_RELEASE_SOURCE_SHA"
[[ "${GITHUB_SERVER_URL:-}" == https://github.com && "${GITHUB_API_URL:-}" == https://api.github.com ]] ||
  fail 'Expected the public GitHub service.'

plugin_commit=$1
fork_repo=daniilmann/super-productivity
plugin_repo=daniilmann/sp-telos
fork_old=v20.0.0-fork.4
fork_current=v20.0.0-fork.6
plugin_tag=v0.1.0
fork_old_commit=da7002e55c8fe7279f2a46503eb9456bebfc87f9
fork_current_commit=41202d578128a2117e245e108b940f6a31e9b6e2
helper_dir="$(cd "$(dirname "$0")" && pwd -P)"
runner_dir="$(mktemp -d "${RUNNER_TEMP:?}/g2-release-proof.XXXXXX")"

verify_tag() {
  local repo=$1 tag=$2 commit=$3 ref refs actual
  ref="refs/tags/$tag"
  refs="$(git ls-remote --exit-code "$GITHUB_SERVER_URL/$repo.git" "$ref" "$ref^{}")"
  actual="$(awk -v ref="$ref^{}" '$2==ref {print $1}' <<< "$refs")"
  if [[ -z "$actual" ]]; then
    actual="$(awk -v ref="$ref" '$2==ref {print $1}' <<< "$refs")"
  fi
  [[ "$actual" == "$commit" ]] || fail "$repo $tag does not resolve to $commit."
  printf '%s %s source %s\n' "$repo" "$tag" "$actual"
}

download() {
  local repo=$1 tag=$2 name=$3 output=$4 metadata digest
  metadata="$(curl --disable --fail --silent --show-error --proto '=https' --max-time 30 \
    "$GITHUB_API_URL/repos/$repo/releases/tags/$tag")"
  digest="$(jq -er --arg tag "$tag" --arg name "$name" '
    select(.tag_name == $tag and .draft == false and .prerelease == false)
    | [.assets[] | select(.name == $name and .state == "uploaded" and .size > 0)]
    | select(length == 1) | .[0].digest
    | capture("^sha256:(?<hex>[0-9a-f]{64})$").hex
  ' <<< "$metadata")"
  curl --disable --fail --silent --show-error --location --proto '=https' --max-time 120 \
    --output "$output" "$GITHUB_SERVER_URL/$repo/releases/download/$tag/$name"
  printf '%s  %s\n' "$digest" "$output" | sha256sum --check -
  printf '%s %s %s sha256:%s\n' "$repo" "$tag" "$name" "$digest"
}

verify_tag "$fork_repo" "$fork_old" "$fork_old_commit"
verify_tag "$fork_repo" "$fork_current" "$fork_current_commit"
verify_tag "$plugin_repo" "$plugin_tag" "$plugin_commit"
download "$fork_repo" "$fork_old" superProductivityTelos-web.zip "$runner_dir/web4.zip"
download "$fork_repo" "$fork_current" superProductivityTelos-web.zip "$runner_dir/web6.zip"
download "$plugin_repo" "$plugin_tag" sp-telos.zip "$runner_dir/sp-telos.zip"
verify_tag "$fork_repo" "$fork_old" "$fork_old_commit"
verify_tag "$fork_repo" "$fork_current" "$fork_current_commit"
verify_tag "$plugin_repo" "$plugin_tag" "$plugin_commit"

SP_TELOS_E2E_PLUGIN_ZIP="$runner_dir/sp-telos.zip"
SP_TELOS_E2E_OLD_WEB_DIR="$runner_dir/web4"
SP_TELOS_E2E_WEB_DIR="$runner_dir/web6"
export SP_TELOS_E2E_PLUGIN_ZIP SP_TELOS_E2E_OLD_WEB_DIR SP_TELOS_E2E_WEB_DIR
unzip -p "$SP_TELOS_E2E_PLUGIN_ZIP" manifest.json | jq -e --arg tag "$plugin_tag" '
  .id == "sp-telos" and ("v" + .version) == $tag
' > /dev/null
unzip -q "$runner_dir/web4.zip" -d "$SP_TELOS_E2E_OLD_WEB_DIR"
unzip -q "$runner_dir/web6.zip" -d "$SP_TELOS_E2E_WEB_DIR"
test -s "$SP_TELOS_E2E_WEB_DIR/index.html"
test -s "$SP_TELOS_E2E_OLD_WEB_DIR/index.html"

test_dir="$runner_dir/tests"
TMPDIR="$runner_dir/tmp"
mkdir "$test_dir" "$TMPDIR"
export TMPDIR
for infile in g2.spec.ts stand.ts playwright.config.ts; do
  cp "$helper_dir/$infile.in" "$test_dir/$infile"
done
ln -s "${GITHUB_WORKSPACE:?}/node_modules" "$test_dir/node_modules"
for port in 47173 47174 47901; do
  listeners="$(ss -H -ltn "sport = :$port")"
  [[ -z "$listeners" ]] || fail "Test port $port is busy."
done
expected_image="$(cat "$GITHUB_WORKSPACE/server/supersync-image")"
compose_image="$(sed -n 's|^    image: \(ghcr.io/super-productivity/supersync:.*\)$|\1|p' "$helper_dir/compose.yml")"
[[ "$compose_image" == "$expected_image" ]] || fail 'Compose image differs from the released source pin.'
unset DOCKER_HOST DOCKER_CONTEXT

SP_TELOS_E2E_JWT_SECRET="$(openssl rand -hex 32)"
[[ "$SP_TELOS_E2E_JWT_SECRET" =~ ^[0-9a-f]{64}$ ]]
export SP_TELOS_E2E_JWT_SECRET
compose=(docker compose --env-file /dev/null -p "planner-g2-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}" -f "$helper_dir/compose.yml")
cleanup() {
  local result=$?
  "${compose[@]}" down --volumes --remove-orphans || exit 1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up -d --wait --wait-timeout 180

export PLAYWRIGHT_JSON_OUTPUT_FILE="$runner_dir/playwright-results.json"
cd "$test_dir"
node node_modules/@playwright/test/cli.js test --config playwright.config.ts --retries=0 \
  --grep 'PR-7 released' --reporter=list,json
jq -e '
  [.suites[] | recurse(.suites[]?) | .specs[]?] as $specs |
  ($specs | map(.title)) == ["PR-7 released .4 and .6 exchange core tasks in both directions"] and
  all($specs[]; (.tests | length) == 1 and
    all(.tests[];
      .projectName == "" and .expectedStatus == "passed" and .status == "expected" and [.results[].status] == ["passed"]))
' "$PLAYWRIGHT_JSON_OUTPUT_FILE"
