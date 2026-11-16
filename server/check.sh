#!/usr/bin/env bash
# Read-only health and security check of the SuperSync server.
# Runs on the server as root, delivered over SSH: ssh <server> 'bash -s' < server/check.sh
# Takes no parameters; every value comes from the server itself.
# Prints one line per check and exits non-zero if any check fails.
set -uo pipefail

PROJECT=super-sync-server
CONTAINERS=(supersync-server supersync-postgres supersync-caddy)
HEALTH_URL=http://127.0.0.1:1900/health
MIN_QUOTA_BYTES=1073741824
MAX_DISK_USE_PCT=80
UPSTREAM_REPO=super-productivity/super-productivity

failures=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
info() { printf 'info  %s\n' "$*"; }

# 1. Containers of the compose project: running and healthy.
for c in "${CONTAINERS[@]}"; do
  state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}/{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null)"
  if [ "$state" = "running/healthy/$PROJECT" ]; then ok "container $c"; else bad "container $c: ${state:-missing}"; fi
done

# 2. Health endpoint.
health="$(curl -fsS -m 10 "$HEALTH_URL" 2>/dev/null)"
if printf '%s' "$health" | jq -e '.status == "ok" and .db == "connected"' >/dev/null 2>&1; then
  ok "health $health"
else
  bad "health: ${health:-no answer}"
fi

# 3. supersync image: running digest equals the pinned SUPERSYNC_IMAGE in .env.
workdir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' supersync-server 2>/dev/null)"
pinned="$(sed -n 's/^SUPERSYNC_IMAGE=//p' "$workdir/.env" 2>/dev/null | tail -1)"
running="$(docker inspect -f '{{.Config.Image}}' supersync-server 2>/dev/null)"
running_digest="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$running" 2>/dev/null | sed -n 's/.*@//p' | head -1)"
case "$pinned" in
  *@sha256:*)
    if [ "${pinned##*@}" = "$running_digest" ]; then ok "supersync digest ${running_digest}"; else bad "supersync digest ${running_digest:-unknown} != pinned ${pinned##*@}"; fi ;;
  "") bad "SUPERSYNC_IMAGE not found in .env" ;;
  *) info "SUPERSYNC_IMAGE pinned by tag only; running digest ${running_digest:-unknown}" ;;
esac
running_tag="${running%%@*}"; running_tag="${running_tag##*:}"

# 4. Storage quota of every account (no addresses are printed).
quota="$(docker exec supersync-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "select count(*), coalesce(min(storage_quota_bytes),0), count(*) filter (where storage_quota_bytes is null or storage_quota_bytes < '"$MIN_QUOTA_BYTES"'), coalesce(max(storage_used_bytes),0) from users"' 2>/dev/null)"
read -r users min_quota low_quota max_used <<<"${quota:-x x x x}"
if [ "$users" = x ]; then
  bad "quota: query failed"
elif [ "$low_quota" = 0 ]; then
  ok "quota: $users accounts, min quota $min_quota bytes, max used $max_used bytes"
else
  bad "quota: $low_quota of $users accounts below $MIN_QUOTA_BYTES bytes"
fi

# 5. Disk and database sizes (neighbour databases share this PostgreSQL).
use_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "${use_pct:-100}" -lt "$MAX_DISK_USE_PCT" ]; then ok "disk / ${use_pct}% used"; else bad "disk / ${use_pct}% used (limit ${MAX_DISK_USE_PCT}%)"; fi
dbs="$(docker exec supersync-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "=" -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1"' 2>/dev/null | tr '\n' ' ')"
if [ -n "$dbs" ]; then info "database sizes: $dbs"; else bad "database sizes: query failed"; fi

# 6. Host protection and time.
if systemctl is-active --quiet fail2ban && fail2ban-client status sshd >/dev/null 2>&1; then ok "fail2ban sshd jail"; else bad "fail2ban sshd jail"; fi
if ufw status 2>/dev/null | grep -Eq '^22/tcp +LIMIT'; then ok "ufw rate limit on 22/tcp"; else bad "ufw rate limit on 22/tcp"; fi
if systemctl is-active --quiet unattended-upgrades; then ok "unattended-upgrades"; else bad "unattended-upgrades"; fi
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then ok "NTP synchronized"; else bad "NTP not synchronized"; fi

# 7. Images against their registries: a changed digest of the same tag means a rebuilt image.
for c in supersync-caddy supersync-postgres; do
  image="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)"
  local_digest="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null | sed -n 's/.*@//p' | head -1)"
  remote_digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty')"
  if [ -z "$remote_digest" ]; then
    bad "$image: registry digest not available"
  elif [ "$remote_digest" = "$local_digest" ]; then
    ok "$image digest matches the registry"
  else
    bad "$image: registry has $remote_digest, running $local_digest (rebuilt image)"
  fi
done
latest="$(curl -fsS -m 15 "https://api.github.com/repos/$UPSTREAM_REPO/releases/latest" 2>/dev/null | jq -r '.tag_name // empty')"
if [ -z "$latest" ]; then
  bad "supersync: latest upstream release not available"
elif [ "$latest" = "$running_tag" ]; then
  ok "supersync $running_tag is the latest upstream release"
else
  bad "supersync: running $running_tag, latest upstream release $latest"
fi

echo "failures: $failures"
[ "$failures" -eq 0 ]
