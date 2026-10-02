#!/usr/bin/env python3
"""Best-effort cleanup before ub-agents removes a private worktree.

Only current-user temp entries named for this run and its Claude task directory
are eligible. Use directory descriptors so symlinks cannot redirect traversal,
including within scratch. Failures are logged but never keep the worktree.
"""

import os
import re
import stat
import sys
import tempfile


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def report(path, error):
    print(f"agent cleanup: {path}: {error}", file=sys.stderr)


def open_directory(path):
    """Open an absolute directory without following any path component's link."""
    if not os.path.isabs(path):
        raise ValueError("expected an absolute directory")
    fd = os.open("/", DIRECTORY_FLAGS)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("unexpected relative path component")
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def remove_entry(parent, name, path, uid):
    try:
        entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if entry.st_uid != uid:
            return
        if stat.S_ISDIR(entry.st_mode):
            fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
                    raise OSError("directory changed during cleanup")
                for child in os.listdir(fd):
                    remove_entry(fd, child, os.path.join(path, child), uid)
            finally:
                os.close(fd)
            os.rmdir(name, dir_fd=parent)
        else:
            os.unlink(name, dir_fd=parent)
    except FileNotFoundError:
        pass  # Already cleaned, including on a retry.
    except OSError as error:
        report(path, error)


def cleanup():
    run = os.environ.get("UB_AGENT_RUN", "")
    if re.fullmatch(r"[0-9a-f]{32}", run) is None:
        return
    uid = os.getuid()
    temp = tempfile.gettempdir()
    fd = open_directory(temp)
    try:
        for name in os.listdir(fd):
            if run in name:
                remove_entry(fd, name, os.path.join(temp, name), uid)

        # The hook runs from the operator's configuration checkout. An exact
        # match also excludes other runs, shared checkouts and traversal aliases.
        worktree = os.path.join(os.getcwd(), ".ub-agent", "worktrees", run)
        if os.environ.get("UB_AGENT_WORKTREE") != worktree:
            return
        worktree_fd = open_directory(worktree)
        os.close(worktree_fd)
        tasks = f"claude-{uid}"
        try:
            entry = os.stat(tasks, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if entry.st_uid != uid:
            return
        tasks_fd = os.open(tasks, DIRECTORY_FLAGS, dir_fd=fd)
        try:
            opened = os.fstat(tasks_fd)
            if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
                raise OSError("Claude task parent changed during cleanup")
            slug = re.sub(r"[^a-zA-Z0-9]", "-", worktree)
            remove_entry(tasks_fd, slug, os.path.join(temp, tasks, slug), uid)
        finally:
            os.close(tasks_fd)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        cleanup()
    except Exception as error:
        report("cleanup", error)
    sys.exit(0)
