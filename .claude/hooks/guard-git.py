#!/usr/bin/env python3
"""PreToolUse guard for Bash commands.

The repository's real protection against publishing private content is the
pre-push hook in .githooks/. That hook can be sidestepped with --no-verify or by
repointing core.hooksPath, so this refuses to run a command that would do
either. Exit status 2 blocks the tool call and returns stderr to the model.
"""

import json
import re
import sys

QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")

# (pattern, reason, ignore_quoted). Rules run against the raw command by
# default, so a bypass hidden inside `sh -c "..."` is still seen. The bare -n
# rule is the exception: it must ignore quoted text, or a commit message that
# happens to contain "-n" would block the commit.
RULES = [
    (
        re.compile(r"\bgit\b[^;&|]*\b(push|commit|merge|rebase)\b[^;&|]*--no-verify"),
        "--no-verify skips the pre-push/pre-commit guards that keep private "
        "content off the public remote. Run the command without it; if a guard "
        "fires, that is the guard working, so fix what it reports instead.",
        False,
    ),
    (
        re.compile(r"\bgit\b[^;&|]*\bcommit\b[^;&|]*(?<![\w-])-n(?![\w-])"),
        "git commit -n is --no-verify and skips the pre-commit guard. Commit "
        "without it.",
        True,
    ),
    (
        # Setting it to .githooks is how the guard gets installed, and a bare
        # read has no value at all; anything else points it away from the hooks.
        # The value character class excludes shell operators, or `git config
        # core.hooksPath && echo` would read as "set it to &&".
        re.compile(
            r"\bgit\b[^;&|]*\bconfig\b[^;&|]*"
            r"(--unset[^;&|]*core\.hooksPath|core\.hooksPath\s+(?!['\"]?\.githooks\b)[^\s;&|<>])"
        ),
        "Pointing core.hooksPath anywhere other than .githooks disables the "
        "guards that keep private content off the public remote.",
        False,
    ),
    (
        re.compile(
            r"\bgit\b[^;&|]*\bconfig\b[^;&|]*(--unset|--replace-all)[^;&|]*trustedremoteurl"
        ),
        "Editing citationgraph.trustedremoteurl changes which remotes may "
        "receive private content. Ask the user to make that change.",
        False,
    ),
    (
        re.compile(r"\bHUSKY\s*=\s*0\b|\bGIT_CONFIG_COUNT\s*="),
        "This disables git hooks for the command. Run it without the override.",
        False,
    ),
]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError as exc:
        # Fail open rather than blocking every Bash call, but say so: a guard
        # that stops working silently is worse than no guard at all.
        sys.stderr.write(
            f"guard-git.py: could not parse hook payload ({exc}); not checking.\n"
        )
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command.strip():
        return 0

    unquoted = QUOTED.sub(" ", command)
    for pattern, reason, ignore_quoted in RULES:
        if pattern.search(unquoted if ignore_quoted else command):
            sys.stderr.write("Blocked: " + reason + "\n")
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
