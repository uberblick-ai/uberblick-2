#!/bin/sh

# The wrapper and service entrypoints use the same alphabets. Checking inside
# the images keeps plain `docker compose up` from bypassing the host wrapper.
validate_remote_settings() {
  # These alphabets are byte ranges, independent of the host locale.
  LC_ALL=C
  export LC_ALL
  case "${WEB_WORKSPACES-}" in
    *[!A-Za-z0-9,-]*)
      printf 'WEB_WORKSPACES may only contain A-Z a-z 0-9 , - : it is substituted into the JSON configuration document Caddy serves, where a quote or a backslash would let the value inject further keys — including one that retargets the browser at another hub. A workspace id is a uuid, optionally prefixed with a display slug.\n' >&2
      return 1
      ;;
  esac
  case "${WEB_HUB_URL-}" in
    *[!A-Za-z0-9:/._-]*)
      printf 'WEB_HUB_URL may only contain A-Z a-z 0-9 : / . _ - : it is substituted into the JSON configuration document Caddy serves, where a quote, a backslash or whitespace would let the value inject further keys — including a second hubUrl that retargets every browser. It is a plain ws:// or wss:// address, which needs none of them.\n' >&2
      return 1
      ;;
  esac
  case "${TAILSCALE_HOST-}" in
    *[!A-Za-z0-9.-]*)
      printf 'TAILSCALE_HOST may only contain A-Z a-z 0-9 . - : it is the Caddy site address and the hub endpoint served in the JSON configuration document, where a quote, a backslash or whitespace would let the value inject further keys. It is the full MagicDNS name, with no scheme and no trailing slash.\n' >&2
      return 1
      ;;
  esac
  case "${WEB_HOST-}" in
    *[!A-Za-z0-9.-]*)
      printf 'WEB_HOST may only contain A-Z a-z 0-9 . - : use a DNS hostname without a scheme, port or path.\n' >&2
      return 1
      ;;
  esac
  validate_dns_host WEB_HOST "${WEB_HOST-}" || return 1
  validate_dns_host TAILSCALE_HOST "${TAILSCALE_HOST-}" || return 1
  if [ -n "${WEB_HOST-}" ] && [ -n "${TAILSCALE_HOST-}" ] && [ "$WEB_HOST" != "$TAILSCALE_HOST" ]; then
    printf 'WEB_HOST and TAILSCALE_HOST must name the same host when both are set.\n' >&2
    return 1
  fi
  for setting in HTTPS_BIND_IP TAILSCALE_IP; do
    case "$setting" in
      HTTPS_BIND_IP) address=${HTTPS_BIND_IP-} ;;
      TAILSCALE_IP) address=${TAILSCALE_IP-} ;;
    esac
    validate_bind_ip "$setting" "$address" || return 1
  done
  port=${LOOPBACK_PORT:-8080}
  case "$port" in
    *[!0-9]* | 0* | ??????*)
      printf 'LOOPBACK_PORT must be an integer from 1 to 65535.\n' >&2
      return 1
      ;;
  esac
  if [ "$port" -gt 65535 ]; then
    printf 'LOOPBACK_PORT must be an integer from 1 to 65535.\n' >&2
    return 1
  fi
  host=${WEB_HOST:-${TAILSCALE_HOST:-}}
  case "$host" in
    *.[tT][sS].[nN][eE][tT])
      if [ -z "${TAILSCALE_IP-}" ]; then
        printf 'TAILSCALE_IP is required for a ts.net host; publish HTTPS only on its Tailscale address.\n' >&2
        return 1
      fi
      case "$TAILSCALE_IP" in
        100.*)
          tailscale_second=${TAILSCALE_IP#100.}
          tailscale_second=${tailscale_second%%.*}
          if [ "$tailscale_second" -ge 64 ] && [ "$tailscale_second" -le 127 ]; then :; else
            printf 'TAILSCALE_IP must be this host\047s Tailscale IPv4 address (100.64.0.0/10).\n' >&2
            return 1
          fi
          ;;
        *) printf 'TAILSCALE_IP must be this host\047s Tailscale IPv4 address (100.64.0.0/10).\n' >&2; return 1 ;;
      esac
      ;;
  esac
  if [ -n "$host" ]; then
    case "${WEB_HUB_URL-}" in
      '' | wss://*) ;;
      *) printf 'WEB_HUB_URL must use wss:// when WEB_HOST or TAILSCALE_HOST is set.\n' >&2; return 1 ;;
    esac
  else
    case "${WEB_HUB_URL-}" in
      '' | wss://* | ws://localhost:* | ws://127.0.0.1:*) ;;
      *) printf 'WEB_HUB_URL must use wss:// beyond loopback.\n' >&2; return 1 ;;
    esac
  fi
}

validate_dns_host() {
  name=$1
  value=$2
  [ -n "$value" ] || return 0
  case "$value" in
    *.*) ;;
    *) printf '%s must be a qualified DNS hostname for a publicly trusted certificate.\n' "$name" >&2; return 1 ;;
  esac
  case "$value" in
    *[!0-9.]*) ;;
    *) printf '%s must be a DNS hostname, not an IP address.\n' "$name" >&2; return 1 ;;
  esac
  if [ "${#value}" -gt 253 ]; then
    printf '%s must be a qualified DNS hostname.\n' "$name" >&2
    return 1
  fi
  remaining=$value
  while :; do
    label=${remaining%%.*}
    case "$label" in
      '' | -* | *-)
        printf '%s contains an invalid DNS label.\n' "$name" >&2
        return 1
        ;;
    esac
    if [ "${#label}" -gt 63 ]; then
      printf '%s contains an invalid DNS label.\n' "$name" >&2
      return 1
    fi
    case "$remaining" in
      *.*) remaining=${remaining#*.} ;;
      *) break ;;
    esac
  done
  case "$value" in
    *.[lL][oO][cC][aA][lL] | *.[lL][oO][cC][aA][lL][hH][oO][sS][tT] | *.[iI][nN][tT][eE][rR][nN][aA][lL] | *.[hH][oO][mM][eE].[aA][rR][pP][aA] | [hH][oO][mM][eE].[aA][rR][pP][aA])
      printf '%s must support a publicly trusted certificate; internal names are unsupported.\n' "$name" >&2
      return 1
      ;;
  esac
}

validate_bind_ip() {
  name=$1
  value=$2
  [ -n "$value" ] || return 0
  case "$value" in
    *[!0-9.]* | .* | *. | *..*) printf '%s must be an IPv4 bind address.\n' "$name" >&2; return 1 ;;
  esac
  remaining=$value
  count=0
  while :; do
    octet=${remaining%%.*}
    case "$octet" in
      ????* | 0?*) printf '%s must be an IPv4 bind address.\n' "$name" >&2; return 1 ;;
    esac
    if [ "$octet" -gt 255 ]; then
      printf '%s must be an IPv4 bind address.\n' "$name" >&2
      return 1
    fi
    count=$((count + 1))
    case "$remaining" in
      *.*) remaining=${remaining#*.} ;;
      *) break ;;
    esac
  done
  if [ "$count" -ne 4 ]; then
    printf '%s must be an IPv4 bind address.\n' "$name" >&2
    return 1
  fi
}
