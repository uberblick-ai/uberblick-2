#!/bin/sh
# Post one run retrospective to the discussion the project bound to a channel:
#   sh scripts/post-retrospective.sh <channel> <body-file>
# The destination is the adopting project's own binding — the repository under
# `project.repository` and the discussion number under
# `project.retrospectives.<channel>` — and it is still never the caller's.
# A discussion comment is posted by GraphQL node id, and a guessed id lands on a
# live discussion in a stranger's public repository (twice, 2026-09). This
# script resolves the id from the bound number inside the bound repository,
# refuses to post unless the resolved discussion's URL is the expected one, and
# never accepts an id, a number or a repository from the caller. Reading the
# destination from a binding rather than from an argument is what keeps that
# true: a channel names a declaration, and an undeclared channel resolves to
# nothing rather than to a number someone typed.
set -u
usage='usage: post-retrospective.sh <channel> <body-file>'
here=$(dirname "$0")
if [ "$#" -ne 2 ]; then
  echo "$usage" >&2
  exit 2
fi
channel=$1
body_file=$2
# A channel is a binding name, never a number, a slug or a node id.
case $channel in
  *[!a-z0-9-]* | '' | -* | *-) echo "$usage" >&2; exit 2 ;;
esac
case $channel in
  *[!0-9]*) ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [ ! -s "$body_file" ]; then
  echo "post-retrospective: body file is missing or empty: $body_file" >&2
  exit 2
fi

slug=$(node "$here/agent-binding.mjs" project.repository) || exit 1
number=$(node "$here/agent-binding.mjs" "project.retrospectives.$channel") || exit 1
case $slug in
  */*/* | */ | /* | *[!A-Za-z0-9._/-]*) echo "post-retrospective: project.repository is not <owner>/<repo>: $slug" >&2; exit 1 ;;
  */*) ;;
  *) echo "post-retrospective: project.repository is not <owner>/<repo>: $slug" >&2; exit 1 ;;
esac
case $number in
  '' | *[!0-9]*) echo "post-retrospective: project.retrospectives.$channel is not a discussion number: $number" >&2; exit 1 ;;
esac
owner=${slug%%/*}
repo=${slug#*/}
expected_url="https://github.com/$owner/$repo/discussions/$number"

resolved=$(gh api graphql \
  -f owner="$owner" -f repo="$repo" -F number="$number" \
  -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){id url}}}' \
  --jq '.data.repository.discussion | "\(.id) \(.url)"') || {
  echo "post-retrospective: cannot resolve $expected_url" >&2
  exit 1
}
id=${resolved%% *}
url=${resolved#* }
if [ -z "$id" ] || [ "$url" != "$expected_url" ]; then
  echo "post-retrospective: refusing to post: resolved '$url' for $expected_url" >&2
  exit 1
fi

gh api graphql \
  -f discussionId="$id" -F body=@"$body_file" \
  -f query='mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{url}}}' \
  --jq '.data.addDiscussionComment.comment.url' || {
  echo "post-retrospective: post to $expected_url failed" >&2
  exit 1
}
