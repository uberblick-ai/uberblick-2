#!/bin/sh
# Over-inclusive "could <role> have work?" probe for the launch loop.
#   exit 0  something may be eligible — launch the role, which decides for real
#   exit 1  nothing can be eligible — idle without paying for a session
#   exit 2  the probe itself failed — report and idle; never launch on a failed read
# It reads GitHub only and claims nothing. Every rule is broader than the role's
# own pickup, because a false yes costs one session that ends with
# `No eligible <role> work:` while a false no would hide work.
#
# Which repository it reads is the adopting project's own binding, resolved
# before the first read: a probe that fell back to some other project's
# repository would answer confidently about work that is not this project's.
set -u
here=$(dirname "$0")
REPO=$(node "$here/agent-binding.mjs" project.repository) || exit 2
role=${1:-}
case "$role" in
  issue-preparer)
    # unlabelled issues count: the role triages them itself
    n=$(gh issue list -R "$REPO" --state open --limit 200 --json labels --jq \
      '[.[] | .labels | map(.name) | select(index("needs-preparation") or length == 0)] | length') || exit 2 ;;
  implementer)
    # `ready` covers new issues (dependencies unchecked) and recoveries (stale
    # in-progress claims). Any open PR may carry a just-posted fix-up ruling;
    # comment search is indexed asynchronously and can hide that work.
    # The role checks findings, labels and claims itself, so count possible PRs
    # over-inclusively except for drafts, which can never carry a ruling.
    n=$(gh issue list -R "$REPO" --state open --limit 200 --label ready --json number --jq length) || exit 2
    m=$(gh pr list -R "$REPO" --state open --limit 200 --json isDraft --jq \
      '[.[] | select(.isDraft | not)] | length') || exit 2
    n=$((n + m)) ;;
  implementation-reviewer)
    # a review request lives in a PR comment, and a request seconds old is
    # exactly the one a reviewer loop must not miss — GitHub's comment search
    # index lags durable state, so read the unindexed PR list with its comments,
    # project each comment's first line beside its PR number, and count the PRs
    # whose thread carries a request; head, runtime, claim and whether the
    # request is still current stay the role's own read
    firstlines=$(gh pr list -R "$REPO" --state open --json number,comments --jq \
      '.[] | .number as $pr | .comments[].body | "\($pr) \(split("\n")[0])"') || exit 2
    n=$(printf '%s\n' "$firstlines" \
      | sed -n 's/^\([0-9][0-9]*\) Review-request:.*/\1/p' | sort -u | grep -c .) ;;
  integrator)
    n=$(gh pr list -R "$REPO" --state open --json isDraft,labels --jq \
      '[.[] | select(.isDraft | not) | select(.labels | map(.name) | index("needs-human") | not)] | length') || exit 2 ;;
  *) echo "usage: probe-work.sh issue-preparer|implementer|implementation-reviewer|integrator" >&2; exit 2 ;;
esac
if [ "$n" -eq 1 ]; then noun=candidate; else noun=candidates; fi
echo "probe-work: $role: $n $noun"
[ "$n" -gt 0 ]
