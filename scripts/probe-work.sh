#!/bin/sh
# Over-inclusive "could <role> have work?" probe for the launch loop.
#   exit 0  something may be eligible — launch the role, which decides for real
#   exit 1  nothing can be eligible — idle without paying for a session
#   exit 2  the probe itself failed — report and idle; never launch on a failed read
# It reads GitHub only and claims nothing. Every rule is broader than the role's
# own pickup, because a false yes costs one session that ends with
# `No eligible <role> work:` while a false no would hide work.
set -u
REPO=uberblick-ai/uberblick-2
role=${1:-}
case "$role" in
  issue-preparer)
    # unlabelled issues count: the role triages them itself
    n=$(gh issue list -R "$REPO" --state open --limit 200 --json labels --jq \
      '[.[] | .labels | map(.name) | select(index("needs-preparation") or length == 0)] | length') || exit 2 ;;
  implementer)
    # `ready` covers new issues (dependencies unchecked) and recoveries (stale
    # in-progress claims); a PR whose thread names fix-now findings is a fix-up
    n=$(gh issue list -R "$REPO" --state open --limit 200 --label ready --json number --jq length) || exit 2
    m=$(gh search prs -R "$REPO" --state open --match comments fix-now --json number --jq length) || exit 2
    n=$((n + m)) ;;
  implementation-reviewer)
    # a review request lives in a PR comment; head, runtime and claims are the
    # role's own check, so any PR whose thread mentions one is a candidate
    n=$(gh search prs -R "$REPO" --state open --match comments "Review-request" --json number --jq length) || exit 2 ;;
  integrator)
    n=$(gh pr list -R "$REPO" --state open --json isDraft,labels --jq \
      '[.[] | select(.isDraft | not) | select(.labels | map(.name) | index("needs-human") | not)] | length') || exit 2 ;;
  *) echo "usage: probe-work.sh issue-preparer|implementer|implementation-reviewer|integrator" >&2; exit 2 ;;
esac
if [ "$n" -eq 1 ]; then noun=candidate; else noun=candidates; fi
echo "probe-work: $role: $n $noun"
[ "$n" -gt 0 ]
