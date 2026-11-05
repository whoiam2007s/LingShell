# Terminal

A terminal built for AI assistance but with the feel you already know: xterm.js on a real PTY, with structured command capture, replay and AI hand-off.

![Split terminals with command marks](../assets/terminal.png)

## What you get

- **Local terminals**: Git Bash, PowerShell, cmd and WSL on Windows; the system shell on macOS / Linux.
- **SSH terminals**: full interactive sessions with jump hosts, proxies, keys and OTP (see [Hosts & connections](hosts.md)).
- **Tabs**: create, rename, pin, colour-code and switch quickly.
- **Split panes**: side by side or stacked — watch logs in one, type in the other.
- **Broadcast input**: type once, run on many terminals (batch config changes, compare outputs).
- **Search in buffer**: find and jump to matches.
- **Quick commands**: save commands as buttons, scoped globally, per group or per host.
- **Compose bar**: draft long or multi-line commands, review, then send.
- **Highlight rules and alerts**: highlight on keywords such as `error` or `OOM`; promote them to alerts that can trigger AI analysis.
- **Command marks**: a green or red dot marks every command's outcome; the scrollbar turns into an execution map.
- **Per-command actions**: copy the command, copy its output, re-run it, or attach command + output to the chat.
- **Command history**: persisted across sessions, searchable and re-runnable; (redacted) history is available to the AI as context.
- **Autocompletion**: suggestions from history and common commands as you type.
- **Paste safety**: multi-line pastes are confirmed before they hit the shell.
- **Instant replay**: replay a session's output over time (default `Ctrl+Alt+R`).
- **Quick select** (default `Alt+S`): grab paths, URLs, IPs and hashes right from the terminal.
- **Quake mode**: double-tap `Alt` to show or hide the terminal.
- **Buffer export**: export the visible screen or the full buffer to a file.
- **Encoding**: switch encodings such as GBK to fix mojibake.
- **tmux persistence**: survive SSH drops and resume where you were (see [Hosts & connections](hosts.md)).
- **Bell and long-command notifications**.

## How to use it

1. Open a terminal: pick a local shell or a saved host.
2. Use split panes for parallel work; use broadcast input when the same command must run everywhere.
3. Save recurring commands as quick commands; draft complex ones in the compose bar.
4. On failure, click the red mark to locate it, then hand the command and output to the AI.
5. Use instant replay or buffer export when investigating what happened earlier.

## Tips

- `Ctrl+Shift+L` locks the app when app lock is enabled.
- `file:line`, URLs and `ssh://` links in the terminal are clickable.
- Dropping a file onto the terminal inserts its path.

## Related

- [Hosts & connections](hosts.md) · [AI chat & execution](ai-chat.md) · [Files & transfer](files.md) · [Ops & troubleshooting](ops.md)
