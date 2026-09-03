#!/bin/sh
# Post one run retrospective to the fixed uberblick discussion for a channel:
#   sh scripts/post-retrospective.sh preparation|implementation|workflow-audit|technical-audit <body-file>
# The discussion targets are hardcoded here and nowhere else. A discussion
# comment is posted by GraphQL node id, and a guessed id lands on a live
# discussion in a stranger's public repository (twice, 2026-09). This script
# resolves the id from the number inside the fixed repository, refuses to post
# unless the resolved discussion's URL is the expected one, and never accepts
# an id, a number or a repository from the caller.
set -u
usage='usage: post-retrospective.sh preparation|implementation|workflow-audit|technical-audit <body-file>'
owner=uberblick-ai
repo=uberblick-2
if [ "$#" -ne 2 ]; then
  echo "$usage" >&2
  exit 2
fi
case $1 in
  preparation) number=506 ;;
  implementation) number=522 ;;
  workflow-audit) number=540 ;;
  technical-audit) number=541 ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
body_file=$2
if [ ! -s "$body_file" ]; then
  echo "post-retrospective: body file is missing or empty: $body_file" >&2
  exit 2
fi
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
