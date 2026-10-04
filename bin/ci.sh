#!/bin/sh
# Local CI: verify one pushed commit on this machine and sign off on it.
#
#   mise run ci <sha | pull request number>
#
# Run from a checkout at origin/main, the same place `mise run review` requires.
# The steps:
#   1. The isolated review (`mise run review`): lint, typecheck and the test
#      suite in a Linux container with no network. When it passes, the commit
#      gets the `signoff` status, which is the merge gate.
#   2. Browser e2e, unless every change is documentation or agent process. It
#      runs on the host in a temporary worktree at the commit and reports the
#      advisory `signoff/e2e` status, which never blocks a merge.
# A failed step posts a red status instead, so a failed run is never mistaken
# for one that did not happen. Signing off needs the gh-signoff extension.
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)

if [ $# -ne 1 ]; then
	printf 'usage: mise run ci <sha | pull request number>\n' >&2
	exit 2
fi

if ! gh signoff --help >/dev/null 2>&1; then
	printf 'ci: gh signoff is missing; install it with `gh extension install basecamp/gh-signoff`.\n' >&2
	exit 1
fi

case "$1" in
	*[!0-9]* | '') target=$1 ;;
	*) target=$(gh pr view "$1" --json headRefOid --jq .headRefOid) ;;
esac
git -C "$root" fetch --quiet origin main
sha=$(git -C "$root" rev-parse --verify --end-of-options "$target^{commit}")
short=$(printf '%s' "$sha" | cut -c1-12)

step() {
	printf '\n== %s (%s)\n' "$1" "$short"
}

fail() {
	gh signoff fail --commit "$sha" --description "$1 failed" ${2:+"$2"} >/dev/null
	printf '\nci: %s failed at %s; posted a failing status.\n' "$1" "$short" >&2
	exit 1
}

step "Isolated review: lint, typecheck, test"
(cd "$root" && mise run review "$sha") || fail "isolated review"
gh signoff --commit "$sha"
printf 'ci: signed off %s\n' "$short"

# Same rule as before local CI: skip the browser run only when every changed path
# is documentation or agent process. An unreadable or empty diff runs it.
browser=false
changed=$(git -C "$root" diff --name-only --no-renames "origin/main...$sha" --) || browser=true
[ -n "$changed" ] || browser=true
for path in $changed; do
	case "$path" in
		.agents/* | AGENTS.md | CLAUDE.md | .claude/* | .codex/* | .github/ISSUE_SPEC.md | .github/ISSUE_TEMPLATE/* | ub-agents.yaml | docs/*) ;;
		*/*) browser=true ;;
		*.md | *.markdown) ;;
		*) browser=true ;;
	esac
done
if [ "$browser" = false ]; then
	printf '\nci: only documentation or agent process changed; skipping browser e2e.\n'
	exit 0
fi

step "Browser e2e (advisory)"
worktree=$(mktemp -d "${TMPDIR:-/tmp}/ub-ci.XXXXXX")
cleanup() {
	git -C "$root" worktree remove --force "$worktree" 2>/dev/null || rm -rf "$worktree"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
git -C "$root" worktree add --quiet --detach "$worktree" "$sha"
(cd "$worktree" && mise trust >/dev/null && mise run install && mise run e2e) || fail "browser e2e" e2e
gh signoff --commit "$sha" e2e
printf 'ci: browser e2e passed at %s\n' "$short"
