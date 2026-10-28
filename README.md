<p align="center">
  <img src="docs/logo.svg" alt="Backcode" width="112" height="112">
</p>

<h1 align="center">Backcode Runner</h1>

<p align="center">
  <strong>Your team's backlog, implemented by Claude Code, on your own machine.</strong><br>
  The local runner for <a href="#what-is-backcode">Backcode</a>: it picks up the tasks you accept in the app, has Claude Code build them on their own branch and opens a draft pull request.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@backcode/runner"><img alt="npm version" src="https://img.shields.io/npm/v/@backcode/runner?style=flat-square&color=C96442&label=npm"></a>
  <a href="https://www.npmjs.com/package/@backcode/runner"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@backcode/runner?style=flat-square&color=C96442"></a>
  <a href="https://github.com/hernanmateo/backcode-runner/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hernanmateo/backcode-runner/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1F1E1D?style=flat-square"></a>
  <a href="https://github.com/hernanmateo/backcode-runner/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/hernanmateo/backcode-runner?style=flat-square&color=C96442&label=release"></a>
  <img alt="No Node required" src="https://img.shields.io/badge/Node-not%20required-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-1F1E1D?style=flat-square&logo=apple&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <a href="https://docs.claude.com/claude-code"><img alt="Powered by Claude Code" src="https://img.shields.io/badge/powered%20by-Claude%20Code-D97757?style=flat-square&logo=claude&logoColor=white"></a>
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-248A3D?style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#the-panel">The panel</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.es.md">Leer en español</a>
</p>

<br>

<p align="center">
  <img src="docs/panel.png" alt="The Backcode Runner panel: machine checks and connected projects" width="640">
</p>

## Quick start

### macOS

<p>
  <a href="https://github.com/hernanmateo/backcode-runner/releases/latest/download/Backcode-Runner.dmg"><img alt="Download for Mac" src="https://img.shields.io/badge/Download_for_Mac-Apple_Silicon_%26_Intel-1F1E1D?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

Open the `.dmg`, drag **Backcode Runner** to Applications and open it. No Terminal, no Node: it installs the runner, sets it to
start at login and opens its panel in your browser. Opening the app again just opens the panel.

### Linux (or the Terminal on a Mac)

```bash
curl -fsSL https://raw.githubusercontent.com/hernanmateo/backcode-runner/main/install.sh | sh
```

It installs a single executable in `~/.backcode/bin` (**no Node required**), verifies its checksum and opens the same panel.

### Then

The panel opens in your browser. The panel checks your computer and **guides you through anything missing**, step by step, with buttons that do it
for you: install Claude Code, sign in to Claude or GitHub, install git or GitHub CLI. Then paste the configuration you copy in
the Backcode app (**Project → Connect step by step → Copy configuration**) and turn on *Start at login*. Next time, just run `backcode`.

**Already use Node?** Same runner, from npm:

```bash
npx @backcode/runner
```

**You need:** macOS or Linux · [Claude Code](https://docs.claude.com/claude-code) signed in · `git` with push access to your repo ·
for PRs, [GitHub CLI](https://cli.github.com) signed in or a Bitbucket API token. The panel helps you with all of them.

## What is Backcode?

Backcode is a backlog for teams that build with Claude Code. Anyone on the team proposes ideas from their phone, typed,
dictated or with screenshots and PDFs. An AI turns each one into a clear brief using a map of your codebase, flags security
risks and suggests a model. Whoever accepts a task runs it **on their own Claude Code, on their own computer**, and gets a
**draft pull request**.

This repository is the part that runs on your computer. It's open source so you can read exactly what it does with your code.

<p align="center">
  <img src="docs/app-mobile.png" alt="The Backcode app on iPhone: propose an idea, follow the board, watch Claude work live" width="820">
</p>

<p align="center">
  <img src="docs/web-board.png" alt="The Backcode board on the web: Backlog, Queued, Claude working, Need a reply, PR ready, Merged, Deployed" width="820">
  <br><sub>The same app on iPhone and on the web. Screenshots from a demo project.</sub>
</p>

## How it works

<p align="center">
  <img src="docs/how-it-works.svg" alt="1. Propose in the app · 2. AI refines it and a teammate accepts · 3. The runner has Claude Code implement it in a sandbox · 4. Draft PR on GitHub or Bitbucket" width="880">
</p>

For every task you accept, the runner:

1. **Claims it** and checks that it's yours, that you're still in the group and that the brief hasn't changed since you accepted it.
2. **Creates an isolated worktree** on its own branch (`backcode/<you>/<task>`) from the latest base branch. Your working copy is never touched.
3. **Runs Claude Code** with the brief and its attachments, sandboxed to that worktree. If something essential is unclear, Claude
   **asks in the task thread** and the same session continues with your answer. With **plan mode**, it first proposes a plan
   (read-only) that you refine and approve.
4. **Reviews the result** (protected paths, secrets in the diff), commits, pushes and opens a **draft PR**. Claude never pushes.
5. **Reports live** to the app: what Claude says, the commands it runs, the files it touches, cost and tokens.

It also handles what an admin asks for from the app, always with your own credentials: merge a PR once checks are green,
publish an **Expo OTA update** (after a boot test in a simulator), build for TestFlight / Internal Testing, or run a deploy script.

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Zero-terminal setup</h4>
      A local panel with machine checks, paste-to-connect, per-project switches, live activity and <em>Start at login</em>.
    </td>
    <td width="50%" valign="top">
      <h4>Your subscription, your machine</h4>
      Uses the Claude Code you're already signed into (Pro or Max included). Your code only leaves through the PR.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Sandboxed by default</h4>
      OS sandbox, worktree-only writes, network allowlist, no secrets in the environment, guarded commands and protected paths.
    </td>
    <td valign="top">
      <h4>Conversations, not one-shots</h4>
      Claude asks in the task thread, you answer from your phone, the same session continues and the same PR updates.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>GitHub and Bitbucket</h4>
      Draft PRs with <code>gh</code> or a Bitbucket API token, or just push the branch. Detects merges and conflicts with main.
    </td>
    <td valign="top">
      <h4>New projects from an idea</h4>
      Describe a project in the app: your runner creates the folder and the GitHub or Bitbucket repo with your credentials, connects it and builds the first task as a draft PR.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Ship from the app</h4>
      Merge with green checks, Expo OTA (EAS Update or your own script) with a boot test, store builds and monorepo deploys.
    </td>
    <td valign="top">
      <h4>Always up to date</h4>
      Installs new versions by itself (verified with SHA-256) and restarts each runner only when it's idle. A task in progress is never interrupted.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Speaks your language</h4>
      Panel, terminal and Claude's messages in English, Spanish or Catalan, following your profile in the app.
    </td>
    <td valign="top"></td>
  </tr>
</table>

## The panel

Run `npx @backcode/runner` and it opens at `http://127.0.0.1:47474`:

| Section | What you can do |
|---|---|
| **This computer** | See whether Claude Code and its session, git and GitHub CLI are ready. Anything missing opens a step-by-step guide with a button that fixes it (official Claude Code installer, sign-in in the Terminal, Xcode tools, Homebrew) and the command if you'd rather do it yourself. |
| **Projects** | Turn each project on or off (remembered across restarts), restart it, watch its live activity or remove it. |
| **Connect a project** | Paste the configuration from the app. It validates your key, offers to clone the repo if it's missing and asks for a Bitbucket token when needed. |
| **Accounts** | See your `gh` sign-in and add, check or change your Bitbucket API token, used for every project and to create new repos from the app (add the `admin:repository:bitbucket` scope for that). |
| **Start at login** | Installs the runner as a user service (launchd on macOS, `systemd --user` on Linux): no terminal, restarts if it crashes, updates itself. |

Coming from the old `git clone` setup? The panel finds those projects and offers to import them.

## Command line

Everything in the panel also works from the terminal. `install.sh` puts `backcode` in your `PATH`; with npm, use `npx @backcode/runner <command>` or `npm i -g @backcode/runner`:

| Command | Description |
|---|---|
| `backcode` | Open the panel (or just open the browser if it's already running, e.g. as a service). |
| `backcode connect` | Connect a project by pasting the configuration from the app. |
| `backcode start [project…]` | Run all projects (or the given ones) in this terminal, with prefixed logs. |
| `backcode service install` · `uninstall` · `status` | Start at login, same as the switch in the panel. |
| `backcode --version` | Print the installed version. |

## Security

Task briefs are written by other members of your group, so the runner treats them as **untrusted input**.

| Layer | Measure |
|---|---|
| **Identity** | A personal runner key authenticates you and is bound by Firestore Security Rules: it can only move tasks you accepted. A new key revokes the old one. |
| **Secrets** | Configuration lives in `~/.backcode/config` (700/600; the runner refuses to start if others can read it). `BACKCODE_*` variables are removed from the environment before Claude starts. |
| **Filesystem** | Claude only reads and writes inside the task's worktree. Commands run in the OS sandbox and can't read the runner, its config, `~/.ssh`, `~/.aws`, `~/.config/gh`… |
| **Network** | Commands can only reach an allowlist (`registry.npmjs.org` by default). No WebFetch or WebSearch. |
| **Tools** | `dontAsk` mode denies anything not explicitly allowed; a hook also blocks `git push`, `gh`, `curl`, `ssh`, `sudo`… |
| **Repository** | The repo's `.claude/` settings and hooks are not loaded. CI, `.claude/`, `.mcp.json`, `CLAUDE.md`, `.env*` and keys are protected paths. |
| **Publishing** | The runner, not Claude, pushes (without git hooks) and the PR is always a **draft**. Merges and OTAs only happen when an admin asks and checks are green. |
| **Panel** | Listens on `127.0.0.1` only, requires a per-user token and rejects foreign `Host`/`Origin` headers, so other users and websites can't use it. It never returns keys or tokens. |

Protect your base branch (required reviews) and review every PR as if it came from a stranger.
Found a vulnerability? Please report it privately, see [SECURITY.md](SECURITY.md).

## Where things live

| Path | Contents |
|---|---|
| `~/.backcode/config/<project>.env` | Each project's configuration, including your runner key. |
| `~/.backcode/config/credentials` | Account credentials shared by all projects (your Bitbucket API token), editable in the panel's **Accounts** section. A project's own `.env` value wins. |
| `~/.backcode/worktrees/<project>/<task>` | Working copies for each task (cleaned up after 14 days unused). |
| `~/.backcode/bin/backcode` | The executable installed by `install.sh`, updated in place from GitHub Releases. |
| `~/.backcode/app` | With npm: the runner's own install, used by the service and updated without admin rights. |
| `~/.backcode/logs/service.log` | Service output. |

Set `BACKCODE_HOME` to use another root and `BACKCODE_PANEL_PORT` to use another port.

## FAQ

<details>
<summary><strong>Does it cost extra?</strong></summary>
<br>
No. The runner uses your own Claude Code, so with a Pro or Max plan tasks come out of your plan's usage. With an API key, you
pay Anthropic directly. The app shows the cost and tokens of every task.
</details>

<details>
<summary><strong>Does my code go to Backcode's servers?</strong></summary>
<br>
No. Claude Code runs on your computer and the code stays there. What reaches Backcode is the activity you see in the app
(messages, commands, file names, the plan), usage figures and a short map of the repository (stack, structure, commands)
that helps the AI write better briefs. You can turn the map off with <code>BACKCODE_KNOWLEDGE=off</code>.
</details>

<details>
<summary><strong>Can someone run code on my computer without my consent?</strong></summary>
<br>
Only tasks assigned to you run, and only after you accept them. An admin can also start one directly on your Claude Code
(“Decretazos”, on by default), and you can turn that off in your profile. Either way, the brief is treated as untrusted
and everything above applies.
</details>

<details>
<summary><strong>Will my Mac fall asleep in the middle of a task?</strong></summary>
<br>
No. While a task, an action (merge, OTA, build…) or a refinement is running, the runner prevents idle sleep (<code>caffeinate</code>
on macOS, <code>systemd-inhibit</code> on Linux) and releases it when done. Set <code>BACKCODE_KEEP_AWAKE=always</code> in a project's
configuration to stay awake while the runner is open, so it picks up tasks right away even when you're away, or <code>off</code> to
never prevent sleep. Closing a laptop's lid on battery still puts it to sleep.
</details>

<details>
<summary><strong>What if the computer shuts down or the runner crashes mid-task?</strong></summary>
<br>
The Claude session is saved as soon as it starts and the runner renews a heartbeat on the task. If it stops, the app marks the
task as <em>Stopped</em> and sends a push notification to the assignee and the admins (once per crash). It can then be retried
(the runner resumes it where it left off), released or discarded.
</details>

<details>
<summary><strong>What does the Mac app do exactly?</strong></summary>
<br>
<em>Backcode Runner.app</em> is the same executable (universal: Apple Silicon and Intel), signed and notarized by Apple. When you open
it, it copies itself to <code>~/.backcode/bin/backcode</code> (so the signed app is never modified and updates go to that copy),
installs the runner as a login item (a LaunchAgent in <code>~/Library/LaunchAgents</code>), opens the panel and quits. It has no
Dock icon: the runner keeps working in the background. To remove it, turn off <em>Start at login</em> in the panel and delete
the app and <code>~/.backcode</code>.
</details>

<details>
<summary><strong>What does install.sh do exactly?</strong></summary>
<br>
It detects your OS and CPU, downloads <code>backcode-&lt;os&gt;-&lt;arch&gt;</code> from the latest
<a href="https://github.com/hernanmateo/backcode-runner/releases/latest">GitHub Release</a>, checks it against
<code>SHA256SUMS</code>, installs it in <code>~/.backcode/bin</code>, adds that folder to your <code>PATH</code> (one line in your
shell profile) and opens the panel. No admin rights, nothing else touched. <a href="install.sh">Read it</a> before running it.
The executable is this same TypeScript code compiled with Bun, with the panel embedded.
</details>

<details>
<summary><strong>Windows?</strong></summary>
<br>
Not yet. The OS sandbox is mandatory, so the runner supports macOS and Linux only.
</details>

## Development

```bash
git clone https://github.com/hernanmateo/backcode-runner.git
cd backcode-runner
npm install
npm run panel      # the panel from this copy (also: npm run connect · npm run all · npm start -- --project <id>)
npm test
```

To try it without touching your real setup: `BACKCODE_HOME=/tmp/bc BACKCODE_PANEL_PORT=47999 npm run panel`.
`npm run build:bin` compiles the executables (needs [Bun](https://bun.sh)) into `dist-bin/`, and `npm run build:mac` builds the
universal `Backcode Runner.app` and `Backcode-Runner.dmg` (on a Mac; signed and notarized when `MAC_SIGN_IDENTITY` and the
notarization variables are set). Pushing a `vX.Y.Z` tag publishes everything as a GitHub Release, together with the npm package.
The agent's instructions live in [`instructions/AGENT.md`](instructions/AGENT.md). The full reference (every action, OTA, builds,
deploys, Bitbucket, variables) is in the [Spanish guide](README.es.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE) © Hernan Mateo. See [NOTICE](NOTICE).

<p align="center"><sub>Built with Claude Code. Not affiliated with Anthropic.</sub></p>
