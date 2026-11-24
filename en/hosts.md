# Hosts & connections

Turn scattered SSH one-liners into a managed host inventory: groups, shared credentials, jump hosts and proxies configured once — used by both you and the AI.

![Advanced host connection settings](../assets/hosts.png)

## What you get

- **Host manager**: store hosts (address, port, user, auth method, group, environment tag) with groups and workspaces.
- **Bulk edit**: change many hosts at once (port, user, proxy, …).
- **Imports**: bring in existing sessions from `~/.ssh/config`, Xshell, PuTTY, MobaXterm, SecureCRT and more.
- **SSH keys**: generate, import, select keys; view fingerprints; deploy the public key to a host.
- **Shared credentials**: several hosts may share one account or key — change it once.
- **Host key verification**: confirm and remember fingerprints on first connect; warn when a fingerprint changes.
- **ssh-agent / Pageant**: reuse keys from the system agent, no repeated passphrase prompts.
- **Jump hosts and proxies**: jump host, outbound HTTP / SOCKS5 proxy, or `ProxyCommand` — pick what your network needs.
- **Port forwarding and SOCKS5**: local and remote forwards plus a dynamic SOCKS5 proxy, with rule management, status and open-in-browser.
- **Run after login**: automatically run commands once connected (cd, env, tooling).
- **Advanced options**: agent forwarding, keepalive interval, connect timeout.
- **tmux keep-alive**: resume the same terminal after a drop (requires tmux on the remote side).
- **Automatic reconnect**: reconnects on flaky networks and announces it in the terminal.
- **Two-factor login**: OTP (TOTP) and bastion-style interactive login flows.
- **Host panel / dashboard**: CPU, memory, network, disk I/O and disk usage at a glance — including why a host is unreachable.
- **`ssh://` links**: click `ssh://user@host:port` to open a connection.
- **Production tagging**: hosts marked production require per-command confirmation for writes (see [Security & settings](security.md)).

## How to use it

1. **Add your first host**: Hosts → New → address / user / auth → save.
2. **Verify the fingerprint** on first connection.
3. **Group by environment or service** — approvals, bulk actions and inspections all work by group.
4. **Complex networks**: try direct first, then add a jump host or proxy; use `ProxyCommand` for internal tooling.
5. **Port forwarding**: add rules in the host details and toggle them on demand.

## Notes

- Passwords, private keys and passphrases are encrypted with the OS keychain — never stored in plain text.
- On production hosts every AI write command needs your confirmation; mislabeling an environment defeats that protection, so label hosts early.

## Related

- [Terminal](terminal.md) · [Files & transfer](files.md) · [Ops & troubleshooting](ops.md) · [Security & settings](security.md)
