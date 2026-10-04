#!/bin/sh
# The contributor quick-start, printed by mise's `enter` hook and by
# `mise run welcome`. One owner for the text, two ways to reach it.
#
# It is a convenience message, so it must never become startup work: static
# `printf` calls and nothing else. No Node, no pnpm, no fnox, no git, no
# network, no config written, no task started — entering the checkout with none
# of the project's tools installed still ends here in a millisecond.
#
# It is also *only* for a human at a terminal. A pipe, a CI runner or an editor
# collecting mise's output gets silence, because a decoration in captured output
# is contamination.
set -eu

# Not a terminal: something is reading this, not someone.
[ -t 1 ] || exit 0
# CI at all — set but empty still means a runner, and silence is the safe way
# to be wrong.
[ -z "${CI+set}" ] || exit 0
# The caller asked mise for quiet; a hook is exactly what that means.
[ "${MISE_QUIET:-}" != "1" ] || exit 0

printf 'uberblick\n'
printf '\n'
printf '  first time   mise run setup -- --yes\n'
printf '  develop      mise run dev\n'
printf '  check        mise run lint\n'
printf '               mise run typecheck\n'
printf '               mise run test\n'
printf '  all commands mise tasks\n'
