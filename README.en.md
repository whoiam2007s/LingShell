# LingShell (灵壳)

> A thinking terminal and operations workbench: AI investigates and executes, you stay in control.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#install)
[![Status](https://img.shields.io/badge/status-early%20preview-orange.svg)](#status)
[![CI](https://github.com/whoiam2007s/LingShell/actions/workflows/ci.yml/badge.svg)](https://github.com/whoiam2007s/LingShell/actions/workflows/ci.yml)

English · [简体中文](README.md) · [Feature guide](#feature-guide)

LingShell is an open-source AI terminal and operations workbench: an AI chat on the left, local and SSH terminals on the right. After your approval, the AI can execute commands, read the output, and continue. Every action has approval cards, dangerous-command confirmation, execution plans, rollback plans, and a full audit trail.

![LingShell main window: chat and terminals](guide/assets/hero.png)

- **Local-first**: configuration, hosts, sessions, audit data, and credentials stay on your machine. Bring your own model API key.
- **Model-agnostic**: DeepSeek, Qwen, Kimi, Ollama, OpenAI-compatible endpoints, and Anthropic Messages.
- **Built for real operations**: multi-host, file transfer, Git, databases, Docker, Kubernetes, scheduled inspection, certificates, compliance, deployment review, logs, and troubleshooting.
- **Controllable by design**: app lock, secret vault, per-host authorization, command rules, AI review, dry-run mode, time-limited sudo elevation, and local audit.

> Early preview (0.1.x). APIs, configuration formats, and features may change. Try it in a test environment first.

## Features

### AI and terminals

- Local terminals (Git Bash / PowerShell / cmd / WSL on Windows; native shells on macOS / Linux) and SSH terminals.
- AI chat, tool calls, approval cards, execution plans, rollback plans, audit trail, per-turn file changes and undo.
- Split panes, broadcast input, pinned/colored/renamed tabs, tmux session persistence, command success/failure marks, history, completion, quick commands, composer, keyword highlighting and alerts.
- Attachments/images, Skills, MCP, knowledge base, cross-host questions, host dashboard.

### Files and developer tools

- File explorer (local / SFTP), upload/download with resume, dual-pane manager, sudo mode, directory sync, file preview, external editor round-trip.
- Error location (`file:line` / VS Code Remote), config explanation, key-based config diff, Git panel, API debugger.
- Local/remote Docker, Compose, Kubernetes, and MySQL / PostgreSQL / Redis / MongoDB quick inspection and backup.

### Operations and security

- Host health check, config drift, change snapshots, listening ports, processes, services, logs (tail / multi-host merge / history search), connectivity probe, disk analysis.
- Scheduled inspection, watchdog, certificate checks, baseline compliance, deployment review, webhook alerts, one-click AI troubleshooting.
- App lock, secret vault, command rules, dangerous-command confirmation, AI review, dry-run mode, time-limited sudo elevation, audit trail, terminal recording and session logs.
- Mobile (LAN) read-only session view and approval handling.

### Feature guide

Each area has its own page with usage details and caveats (Chinese and English):

| Topic | What's inside |
| --- | --- |
| [AI chat & execution](guide/en/ai-chat.md) | Approval cards, execution plans, rollback, run log, context & attachments, Skills / MCP / knowledge |
| [Terminal](guide/en/terminal.md) | Local & SSH, split & broadcast, search, quick commands, compose bar, highlight alerts, command marks, instant replay |
| [Hosts & connections](guide/en/hosts.md) | Hosts & groups, imports, keys & credentials, jump / proxy / ProxyCommand, port forwarding, OTP, reconnect |
| [Files & transfer](guide/en/files.md) | Explorer, SFTP upload/download, resume, dual pane, sudo mode, external editor, directory sync |
| [Git](guide/en/git.md) | Changes & diffs, stage & commit, branches / merge / rebase / stash, blame, AI commit messages |
| [Database](guide/en/database.md) | MySQL / PostgreSQL / Redis / MongoDB queries, exports, backups, slow logs |
| [Containers & K8s](guide/en/containers.md) | Local & remote Docker, Compose, Kubernetes |
| [Ops & troubleshooting](guide/en/ops.md) | Host checkup, config drift, logs, ports / processes / services, disk, connectivity, deploy review, batch execution |
| [Automation & inspections](guide/en/automation.md) | Scheduled inspections, watchdog, certificate checks, baseline compliance, chat-bot alerts, quick commands, runbooks |
| [Security & settings](guide/en/security.md) | App lock, secret vault, approval rules, dangerous commands, AI review, dry run, audit, data & updates, mobile access |

## Install

Download the installer for your platform from [Releases](https://github.com/whoiam2007s/LingShell/releases).

- **Windows**: `LingShell-<version>-win-x64.exe` (NSIS, currently unsigned; SmartScreen will warn).
- **macOS / Linux**: build configuration is present but not thoroughly tested yet; testers welcome.
- On first launch, add your own API key in Settings → Model. Without a key, no model request is made.

> Installers are currently unsigned. Verify the SHA256 published with each release; enterprises should build and sign their own.

## Security model

- **Local-first**: application data lives in `~/.lingshell`; browser data and OS-keychain material stay in your user profile. Nothing is uploaded to a LingShell server.
- **No silent execution**: commands require per-host authorization by default; writes on production hosts require confirmation; dangerous commands always require confirmation.
- **No plaintext secrets**: API keys, host passwords/private keys, and vault values are encrypted with the OS keychain; outbound AI data can be redacted.
- **Auditable**: execution records, approvals, rollbacks, and file changes are traceable; session reports can be exported.
- **No telemetry by default**: no usage data is collected. Third-party services you configure (model providers, webhooks, MCP) are your choice.

Report vulnerabilities privately per [SECURITY.md](SECURITY.md); do not open a public issue.

## Development

Requirements: Node.js ≥ 18, pnpm 9, Git. On Windows, Git for Windows (Git Bash) is required for local terminals. Building node-pty may require VS Build Tools; packaged builds use its prebuilt binaries.

```bash
pnpm install
pnpm dev        # UI dev server + Electron
pnpm test
pnpm typecheck
pnpm lint
pnpm check:structure   # directory boundaries, IPC protocol consistency, import-cycle checks
pnpm dist:win   # Windows installer (release/ at the repo root)
```

Layout:

```
apps/
  desktop/        Electron main + preload + IPC wiring
  ui/             React UI (Vite)
packages/
  shared/         client contract, events, pure logic and types
  terminal-core/  local/SSH terminals, command capture, locking
  dsh-controller/ DeepSeek Harness session and tool integration
  auth-registry/  authorization and dangerous-command detection
  config/         settings / hosts / sessions / layout persistence
  platform/       paths and logging
cli/              external agent scripts for the local API
docs/             design, migration, and feature documentation
scripts/          repo checks (structure, i18n)
```

The main process, the shared protocol, and the UI's IPC implementation are split by the same domains (terminal, ai, ops, files, git, db, integrations, mobile, app); other directories may only import a directory through its `index.ts`. Where new code goes and the four places to touch when adding an IPC channel are described in [CONTRIBUTING.md › 代码结构](CONTRIBUTING.md#代码结构).

## Status and edition boundary

- This repository is the **community edition**: single-user, local-first, full security features, free forever under Apache-2.0.
- Team collaboration and central governance (shared credentials, central policy/approval, centralized audit, SSO/RBAC, relay, private deployment, etc.) will be offered as separate commercial Team / Enterprise editions. See [COMMERCIAL.md](COMMERCIAL.md).
- Commitment: **we will not move existing single-user features behind a paywall, and security fixes remain free.**

## Sponsorship

If LingShell is useful to you, you can [sponsor the project](SPONSORS.md) (WeChat Pay / Alipay). Sponsorship covers development time and test machines, and **never affects feature availability** — the community edition stays complete and free.

## Contributing

Issues, docs, tests, and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). First-time contributors must agree to the [CLA](CLA.md).

## License and trademark

- Code: [Apache License 2.0](LICENSE).
- Name and logo: [TRADEMARK.md](TRADEMARK.md).
- Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Privacy: [PRIVACY.md](PRIVACY.md).

LingShell and its logo are project trademarks; modified distributions may not use them without permission or imply official endorsement.

## Contact

- Maintainer: BigZ
- Email: whoiam2007s@163.com
- Please report security issues privately per [SECURITY.md](SECURITY.md).
