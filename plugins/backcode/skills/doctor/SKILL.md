---
name: doctor
description: Diagnose and fix problems with the Backcode runner on this computer (a project stuck "retrying" or "stopped", tasks not starting, PRs not opening, the panel not opening, updates), and check whether the repo has CI (offering to create it). Use when the user says "Backcode isn't working", "my runner is offline", "la tarea no arranca", "el runner no conecta", or runs /backcode:doctor.
---

# Backcode doctor

Find out why the Backcode runner isn't doing its job and fix it. Talk to the user in their language; be brief and concrete.

Same rules as `/backcode:setup`: never print or read the files in `~/.backcode/config/` (they hold keys and tokens), never
ask for the configuration in the chat, no `sudo`, and ask before changing anything.

## Look

1. `backcode status` (or `~/.backcode/bin/backcode status`): version, whether it starts at login, whether the panel is up,
   what's missing on this computer and which projects are connected.
2. Service log (when it runs at login): `tail -n 80 ~/.backcode/logs/service.log`.
   macOS: `launchctl print gui/$(id -u)/com.backcode.runner | head -20`. Linux: `systemctl --user status backcode-runner`.
3. Running by hand? `ps -Ao pid,command | grep -E "backcode|dist/(cli|index|all)\.js" | grep -v grep`.
4. **CI** (only when you're in a project's repo): does its main branch have CI? See [CI](#ci) below.

## CI

Backcode only merges a PR and deploys when its checks are green; with no CI there's nothing to check, so it merges and
deploys **without testing anything** (the app shows a «No CI» badge). Backcode tasks can't add CI themselves (for safety
they can't touch it), so this is where to do it. Check it without changing anything:

1. Main branch: `git remote` (usually `origin`) and `git symbolic-ref --short refs/remotes/<remote>/HEAD` (e.g.
   `origin/main`; if it fails, `main` or `master`). `git fetch <remote> --quiet` first if you can.
2. CI files on it: `git ls-tree -r --name-only <remote>/<base> | grep -E '^(\.github/workflows/[^/]+\.ya?ml|bitbucket-pipelines\.yml|\.gitlab-ci\.yml|\.circleci/config\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|\.buildkite/|\.woodpecker(\.ya?ml|/)|\.drone\.ya?ml)'`
   (the same list the runner uses). Any match → CI ✓.
3. No file: CI can also come from an integration without a file (Vercel, Netlify, a GitHub App…). On GitHub, if `gh` is
   signed in: `gh api repos/{owner}/{repo}/commits/$(git rev-parse <remote>/<base>)/check-runs --jq .total_count` and
   `gh api repos/{owner}/{repo}/commits/$(git rev-parse <remote>/<base>)/status --jq '.statuses | length'`. Anything above 0
   → CI ✓ (checks without a file). Other hosts, or `gh` not available: go by the files.

Report it as one line: ✓ «CI: GitHub Actions (`.github/workflows/ci.yml`)» or, if there's none, a **warning, not an
error** (the runner works fine without it): «No CI: Backcode will merge and deploy without checking anything». Then offer
to create it: if they accept, follow step **6.3 CI** of `/backcode:setup` (CI fitted to the project's real commands, in its
own PR, never on the main branch).

## Common causes

| What you see | Cause | Fix |
|---|---|---|
| "You already have a runner active for this project (host:pid)" | Another runner for the same project: an old `npm run all`, a second terminal, the service plus a terminal | Stop the extra one (Ctrl+C in its terminal; never kill processes without asking). One runner per project. |
| "key isn't valid or was revoked" | A newer key was generated (it revokes the old one) | In the app: Connect → Set up again → Copy configuration, then `pbpaste \| backcode connect --no-start` |
| Project "retrying" right after login | No network yet when the runner started | It retries by itself; if it still fails after a few minutes, read the log |
| PRs not opening (GitHub) | `gh` not installed or signed out | `gh auth status`; sign in with `! gh auth login --hostname github.com --git-protocol https --web` |
| PRs not opening (Bitbucket) | Token expired or missing a scope | `! backcode connect` and paste the configuration again: it checks and asks for a new token |
| "isn't a git repository" / repo moved | The configured folder changed | `pbpaste \| backcode connect --repo <new path> --no-start` with a fresh configuration |
| Claude Code errors / "not signed in" | Claude Code signed out | Ask the user to run `! claude` and sign in, or use an API key in the panel |
| Panel doesn't open | Nothing listening on 127.0.0.1:47474, or another program on that port | `backcode` starts it; `BACKCODE_PANEL_PORT=47475 backcode` for another port |
| Stuck on an old version | Updates fail (no network, a git copy with local changes) | The log says why; reinstall with the Mac app or `install.sh` |
| Guidelines or `/backcode:feature` not working, or `backcode status` says the plugin has a new version | The Claude Code plugin is missing or old: Claude Code doesn't update this marketplace by itself | `! claude plugin marketplace update backcode` and `! claude plugin update backcode@backcode` (or **Update the plugin** in the panel), then restart Claude Code. To keep it current: /plugin › Marketplaces › backcode › enable auto-update |
| Guidelines not showing in a repo | An admin set the project to **Free** (off) in the app (the default is **Remind**), or this computer's runner isn't connected to that project | An admin sets **Remind** in the app (Edit project); connect the runner to the project. Then a new Claude Code session |
| «No CI» badge in the app, PRs merged with no checks | The repo's main branch has no CI | See [CI](#ci): offer to create it in its own PR |

When it's fixed, run `backcode status` again and tell the user what was wrong and what you changed, in one or two lines,
plus the CI line.
