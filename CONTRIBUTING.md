# Contributing

Thanks for helping improve Backcode Runner.

## Getting started

```bash
git clone https://github.com/hernanmateo/backcode-runner.git
cd backcode-runner
npm install
npm test
BACKCODE_HOME=/tmp/bc BACKCODE_PANEL_PORT=47999 npm run panel   # try the panel without touching your real setup
```

Requirements: macOS or Linux, Node.js 22+ and Claude Code signed in.

## Pull requests

- Keep changes focused, and explain the *why* in the description.
- Run `npm run build && npm test` before pushing; CI runs both on macOS and Linux.
- User-facing text lives in `src/i18n.ts` and must be added in **Spanish, English and Catalan**.
- Anything that touches the sandbox, guarded commands, protected paths or how the runner pushes needs extra care: describe the
  threat model you considered.
- Update `README.md` (and the full guide in `README.es.md`) when behaviour or setup changes.

## Reporting bugs

Open an issue with your OS, Node and Claude Code versions (`npx @backcode/runner --version`, `claude -v`) and the relevant lines
from the panel's **Activity** view. Remove anything private (paths, repo names, tokens) first.

Security issues: please don't open a public issue, see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
