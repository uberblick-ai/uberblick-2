#!/bin/bash

# Keep execution in the final call: a truncated bash -c download must do no work.
setup_help() {
  cat <<'HELP'
Start or update a Docker hub on this host.
Requires curl, Docker Engine 28.0.0+, Compose 2.24.4+, and Linux ss or macOS netstat.

  /bin/bash -c "$(curl -fsSL https://uberblick.ai/setup-hub.sh)"

Variables (put them before /bin/bash):
  HUB_HOST       Unset: loopback HTTP. Public DNS name: HTTPS on port 443.
                 A *.ts.net name: Tailscale HTTPS on Linux (Tailscale must be up).
  HUB_VERSION    Pin X.Y.Z; otherwise use GitHub's latest hub release.
  HUB_DIR        Deployment directory (default: ~/uberblick-remote).
  LOOPBACK_PORT  Loopback HTTP port (default: 8080).
  ALLOW_ROOT=1   Allow an explicit root run; Docker is never installed or updated.
  HELP=1         Print this help without checks or changes (also: --help).

Re-run to update or change the HTTPS hostname. Without route variables, an
existing .env keeps its route and other values. HTTPS-to-loopback switching,
release downgrades, Windows/WSL, Podman and rootless Docker are not supported.
HELP
}

setup_fail() {
  printf 'setup-hub: %s\n' "$*" >&2
  exit 1
}

setup_version_valid() {
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

setup_version_at_least() {
  awk -v actual="$1" -v minimum="$2" 'BEGIN {
    split(actual, a, "."); split(minimum, b, ".");
    for (i=1; i<=3; i++) { if (a[i]+0>b[i]+0) exit 0; if (a[i]+0<b[i]+0) exit 1 }
  }'
}

setup_host_valid() {
  local rest=$1 label
  [ "${#rest}" -le 253 ] || return 1
  case "$rest" in
    *[!A-Za-z0-9.-]* | *.[lL][oO][cC][aA][lL] | *.[lL][oO][cC][aA][lL][hH][oO][sS][tT] | *.[iI][nN][tT][eE][rR][nN][aA][lL] | *.[hH][oO][mM][eE].[aA][rR][pP][aA] | [hH][oO][mM][eE].[aA][rR][pP][aA]) return 1 ;;
  esac
  [[ $rest =~ [A-Za-z] ]] && [[ $rest = *.* ]] || return 1
  while :; do
    label=${rest%%.*}
    case "$label" in '' | -* | *-) return 1 ;; esac
    [ "${#label}" -le 63 ] || return 1
    case "$rest" in *.*) rest=${rest#*.} ;; *) break ;; esac
  done
}

setup_ip_valid() {
  awk -v address="$1" 'BEGIN {
    if (split(address, octets, ".")!=4) exit 1;
    for (i=1; i<=4; i++) if (octets[i]!~/^[0-9]+$/ || octets[i]>255 || octets[i]~/^0[0-9]/) exit 1;
  }'
}

setup_env_value() {
  printf '%s\n' "$resolved" | awk -v key="$1" 'index($0,key "=")==1 {print substr($0,length(key)+2); exit}'
}

setup_set() {
  local key=$1 value=$2
  awk -v key="$key" -v value="$value" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {next}
    {print}
    END {print key "=" value}
  ' "$stage/.env" > "$stage/env.next"
  mv "$stage/env.next" "$stage/.env"
}

setup_fetch() {
  local url=$1 output=$2 result
  if ! result=$(curl -fLsS --connect-timeout 15 --max-time 120 -o "$output" -w '%{http_code} %{url_effective}' "$url"); then
    setup_fail "download failed: $url (HTTP ${result%% *}). Check the URL and network, then re-run."
  fi
  fetch_url=${result#* }
}

setup_bindings() {
  docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{println $port .HostIp .HostPort}}{{end}}{{end}}' "$1"
}

setup_overlap() {
  [ "$1" != '::' ] && { [ "$1" = "$bind" ] || [ "$1" = '0.0.0.0' ] || [ "$1" = '*' ] || [ "$bind" = '0.0.0.0' ]; }
}

setup_owns_binding() {
  local protocol ip port
  while read -r protocol ip port; do
    case "$protocol" in */tcp) ;; *) continue ;; esac
    if [ "$port" = "$listen_port" ] && [ "$ip" = "$1" ]; then return 0; fi
  done <<< "$own_bindings"
  return 1
}

setup_check_port() {
  local sockets candidates id protocol ip port endpoint own_id ours bindings
  if [ "$os" = Linux ]; then
    command -v ss >/dev/null 2>&1 || setup_fail 'port check requires ss from iproute2. Install it: https://wiki.linuxfoundation.org/networking/iproute2'
    sockets=$(ss -H -ltn) || setup_fail 'port check: ss failed; install iproute2 or repair access and re-run.'
    sockets=$(printf '%s\n' "$sockets" | awk '{print $4}')
  else
    command -v netstat >/dev/null 2>&1 || setup_fail 'port check requires macOS /usr/sbin/netstat. Restore the system tool and re-run.'
    sockets=$(netstat -an) || setup_fail 'port check: netstat failed; repair access to the system socket table and re-run.'
    sockets=$(printf '%s\n' "$sockets" | awk '/^tcp/ && !/^tcp6[[:space:]]/ && /LISTEN/ {print $4}')
  fi
  candidates=$(docker ps --format '{{.ID}}')
  for id in $candidates; do
    ours=0
    for own_id in $ids; do [ "$id" != "$own_id" ] || ours=1; done
    [ "$ours" = 0 ] || continue
    bindings=$(setup_bindings "$id") || setup_fail 'port check: Docker could not inspect a container publication. Check docker info and re-run before updating.'
    while read -r protocol ip port; do
      case "$protocol" in */tcp) ;; *) continue ;; esac
      if [ "$port" = "$listen_port" ] && setup_overlap "$ip"; then
        setup_fail "port check: $bind:$listen_port is published by another Docker deployment. Stop that listener or choose another route/LOOPBACK_PORT."
      fi
    done <<< "$bindings"
  done
  while read -r endpoint; do
    [ -n "$endpoint" ] || continue
    case "$endpoint" in
      *:*) port=${endpoint##*:}; ip=${endpoint%:*}; ip=${ip#\[}; ip=${ip%\]}; ip=${ip%%%*} ;;
      *.*) port=${endpoint##*.}; ip=${endpoint%.*} ;;
      *) continue ;;
    esac
    if [ "$ip" = '*' ]; then ip=0.0.0.0; fi
    if [ "$port" = "$listen_port" ] && setup_overlap "$ip" && ! setup_owns_binding "$ip"; then
      setup_fail "port check: $bind:$listen_port is in use. Stop that listener or choose another route/LOOPBACK_PORT."
    fi
  done <<< "$sockets"
}

setup_cleanup() {
  [ -z "${stage:-}" ] || rm -rf "$stage"
}

setup_main() {
  case "${HELP:-0}:$*" in 1:* | *:--help) setup_help; return 0 ;; esac
  [ "$#" = 0 ] || setup_fail 'unknown argument. Use HELP=1 or --help.'
  set -Eeuo pipefail
  local step='preflight' fix='Correct the error above and re-run.'
  trap 'setup_fail "$step failed. $fix"' ERR
  local stage=''
  trap setup_cleanup EXIT
  trap 'exit 130' INT TERM HUP
  local directory=${HUB_DIR:-$HOME/uberblick-remote}
  local host_given=${HUB_HOST+x} requested_host=${HUB_HOST:-}
  local port_given=${LOOPBACK_PORT+x} requested_port=${LOOPBACK_PORT:-}
  local requested_version=${HUB_VERSION:-} os arch engine compose_version resolved=''
  local web_host='' tail_host='' tail_ip='' https_ip='' loop_port=8080 files='' inferred=0 previous='' old_protocol=''
  local project=${COMPOSE_PROJECT_NAME:-uberblick-remote} ids id workdir service running hub_id='' own_bindings=''
  local bind listen_port status='' protocol='' target fetch_url='' url file attempt
  unset HUB_VERSION LOOPBACK_PORT COMPOSE_FILE WEB_HOST TAILSCALE_HOST TAILSCALE_IP HTTPS_BIND_IP
  [ "$(id -u)" != 0 ] || [ "${ALLOW_ROOT:-0}" = 1 ] || setup_fail 'root run refused. Run as your Docker user, or explicitly set ALLOW_ROOT=1.'
  command -v curl >/dev/null 2>&1 || setup_fail 'curl is required. Install curl: https://curl.se/download.html'
  os=$(uname -s); arch=$(uname -m)
  case "$os:$arch" in Linux:x86_64 | Linux:aarch64 | Linux:arm64 | Darwin:*) ;; *) setup_fail 'host check: requires Linux x86_64/arm64 or macOS. See https://docs.docker.com/get-started/get-docker/' ;; esac
  command -v docker >/dev/null 2>&1 || setup_fail 'Docker Engine 28.0.0+ and Compose 2.24.4+ are required: https://docs.docker.com/get-started/get-docker/'
  docker info >/dev/null || setup_fail 'Docker daemon is unreachable without sudo. Start Docker Desktop on macOS; on Linux see https://docs.docker.com/engine/install/linux-postinstall/ (docker group and a new session). Requires Engine 28.0.0+.'
  engine=$(docker version --format '{{.Server.Version}}')
  setup_version_at_least "$engine" 28.0.0 || setup_fail "Docker Engine $engine is too old; requires 28.0.0+. Update Docker: https://docs.docker.com/engine/install/"
  compose_version=$(docker compose version --short) || setup_fail 'Docker Compose 2.24.4+ is required: https://docs.docker.com/compose/install/'
  compose_version=${compose_version#v}
  setup_version_at_least "$compose_version" 2.24.4 || setup_fail "Docker Compose $compose_version is too old; requires 2.24.4+. Update: https://docs.docker.com/compose/install/"
  if [ -n "$requested_version" ]; then
    setup_version_valid "$requested_version" || setup_fail 'HUB_VERSION must be X.Y.Z, without hub-v. Choose https://github.com/uberblick-ai/uberblick-2/releases'
  fi
  case "$directory" in /*) ;; *) directory=$PWD/$directory ;; esac
  if [ -d "$directory" ]; then directory=$(cd "$directory" && pwd -P); fi
  if [ -f "$directory/.env" ]; then
    resolved=$(docker compose --env-file "$directory/.env" -f - config --environment <<< 'services: {}') || setup_fail 'read .env failed. Repair its Compose dotenv syntax, then re-run.'
    web_host=$(setup_env_value WEB_HOST); tail_host=$(setup_env_value TAILSCALE_HOST)
    tail_ip=$(setup_env_value TAILSCALE_IP); https_ip=$(setup_env_value HTTPS_BIND_IP)
    loop_port=$(setup_env_value LOOPBACK_PORT); loop_port=${loop_port:-8080}
    files=$(setup_env_value COMPOSE_FILE); previous=$(setup_env_value HUB_VERSION)
    project=$(setup_env_value COMPOSE_PROJECT_NAME); project=${project:-uberblick-remote}
  fi
  ids=$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')
  for id in $ids; do
    [ -f "$directory/.env" ] || setup_fail "deployment check: project $project already exists, but HUB_DIR has no .env. Set HUB_DIR to its existing deployment directory."
    workdir=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id")
    [ "$workdir" = "$directory" ] || setup_fail "deployment check: project $project belongs to $workdir. Set HUB_DIR to that existing deployment directory."
    service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")
    running=$(docker inspect --format '{{.State.Running}}' "$id")
    if [ "$running" = true ]; then
      own_bindings="$own_bindings
$(setup_bindings "$id")"
      if [ "$service" = hub ]; then hub_id=$id; fi
    fi
  done
  if [ -n "$hub_id" ]; then
    status=$(docker exec "$hub_id" ub-hub status) || setup_fail 'status check failed on the running hub. Run docker compose exec hub ub-hub doctor from HUB_DIR before retrying.'
    previous=$(printf '%s\n' "$status" | awk '$1=="release" {print $2}')
    old_protocol=$(printf '%s\n' "$status" | awk '$1=="protocol" {print $2}')
  fi
  if [ -n "$host_given" ]; then
    if [ -z "$requested_host" ] && [ -n "${web_host:-$tail_host}" ]; then
      setup_fail 'route check: switching HTTPS back to loopback is unsupported. Keep HUB_HOST or follow REMOTE.md to change the deployment manually.'
    fi
    web_host=$requested_host; tail_host=''; tail_ip=''; files=''
  fi
  if [ -n "$port_given" ]; then loop_port=$requested_port; fi
  case "$loop_port" in '' | *[!0-9]* | 0* | ??????*) setup_fail 'LOOPBACK_PORT must be an integer from 1 to 65535.' ;; esac
  [ "$loop_port" -le 65535 ] || setup_fail 'LOOPBACK_PORT must be an integer from 1 to 65535.'
  [ -z "$web_host" ] || [ -z "$tail_host" ] || [ "$web_host" = "$tail_host" ] || setup_fail 'route check: WEB_HOST and TAILSCALE_HOST differ. Correct .env or supply HUB_HOST.'
  target=${web_host:-$tail_host}
  if [ -n "$target" ]; then
    setup_host_valid "$target" || setup_fail 'HUB_HOST must be a qualified DNS name for a publicly trusted certificate, without scheme, path or port. Correct HUB_HOST or .env.'
  fi
  case "$target" in
    *.[tT][sS].[nN][eE][tT])
      [ "$os" = Linux ] || setup_fail 'Tailscale HTTPS needs Linux; macOS supports loopback or public DNS HTTPS. Use another HUB_HOST.'
      command -v tailscale >/dev/null 2>&1 || setup_fail 'Tailscale is missing. Install and connect it: https://tailscale.com/download/linux'
      local current_tail_ip
      current_tail_ip=$(tailscale ip -4) || setup_fail 'Tailscale is not up. Run tailscale up, then re-run.'
      [[ $current_tail_ip =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+$ ]] || setup_fail 'Tailscale is not up with an IPv4 address. Run tailscale up, then re-run.'
      if [ -n "$host_given" ] || [ ! -f "$directory/.env" ]; then tail_ip=$current_tail_ip; fi
      ;;
  esac
  if [ -z "$files" ]; then
    inferred=1
    files=compose.yml
    if [ -n "$target" ]; then files=$files:remote.https.yml; fi
    if [ -n "$tail_ip" ]; then files=$files:remote.tailscale.yml; fi
  fi
  case ":$files:" in
    *:remote.https.yml:*) bind=${tail_ip:-${https_ip:-0.0.0.0}}; listen_port=443 ;;
    *) bind=127.0.0.1; listen_port=$loop_port ;;
  esac
  setup_ip_valid "$bind" || setup_fail 'route check: HTTPS_BIND_IP or TAILSCALE_IP is not an IPv4 bind address. Correct .env or supply HUB_HOST.'
  setup_check_port
  step='release selection'; fix='Choose a published hub-vX.Y.Z release and re-run.'
  url=https://github.com/uberblick-ai/uberblick-2/releases
  if [ -n "$requested_version" ]; then
    local response
    if ! response=$(curl -fLsS --connect-timeout 15 --max-time 120 -o /dev/null -w '%{http_code} %{url_effective}' "$url/tag/hub-v$requested_version"); then
      if [ "${response%% *}" = 404 ]; then
        printf 'No release hub-v%s. Three newest releases:\n' "$requested_version" >&2
        curl -fLsS --connect-timeout 15 --max-time 120 'https://api.github.com/repos/uberblick-ai/uberblick-2/releases?per_page=3' | grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"hub-v[0-9]+\.[0-9]+\.[0-9]+"' | sed 's/.*"hub-v/hub-v/; s/"$//' >&2 || true
      fi
      setup_fail "release lookup failed: $url/tag/hub-v$requested_version (HTTP ${response%% *}). Choose a published version or check the network."
    fi
    target=$requested_version
  else
    setup_fetch "$url/latest" /dev/null
    target=${fetch_url##*/hub-v}
    setup_version_valid "$target" || setup_fail 'latest release did not resolve to hub-vX.Y.Z. Check https://github.com/uberblick-ai/uberblick-2/releases and pin HUB_VERSION.'
  fi
  if [ -n "$previous" ]; then
    setup_version_valid "$previous" || setup_fail 'existing release is not X.Y.Z. Check ub-hub status and HUB_VERSION in .env before updating.'
    setup_version_at_least "$target" "$previous" || setup_fail "downgrade from $previous to $target refused. Follow REMOTE.md's backup-and-restore rollback procedure."
  fi
  step='staging release files'; fix='Check HUB_DIR permissions, free space and network, then re-run.'
  umask 077
  mkdir -p "$directory"
  stage=$(mktemp -d "$directory/.setup-hub.XXXXXXXX")
  for file in compose.yml remote.env.example remote.https.yml remote.tailscale.yml; do
    setup_fetch "$url/download/hub-v$target/$file" "$stage/$file"
  done
  if [ -f "$directory/.env" ]; then cp "$directory/.env" "$stage/.env"; else cp "$stage/remote.env.example" "$stage/.env"; fi
  setup_set HUB_VERSION "$target"
  if [ "$inferred" = 1 ]; then setup_set COMPOSE_FILE "$files"; fi
  if [ ! -f "$directory/.env" ] || [ -n "$host_given" ]; then
    setup_set WEB_HOST "$web_host"; setup_set TAILSCALE_HOST "$tail_host"; setup_set TAILSCALE_IP "$tail_ip"
    setup_set LOOPBACK_PORT "$loop_port"
  elif [ -n "$port_given" ]; then setup_set LOOPBACK_PORT "$loop_port"; fi
  chmod 600 "$stage/.env"
  step='Compose validation'; fix='Correct the .env settings in HUB_DIR and re-run; no release files were replaced.'
  (cd "$stage" && docker compose config --quiet)
  if [ -n "$hub_id" ] && [ "$previous" != "$target" ]; then
    step='hub backup'; fix='Run docker compose exec hub ub-hub doctor in HUB_DIR, repair backup storage and re-run; no release files were replaced.'
    docker exec "$hub_id" ub-hub backup
  fi
  step='publishing release files'; fix='Check HUB_DIR permissions and free space, then re-run.'
  for file in compose.yml remote.env.example remote.https.yml remote.tailscale.yml .env; do mv "$stage/$file" "$directory/$file"; done
  cd "$directory"
  step='Compose validation'; fix='Correct .env and run docker compose config --quiet in HUB_DIR, then re-run.'
  docker compose config --quiet
  step='Compose pull'; fix='Check registry access and the selected release/platform, then re-run.'
  docker compose pull
  step='Compose startup'; fix='Check docker compose logs --tail=100 hub caddy in HUB_DIR, fix the reported cause and re-run.'
  docker compose up -d
  step='hub readiness'; fix='Check docker compose logs --tail=100 hub caddy in HUB_DIR and re-run after correcting the cause.'
  for ((attempt=0; attempt<30; attempt++)); do
    if status=$(docker compose exec -T hub ub-hub status 2>&1) && printf '%s\n' "$status" | awk '$1=="hub" && $2=="running" {found=1} END {exit !found}'; then break; fi
    sleep 2
  done
  if [ "$attempt" = 30 ]; then
    printf '%s\n' "$status" >&2
    docker compose logs --tail=100 hub caddy >&2 || true
    setup_fail "hub readiness: not running after 30 checks, two seconds apart. $fix"
  fi
  printf '%s\n' "$status"
  protocol=$(printf '%s\n' "$status" | awk '$1=="protocol" {print $2}')
  if [ -n "$previous" ] && [ "$previous" != "$target" ]; then printf 'Updated hub from %s to %s.\n' "$previous" "$target"; else printf 'Hub release %s is running.\n' "$target"; fi
  if [ -n "$old_protocol" ] && [ "$old_protocol" != "$protocol" ]; then
    printf 'Protocol changed from %s to %s: update every client in the same sitting; restart agents and ub open, and reload browser tabs.\n' "$old_protocol" "$protocol"
  fi
  target=${web_host:-$tail_host}
  if [ -n "$target" ]; then url=https://$target; else url=http://localhost:$loop_port; fi
  printf '\nOpen %s\nClaim a fresh hub with: ub auth login %s\nThe first GitHub sign-in becomes the hub\047s administrator. Sign in now.\n' "$url" "$url"
  setup_cleanup
  trap - EXIT
}

setup_main "$@"
