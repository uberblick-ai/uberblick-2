#!/bin/sh
# Keep setup's arguments out of the nested installation commands. A workspace
# or secret is created only by an explicit CLI command after installation.
set -eu
if [ "$#" -ne 0 ]; then
  printf 'setup takes no arguments; run mise run setup, then ub auth login.\n' >&2
  exit 2
fi

mise install
# Re-resolve tool paths after installing the pinned toolchain.
mise run install
printf 'Toolchain and dependencies installed. Run `ub auth login` to sign in to the committed workspace.\n'
