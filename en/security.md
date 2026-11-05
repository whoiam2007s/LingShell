# Security & settings

LingShell assumes that **the AI will make mistakes, networks are watched, and production does not forgive a misplaced keystroke**. Approval, redaction and audit are on by default.

![Command rules and dangerous-command confirmation](../assets/security.png)

## Approval and guardrails

- **Per-host approval**: every command is approved per host by default; each host has a trust level (confirm each / read-only auto-approve / auto-approve).
- **Production hosts**: write commands need confirmation every single time, with no "allow for this session".
- **Dangerous commands**: `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, firewall changes, reboots and similar always require a second confirmation.
- **Command rules**: allow / ask / deny rules (prefix or regex) so team conventions become policy.
- **AI review**: high-risk commands can be reviewed by a second model independently before execution.
- **Dry-run mode**: the AI only describes what it would do; turn it off to actually run.
- **Time-limited sudo**: elevate only when needed and let it expire.
- **Layered rules**: global → group → host → working directory; the more specific level wins.

## Data safety

- **Secret vault**: API keys, host passwords, private keys and vault entries are encrypted with the OS keychain (Windows DPAPI / macOS Keychain / Linux Secret Service) — never plain text.
- **Redaction before the model**: passwords, tokens and connection strings are replaced with placeholders; the model only ever sees placeholders.
- **App lock**: lock the screen instantly with `Ctrl+Shift+L`; optional lock on startup.
- **Audit trail**: approvals, executions, rollbacks and file changes are recorded and exportable.
- **Terminal recordings and session logs**: optionally record sessions for later review.
- **Diagnostics package**: exports are redacted automatically — no keys or passwords leave the machine.
- **No telemetry**: no usage data is collected by default; only the model / webhook / MCP endpoints you configure receive data.

## Settings and data

- **Model settings**: provider, model, protocol (OpenAI-compatible / Anthropic Messages) and multiple switchable profiles.
- **Data directory**: everything lives in `~/.lingshell` (config, hosts, sessions, audit, logs, recordings).
- **Backup**: export / import the whole configuration, optionally on a schedule.
- **Updates**: packaged builds can check for updates (enabled only if an update source was configured at build time); never forced to restart.
- **Appearance**: theme, UI scale, icon size, language (Simplified Chinese / English).
- **Keyboard shortcuts**: all customisable.
- **Mobile access**: view sessions and handle approvals from a phone browser on the LAN (read-only plus approvals, no messages) after pairing.

## How to use it

1. First launch: set the app-lock password → add your model API key → tag hosts as production or test.
2. Configure command rules and trust levels to match your team (production = confirm every command is the safest default).
3. Use dry-run mode when you want to see the plan before anything runs.
4. Export backups regularly; if a leak is suspected, use the (already redacted) diagnostics package.

## Related

- [AI chat & execution](ai-chat.md) · [Hosts & connections](hosts.md) · [Automation & inspections](automation.md)
