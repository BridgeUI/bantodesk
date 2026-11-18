# Security design

BantoDesk starts and supervises many Claude Code processes on your machine, often while nobody is watching the
screen. Two things follow from that:

1. **Nothing the app does should look like malware.** Endpoint security products (EDR) judge programs by the *shape*
   of what they do — script engines calling native APIs, code compiled at run time, executables dropped in temp
   folders, command lines that mix interpreter code with process-start calls, scans of the network or of other
   processes. A developer tool that does any of this gets blocked (and gets its user a call from IT), even when the
   intent is harmless. BantoDesk is built so that none of these shapes appear — in the app *and* in the commands
   the agents it starts are allowed to run.
2. **Unattended agents need guard rails, not just good intentions.** The manager agent (ルーター) may press "Yes" on a
   permission prompt for you, but only for prompts the app classifies as safe.

This page describes the rules the code follows. Where a rule is enforced in code, the file is named.

## What the app never does

- No code is compiled at run time (no PowerShell `Add-Type`, no C# / C compiler call, no DLL written to a temp
  folder). Native work is done by a small N-API module that ships prebuilt with the app
  (`src/main/native/atproc.node`, source in `native/atproc/`, rebuilt with `node native/atproc/build.js`).
- No reading or writing of other processes' memory, no code injection, no `OpenProcess` on other processes. The
  process list (`src/main/proclist.js`) reads only PID, parent PID, creation time, thread count, memory and image
  name with one `NtQuerySystemInformation` call — never command lines.
- No network or process reconnaissance: no port scans, no connection listings, no collection of command lines.
  Free ports are found by trying to `listen` on 127.0.0.1.
- No credential access (browser passwords or cookies, OS credential stores, LSASS / SAM, other apps' tokens).
- No persistence: nothing is added to Run keys, startup folders, the task scheduler or services.
- No changes to security settings (antivirus exclusions, firewall rules, UAC, execution policy).
- No hidden-window script engines and no executables or scripts run from temp or download folders.
- Claude Code is started directly (`claude` / `claude.exe`), not through a PowerShell or `cmd` wrapper
  (`src/main/claude-cmd.js`; `AGENT_TERMINAL_SHELL` opts back in).
- No telemetry. The app itself sends nothing to any server. The only traffic is Claude Code's own (to Anthropic, under
  your Claude account) and, if you turn it on, the phone view described below.

## Guard rails for the agents (`src/main/pretool-guard.js`)

Every Claude Code process the app starts gets a `--settings` file with:

- `permissions.deny` rules, and
- a `PreToolUse` hook (`node src/main/pretool-guard.js`) for setups where hooks are allowed,

that stop shell commands of the shapes EDR products flag, before they run:

- code passed straight to an interpreter (`node -e`, `python -c`, `bash -c`, `powershell -Command`, heredocs) that
  starts processes or names system tools,
- encoded commands (`-EncodedCommand`), decode-then-run (base64, char-code arrays), `iex` / `Invoke-Expression`,
- download-and-run (`curl … | sh`),
- run-time compilation and assembly loading,
- executables or scripts in temp / download folders,
- network or process reconnaissance tools,
- remote debugging that is not bound to 127.0.0.1 with the e2e marker,
- hidden-window launches, persistence, security-setting changes and credential access.

A blocked agent is told how to rewrite the command instead: write the code to a file and run `node <file>`; build
suspicious names from parts inside files; use `git commit -F <file>` when a commit message contains such a name. The
agents are told never to remove or work around the guard. The same rules can be added to your own
`~/.claude/settings.json` for sessions you start by hand:
`node scripts/guard/install-user-settings.js` (dry run) / `--apply` / `--remove --apply`.

Tests that need sample command lines build the suspicious command names from parts (`'net' + 'stat'`), so that a test
file never contains the very command lines the guard looks for.

## Remote debugging (`src/main/e2e.js`)

The end-to-end tests drive the app over the Chrome DevTools Protocol. The preferred transport is a pipe
(`--remote-debugging-pipe`), which opens no port. If `--remote-debugging-port` is used at all, the app quits unless it
also has the e2e marker (`--agent-terminal-e2e`) **and** `--remote-debugging-address=127.0.0.1`. An app you start
normally never exposes a debugging port.

## The ルーター pressing "Yes" (`src/main/stuck.js`)

When a session has been stuck on a permission prompt for a while, the ルーター may answer it — only with a one-time "Yes",
and only when the app classifies the prompt as safe. Deletions, anything touching secrets, network access, paths
outside the work folder and anything matching the guard rails above go to you instead, marked in red, and are never
answered by the ルーター.

## Phone view (`src/main/remote.js`)

Off by default. When you turn it on from the toolbar, the app serves a small web page on your local network
(ports 8790–8799) so you can watch and answer sessions from a phone. Access needs a random token (shown as a QR
code; you can regenerate it). The page is plain HTTP — use it only on networks you trust, and turn it off when you
are done.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability) rather
than a public issue.
