# AI chat & execution

The left pane is the AI chat, the right pane is your terminals and hosts. The AI does not just hand you advice in a chat box — it **works in the terminal**: reads command output, decides the next step, edits files, inspects hosts. Every command that touches a machine needs your approval, and everything is logged.

![AI chat with approval card](../assets/ai-chat.png)

## What you get

- **Ops through conversation**: the AI can run commands, read logs, edit files, query databases and drive containers; results flow back into the conversation.
- **Approval cards**: before executing, the AI shows the command, its impact and the risk. You approve, reject, or narrow it down to a read-only command.
- **Execution plans**: multi-step work can be laid out as a plan you approve; you may also delete individual steps.
- **Rollback**: write operations must come with an undo command; the run log can replay it in one click.
- **Run log**: time, host, command, exit code, duration and whether it was rejected — all recorded and exportable.
- **Context management**: long sessions are compacted automatically; you can reset or fork a session.
- **Attachments**: drag in screenshots, paste images or attach log files.
- **Skills / MCP / knowledge**: turn team conventions into Skills, wire external tools via MCP, save host facts as knowledge cards — the AI pulls them in when relevant.
- **`@` references**: point the AI at a specific terminal, host or past session.
- **`!` prefix**: a line starting with `!` runs directly in the current terminal, bypassing the AI.
- **Ask cards**: when the AI needs a decision it shows options (single or multi select) and continues after you choose.
- **Send terminal output to the AI**: select output in the terminal and hand it over as context.
- **Session search**: search inside a session, across sessions, and ask "how did we fix this last time?".
- **Exports**: session report (Markdown / HTML) and an incident post-mortem on a fixed template.
- **Notifications**: tray and system notifications when the AI finishes, a long command ends, or approval is needed.

## How to use it

1. **Configure a model**: Settings → Model → enter your own API key (BYO Key), pick provider and model. Without a key no model request is ever sent.
2. **Start a conversation**: type in the left pane; use `@` first so the AI knows which terminal or host to work on.
3. **Read the approval card** before clicking allow. Write commands on production hosts require per-command confirmation.
4. **Watch the run log**: check each command's result; on failure just ask the AI to dig in.
5. **Wrap up**: revert the files changed this turn if needed, or export the session as a report.

## Safety boundaries

- The AI **never executes silently**: per-host approval by default, per-command confirmation on production, forced confirmation for dangerous commands.
- Secrets never reach the model: they are redacted before sending.
- Dry-run mode lets you see what the AI intends to do before anything actually runs.
- See [Security & settings](security.md).

## Related

- [Terminal](terminal.md) · [Hosts & connections](hosts.md) · [Security & settings](security.md) · [Ops & troubleshooting](ops.md)
