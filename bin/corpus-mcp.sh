#!/bin/sh
# Install this reviewed launcher at ~/.local/bin/uberblick-corpus-mcp. It keeps
# the existing corpus installation independent of source-checkout updates.
set -eu

check=false
case $#:$* in
  0:) ;;
  1:--check) check=true ;;
  *) printf '%s\n' 'usage: uberblick-corpus-mcp [--check]' >&2; exit 2 ;;
esac

# The existing operator revision has current corpus interfaces and protocol 1.
# Older published clients omit decision authority fields and tools.
required_version=0.2.0-corpus.b574609
client=${UB_CORPUS_CLIENT:-"$HOME/.local/share/uberblick-corpus-clients/b574609cd5d8456a3e11ba10e3d6eeaaf1770d82/bin/ub"}

case $client in
  /*) ;;
  *) printf '%s\n' 'corpus MCP: UB_CORPUS_CLIENT must be an absolute installed client path' >&2; exit 1 ;;
esac
if [ ! -f "$client" ] || [ ! -x "$client" ]; then
  printf '%s\n' 'corpus MCP: installed client is missing; install the reviewed b574609 corpus client snapshot' >&2
  exit 1
fi
if ! version=$("$client" --version); then
  printf '%s\n' 'corpus MCP: could not verify the installed client version' >&2
  exit 1
fi
if [ "$version" != "$required_version" ]; then
  printf '%s\n' 'corpus MCP: requires installed corpus client 0.2.0-corpus.b574609; refusing to start a different version' >&2
  exit 1
fi

if [ "$check" = true ]; then
  printf 'client %s\nversion %s\n' "$client" "$version"
  exit 0
fi
exec "$client" mcp serve
