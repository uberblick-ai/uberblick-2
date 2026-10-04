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
}
