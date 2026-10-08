#!/bin/sh
# Give the complete browser run private, disk-backed temporary storage. Chromium
# otherwise inherits the host's shared /tmp tmpfs and fails opaquely when another
# process fills it (#626).
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)

if [ -n "${XDG_CACHE_HOME:-}" ]; then
	cache_root=$XDG_CACHE_HOME
elif [ -n "${HOME:-}" ]; then
	cache_root=$HOME/.cache
else
	printf 'e2e: cannot establish temporary storage: neither XDG_CACHE_HOME nor HOME is set. Browsers were not started.\n' >&2
	exit 1
fi

base=$cache_root/uberblick/e2e
if ! mkdir -p "$base"; then
	printf 'e2e: cannot create temporary storage at %s. Browsers were not started.\n' "$base" >&2
	exit 1
fi
base=$(CDPATH= cd "$base" && pwd -P)
case "$base" in
	/tmp | /tmp/* | /private/tmp | /private/tmp/*)
		printf 'e2e: refusing shared /tmp storage at %s; set XDG_CACHE_HOME to a disk-backed location. Browsers were not started.\n' "$base" >&2
		exit 1
		;;
esac

run_tmp=$(mktemp -d "$base/run.XXXXXX") || {
	printf 'e2e: cannot mint private temporary storage below %s. Browsers were not started.\n' "$base" >&2
	exit 1
}
cleanup() {
	rm -rf "$run_tmp"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

probe=$run_tmp/.write-probe
if ! (umask 077 && printf '' > "$probe") 2>/dev/null; then
	printf 'e2e: temporary storage at %s is not writable. Browsers were not started.\n' "$run_tmp" >&2
	exit 1
fi
rm -f "$probe"

# The diagnosed host still crashed with 778 MiB free. One GiB is the smallest
# round threshold above that observed failure, checked before Chromium starts.
minimum_kib=1048576
available_kib=$(df -Pk "$run_tmp" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$available_kib" in
	'' | *[!0-9]*)
		printf 'e2e: cannot verify available capacity at %s. Browsers were not started.\n' "$run_tmp" >&2
		exit 1
		;;
esac
if [ "$available_kib" -lt "$minimum_kib" ]; then
	printf 'e2e: temporary storage at %s has %s KiB available; at least %s KiB is required. Browsers were not started.\n' "$run_tmp" "$available_kib" "$minimum_kib" >&2
	exit 1
fi

TMPDIR=$run_tmp
export TMPDIR
cd "$root"

# Download engines only. Host system libraries are operator-owned; a missing
# WebKit library must remain a visible Playwright launch failure.
pnpm --filter @uberblick/web exec playwright install chromium webkit
# The harness supplies its own project binding; a contributor selection is not required.
fnox exec --if-missing warn -- pnpm --filter @uberblick/web run e2e "$@"
