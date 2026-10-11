#!/usr/bin/env python3
"""Bound the checkout's MCP probe, including mise startup and server descendants."""

import os
from pathlib import Path
import signal
import subprocess
import sys


def stop_group(child, sig):
    try:
        os.killpg(child.pid, sig)
    except ProcessLookupError:
        pass


def main(timeout_seconds=50):
    helper = Path(__file__).with_suffix(".mjs")
    try:
        child = subprocess.Popen(
            ["mise", "exec", "--", "node", str(helper)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        print(f"corpus health check: cannot start mise: {error.strerror}", file=sys.stderr)
        return 1

    reason = None
    try:
        _, stderr = child.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        stop_group(child, signal.SIGTERM)
        try:
            child.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        reason = f"route or probe shutdown timed out after {timeout_seconds}s"
    finally:
        # The SDK owns its direct child; only this supervisor owns the entire
        # route's process group when a hung server outlives the CLI wrapper.
        stop_group(child, signal.SIGKILL)
        child.communicate()

    if reason is not None:
        print(f"corpus health check: {reason}", file=sys.stderr)
        return 1
    if child.returncode != 0:
        lines = stderr.decode("utf-8", errors="replace").splitlines()
        reason = next((line.strip() for line in reversed(lines) if line.strip()), "probe exited without a reason")
        print(f"corpus health check: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    sys.exit(main())
