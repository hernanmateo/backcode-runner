---
name: feature
description: Do a new feature or fix the Backcode way, in a repo connected to Backcode - its own git worktree and branch from the up-to-date main branch, then a pull request registered as a task on the Backcode board (review, merge and deploy from the app). Use when the user asks to build, add, change or fix something in a Backcode project, when a Backcode session-start note says the project follows these guidelines, or when they run /backcode:feature.
---

# A feature or fix, the Backcode way

Backcode projects can ask that work done with Claude Code outside Backcode follows the same rules as its tasks: **one
feature or fix = one worktree + one branch + one PR**, which then shows up on the team's Backcode board, where it's
reviewed, merged and deployed. The runner (`backcode`) does the git plumbing; you do the work in between.

Talk to the user in their language. Be brief.

## 0. Is this repo connected?

Find the runner: `command -v backcode || ls ~/.backcode/bin/backcode` (use whichever exists as `backcode` below).
If there's none, or `backcode task start` says the repo isn't connected, explain it in one line and offer
`/backcode:setup`. Don't fall back to committing on the main branch.

If you are **already in a worktree on a `backcode/…` branch** (`git branch --show-current`), this is the continuation of
that work: skip to step 2 and keep everything there.

## 1. Start: worktree and branch

1. One topic per branch. If the request mixes unrelated things, say so and do them one at a time (one PR each).
2. Run `backcode task start "<short title>" --json` from the repo. It fetches the remote, creates a worktree from
   `<remote>/<base>` on a branch `backcode/<handle>/<id>`, copies the local `.env` files, and prints
   `{ "path", "branch", "base", "featureId" }`.
3. Work **only inside that `path`** from now on: `cd` into it for every command, and read/edit files with that absolute
   path. The original checkout stays as it was. If the project needs its dependencies installed, install them there.

## 2. Do the work

- Focused, minimal changes that follow the repo's conventions (its CLAUDE.md and existing code). No unrelated refactors.
- Run the project's tests, linter and type checker for what you touched, and fix what broke. Add tests when the repo
  has a test suite.
- Never commit secrets, credentials or `.env` files.
- Commit in the worktree with clear messages (`git add -A && git commit -m "…"` inside `path`). Committing there is fine:
  it's the task branch, not the main branch.

## 3. Open the PR (registered in Backcode)

1. Write the PR body to a temporary file (not inside the worktree), in the user's language, with these sections:
   **Summary**, **Changes**, **How it was tested**, **Risks / follow-ups**. If something must be done by hand after
   merging (deploy rules or functions, a migration, an env var…), list each step with why and the exact command. Never
   run deploys yourself.
2. From the worktree: `backcode task pr --title "<imperative title>" --body-file <file> --json`.
   It checks there are no uncommitted changes and no secrets, pushes the branch, opens (or updates) the PR and registers
   it on the Backcode board as a task in "PR ready", under the user's name. It prints `{ "prUrl" }`.
3. If it fails, read the message, fix the cause (commit pending changes, remove a secret…) and run it again.
4. Tell the user the PR link and that it's on the Backcode board, where it's reviewed, merged and deployed.

## Later changes

To change the same PR (review comments, a follow-up): go back to that worktree, commit, and run `backcode task pr` again
with the same or a better title. It updates the same PR and task. A different topic is a new `backcode task start`.

## Rules

- Never commit or push directly to the main branch for this work. If the project requires it, a direct commit or push
  there asks the user first; don't try to get around it.
- Don't read `~/.backcode/config/` (it holds keys and tokens); `backcode` does everything that needs them.
- Don't delete the worktree when you finish: the user may need it for changes. The runner cleans old ones up.
