#!/bin/sh
# Checkout compatibility for installed clients and an updater crossing the move.
# Removed with remote-update.sh and the checkout commands in #1170.
exec sh "$(dirname -- "$0")/bin/remote-compose.sh" "$@"
