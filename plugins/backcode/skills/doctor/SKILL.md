---
name: doctor
description: Diagnose and fix problems with the Backcode runner on this computer (a project stuck "retrying" or "stopped", tasks not starting, PRs not opening, the panel not opening, updates). Use when the user says "Backcode isn't working", "my runner is offline", "la tarea no arranca", "el runner no conecta", or runs /backcode:doctor.
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

When it's fixed, run `backcode status` again and tell the user what was wrong and what you changed, in one or two lines.
