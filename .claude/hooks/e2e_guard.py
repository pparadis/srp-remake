#!/usr/bin/env python3
"""PreToolUse hook: refuse a full e2e run, the CI shards or repeat loops (AGENTS.md, Verification)."""
import json
import os
import re
import shlex
import sys

WRAPPERS = {'npx', 'env', 'time', 'nice', 'command', 'exec'}
SEPARATOR = re.compile(r'^[;&|()<>]+$')
ENV_ASSIGNMENT = re.compile(r'^\w+=')


def segments(command):
    # shortcut: `bash -c "..."` and `npm --prefix . run` are not seen, add them if an agent ever goes that way.
    lexer = shlex.shlex(command.replace('\n', ' ; '), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ''
    words = []
    for token in lexer:
        if SEPARATOR.match(token):
            yield words
            words = []
        else:
            words.append(token)
    yield words


def refusal(words):
    while words:
        if ENV_ASSIGNMENT.match(words[0]) or words[0] in WRAPPERS:
            words = words[1:]
        elif words[0] == 'timeout':
            words = words[2:]
        else:
            break
    if not words:
        return None
    if os.path.basename(words[0]) == 'playwright' and words[1:2] == ['test']:
        args = words[2:]
    elif words[:3] == ['npm', 'run', 'test:e2e']:
        args = words[3:]
    else:
        return None
    if any(a in ('--list', '--help', '-h') for a in args):
        return None
    if any(a.startswith(('--shard', '--repeat-each')) for a in args):
        return 'The CI shards and repeat loops are not run locally.'
    if not any('.spec' in a for a in args):
        return 'Name the spec the change touches (e2e/track.spec.ts): the full suite is not run locally.'
    return None


def check(command):
    try:
        return next(filter(None, map(refusal, segments(command))), None)
    except ValueError:
        # shortcut: an unbalanced quote (a heredoc body, say) is let through rather than blocking the command.
        return None


def self_test():
    for command in (
        'npx playwright test',
        'npm run test:e2e',
        'npm run test:e2e -- --shard=1/2',
        'E2E_PORT=5399 npx playwright test --workers=2',
        'npx playwright test e2e/',
        'npx playwright test e2e/track.spec.ts --repeat-each=5',
        'npm test && timeout 60 npx playwright test',
        '(cd e2e; playwright test)',
    ):
        assert check(command), command
    for command in (
        'GITHUB_ACTIONS=true E2E_PORT=5399 npx playwright test e2e/track.spec.ts --workers=2',
        'npm run test:e2e -- e2e/hud.spec.ts:12',
        'npx playwright test --list',
        'npx playwright install',
        'git commit -m "npx playwright test"',
        'grep -n "playwright test" AGENTS.md',
        "echo don't",
        'npm test',
    ):
        assert not check(command), command
    print('ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
        sys.exit(0)
    reason = check(json.load(sys.stdin).get('tool_input', {}).get('command', ''))
    if reason:
        print(reason, file=sys.stderr)
        sys.exit(2)
