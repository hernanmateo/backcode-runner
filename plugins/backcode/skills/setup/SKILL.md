---
name: setup
description: Set up the Backcode runner on this computer and connect a Backcode project so its tasks run on the user's own Claude Code. Use when the user says "set up Backcode", "install the Backcode runner", "connect my project to Backcode", "configura Backcode", "conecta mi proyecto", or runs /backcode:setup.
---

# Set up the Backcode runner

Backcode is a team backlog whose tasks are implemented by Claude Code on each member's own computer. The **runner** (this
repo, `backcode`) listens for the tasks the user accepts in the Backcode app, runs Claude Code on them in a sandboxed git
worktree and opens a draft pull request. Your job: get it installed, connected and running, with as little effort for the
user as possible.

Talk to the user in their language. Be brief: say what you're about to do, do it, report the result in one line.

## Rules

- **Never ask the user to paste the Backcode configuration in the chat**, and never print, `cat` or echo it: it contains their
  personal runner key. It goes from the clipboard straight to the runner (step 4).
- Never read the files in `~/.backcode/config/` (keys and tokens). `backcode status` tells you everything you need.
- No `sudo`. Ask before installing anything or changing login items, and show the exact command first.
- Steps that need the user's own interaction (signing in to GitHub in the browser, typing a Bitbucket token) are run by the
  user with the `!` prefix in this session, e.g. `! gh auth login --web`. Tell them exactly what to type.
- If something fails, read the error, explain it in plain words and fix it or offer the next best option. Don't loop on the
  same failing command.

## 1. This computer

1. `uname -s` and `uname -m`. Windows isn't supported (the runner needs the macOS or Linux sandbox): stop and say so.
2. Is the runner installed? `command -v backcode || ls ~/.backcode/bin/backcode`. If neither exists:
   - On macOS, offer the **Mac app** (easiest; it also opens a small panel in the browser):
     https://github.com/hernanmateo/backcode-runner/releases/latest/download/Backcode-Runner.dmg
     — or install the executable from here, without Node:
     `curl -fsSL https://raw.githubusercontent.com/hernanmateo/backcode-runner/main/install.sh | BACKCODE_NO_OPEN=1 sh`
   - On Linux, the `install.sh` command above.
   - If they prefer npm and have Node 22+: `npm install -g backcode`.
   Ask which one, run it (for `install.sh`, after the user agrees), then use `~/.backcode/bin/backcode` if `backcode` isn't in
   the PATH of this shell yet.
3. `backcode status` → read the **This computer** section and fix what isn't ✓:
   - **claude / login**: you are Claude Code, so this is normally fine. If it says "not signed in", ask the user to run `! claude`
     once in another terminal and sign in, or to paste an Anthropic API key in the runner panel (`backcode` opens it).
   - **git** missing: macOS → `xcode-select --install` opens Apple's installer window; wait for the user to finish it. Linux →
     the distro package (`sudo apt install git`): ask the user to run it themselves.
   - **gh** (only needed if their PRs go to GitHub): not installed → `brew install gh` if Homebrew exists; otherwise tell the
     user to press **Install GitHub CLI** in the runner panel (`backcode` opens it; it downloads the official binary, no admin
     rights). Not signed in → ask the user to run `! gh auth login --hostname github.com --git-protocol https --web` and follow
     the browser; then check `gh auth status`.

## 2. The Backcode app

Ask the user to open the Backcode app (iPhone or web) → their **project** → **Connect step by step**, choose where PRs go
(step 1), skip step 2 (you're doing it) and press **Copy configuration** in step 3. If they already have another project
connected on this computer, they should tick **I already have another project connected on this computer** first, so their
existing key is reused instead of revoked. On an iPhone with the same Apple ID, the copy reaches the Mac's clipboard.

Wait until they say it's copied.

## 3. Find or clone the repo

The runner finds the repo by itself if it's already cloned (it searches `~/Projects`, `~/Developer`, `~/Code`, `~/src`,
`~/GitHub`… two levels deep, matching the git remote). If the user mentions where their code is, use that with `--repo <path>`.
Otherwise use `--clone`: if it's not found, the runner clones it into `~/Backcode/<project>` (over https; for private GitHub
repos `gh` must be signed in first).

## 4. Connect

macOS:

```bash
pbpaste | backcode connect --clone --no-start
```

Linux: `xclip -o -selection clipboard` or `wl-paste` instead of `pbpaste`.

Read the output:
- `✓ Saved to …` → connected. Notes like "Repo found…" or "Cloned into…" tell you where the code is.
- "Unrecognized line" / "project is missing" → the clipboard doesn't hold the configuration: ask them to copy it again.
- "key isn't valid or was revoked" → they generated a newer key elsewhere: copy the configuration again (fresh key).
- "isn't a git repository" → ask where the code is and retry with `--repo <path>`.
- Clone failed → for GitHub, make sure `gh auth status` is OK; for Bitbucket, their git needs credentials.
- PRs on **Bitbucket**: the token can't be typed through you. Ask the user to run `! backcode connect` themselves and paste the
  configuration (⌘V + Enter); it will guide them through the API token. Or use the panel (`backcode`).

## 5. Keep it running

Offer to start it at login (no terminal needed afterwards; it also updates itself):

```bash
backcode service install
```

If they already used the Mac app, this is done. Then `backcode status`: the project should be listed and **Start at login** on.

## 6. Done

Tell the user: in the Backcode app the project should now say **Connected**; accept a small task and it'll come back as a draft
PR. `backcode` opens the panel (projects on/off, live activity). For problems later: `/backcode:doctor`.
