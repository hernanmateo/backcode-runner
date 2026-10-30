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
- Never print environment variables that hold secrets (`SUPABASE_DB_PASSWORD`, tokens, keys): only check whether they're set,
  e.g. `[ -n "$SUPABASE_DB_PASSWORD" ] && echo set || echo missing`.
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

## 6. Ready to work

Leave the project 100 % ready. Do each step only if it applies, and explain it to the user in one line. Run the commands from
the repo (the path `backcode connect` reported). These commands need runner 1.0.48 or newer: if one says "Unknown command",
the runner is older — the service and the Mac app update themselves within the hour; with npm, `npm install -g backcode@latest`.
Skip that step and mention it in the summary.

### 6.1 Deploy tool sessions

`backcode deploys --json` lists the project's deploys on its main branch: `[{ id, name, dir, provider, source }]` (no secrets).
If it says the repo isn't connected, the runner hasn't registered the project yet: check `backcode status` and try again.
For each distinct `provider`, check the session **without changing anything** (run from the deploy's `dir`):

- `wrangler` (Cloudflare): `npx --yes wrangler whoami`.
- `supabase`: `npx --yes supabase projects list`, and that `supabase/.temp/project-ref` exists in that folder (if not:
  `npx supabase link --project-ref <ref>`). If there's a `supabase-db` deploy (migrations), check that
  `SUPABASE_DB_PASSWORD` is set in the shell — only whether it's set, never its value.
- `firebase`: `npx --yes firebase-tools login:list`.

A missing session is a browser login: don't do it for the user. Tell them the exact command to run with `!`, e.g.
`! npx wrangler login`, `! npx supabase login`, `! npx firebase-tools login`, and check again afterwards. No deploys, or none
with a provider: skip this step.

### 6.2 The plugin, on for the whole team

If the repo's `.claude/settings.json` doesn't have `"enabledPlugins": { "backcode@backcode": true }`, offer to add it so
everyone who opens the repo in Claude Code gets the plugin (and the Backcode guidelines). Add the marketplace too, so Claude
Code offers to install it to whoever doesn't have it yet:
`"extraKnownMarketplaces": { "backcode": { "source": { "source": "github", "repo": "hernanmateo/backcode-runner" } } }`. Do it **in a PR, the Backcode way**,
never with a commit to the main branch:

1. `backcode task start "Activar el plugin de Backcode en el repo"` (in the user's language) → it prints the worktree path.
2. In that worktree, create or update `.claude/settings.json`: if it already exists, merge both keys into it without touching
   anything else (keep the other keys, marketplaces and `enabledPlugins` entries).
3. Commit it there and run `backcode task pr --title "<same title>" --body "<one line: why>"`.

Tell the user the PR is on the board, ready to review and merge from the app.

### 6.3 Keep this computer awake

Ask: "Do you want this computer to keep picking up tasks while you're not using it? **No** / **Plugged in** (recommended on
laptops) / **Always**". Apply it with `backcode awake off`, `backcode awake plugged` or `backcode awake always` (`backcode awake`
alone shows the current mode, from the panel and from the app). Mention the limit: with the lid closed and no external
display, a Mac sleeps anyway.

### 6.4 Project guidelines

Run `echo '{"cwd":"<repo>"}' | backcode hook session-start`. If it prints JSON with the guidelines (`additionalContext`), the
project has them on: explain in two lines that every change goes through `/backcode:feature` (its own worktree, and a PR
registered on the board) and, if the text says "The project requires this", that a direct commit or push to the main branch
asks for confirmation (`require` mode). Nothing printed: guidelines are off (an admin can turn them on in the app, Edit
project), or the runner hasn't started for this project yet (it writes them when it starts: check `backcode status`).

## 7. Done

Show a short checklist with ✓ / ✗, and for every ✗ the exact command or step that fixes it:

- Runner installed and starting at login
- Project connected
- GitHub / Bitbucket access
- Deploy tool sessions (one line per provider)
- Plugin on in the repo (or its PR)
- Keep awake
- Guidelines

Then: in the Backcode app the project should now say **Connected**; accept a small task and it'll come back as a draft PR.
`backcode` opens the panel (projects on/off, live activity). For problems later: `/backcode:doctor`. When they work in this
repo with Claude Code directly, `/backcode:feature` does each feature or fix the Backcode way.
