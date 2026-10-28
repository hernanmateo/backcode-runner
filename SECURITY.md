# Security policy

Backcode Runner runs Claude Code on your computer, on tasks written by other people, with access to your repositories. We take
reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/hernanmateo/backcode-runner/security/advisories/new).

Include what you found, how to reproduce it and the impact you see. We'll acknowledge it within a few days and keep you updated
until it's fixed. Please give us reasonable time to release a fix before disclosing it.

## Supported versions

Only the latest published version of `@backcode/runner` receives security fixes. Installed runners update themselves.

## Scope

Especially relevant: escaping the sandbox or the task's worktree, reading the runner's configuration or keys from a task, getting
the runner to push or run commands outside the allowlist, and reaching the local panel from another user or a website.
