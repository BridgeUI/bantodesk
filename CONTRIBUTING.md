# Contributing

Thanks for your interest in BantoDesk! Issues and pull requests are welcome, in English or Japanese.
（日本語での issue・pull request も歓迎します。）

## Getting started

```sh
git clone https://github.com/bridgeui/bantodesk.git
cd bantodesk
npm ci
npm start            # or: npm start -- /path/to/a/project
npm test             # unit tests (node only, no Electron)
```

You need Node.js 20 or later and [Claude Code](https://docs.claude.com/en/docs/claude-code) on your `PATH`.

## Before you open a pull request

- Keep changes focused; one topic per pull request.
- Run `npm test`. Add a unit test under `test/<topic>/unit.js` for logic you change (plain `node`, exit code 0 = pass).
- Follow the [security design](docs/security.md). In particular, do not add run-time compilation, scripts started in
  hidden windows, process or network enumeration, or anything that reads other processes or credentials. Test files
  that need sample command lines build suspicious command names from parts (`'net' + 'stat'`).
- The renderer has no bundler and no CDN: plain scripts, `Content-Security-Policy: default-src 'self'`.
- UI text is currently Japanese. If you add UI text, Japanese is fine; English alongside is welcome.

## Reporting bugs

Use the issue templates. For security problems, use GitHub's private vulnerability reporting instead of a public issue
(see [docs/security.md](docs/security.md)).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
