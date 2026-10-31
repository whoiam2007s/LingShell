# Files & transfer

Local and remote files in one place: browse, search, edit, transfer, compare and sync — no `scp` / `rsync` flags, no second SFTP client.

![File explorer with transfer queue](../assets/files.png)

## What you get

- **Explorer**: browse local folders and remote hosts (SFTP) in the same UI, with expansion state and history remembered.
- **Upload / download**: files, folders, multi-select and drag-and-drop; queue with progress, pause, cancel and retry.
- **Resume**: interrupted transfers continue instead of restarting.
- **Dual pane** (WinSCP-style): local on the left, remote on the right — drag to transfer.
- **sudo mode**: read or write in directories you cannot access, with approval and audit.
- **Attributes and permissions**: view and change `chmod` and ownership, locally and remotely.
- **Compress / extract**: archive remotely (zip / tar.gz) before transferring many small files.
- **Directory bookmarks**: keep frequently used paths one click away.
- **Search and quick filter**: find files in large trees.
- **Edit and preview**: built-in editor with a diff check on save; preview images, PDFs, tables and Office documents.
- **Open in local editor**: edit a remote file in VS Code and have it uploaded on save; if the remote copy changed meanwhile you get a conflict prompt (overwrite / save as / discard).
- **Follow terminal cwd**: the explorer follows wherever the terminal `cd`s.
- **Drop files onto the terminal**: inserts the path for you.
- **Transfer queue**: batched transfers, individual retries.
- **Compare and sync**: diff local ⇄ remote and sync one way or both.
- **Windows servers**: works with Windows hosts running the bundled OpenSSH.

## How to use it

1. Open the explorer and pick local or a host.
2. Switch to dual pane when moving files both ways.
3. To edit remote config, double-click to open the built-in editor, or open it in your local editor (auto-upload on save).
4. Turn on sudo mode for protected paths (approval required).
5. For large migrations: compress remotely, download, extract locally.

## Notes

- Overwrites are backed up first (external-editor round-trips and overwrite writes keep a copy).
- Every sudo write is logged and can be rolled back when a backup exists.
- Watch free space on the destination — size is estimated before backups and transfers.

## Related

- [Terminal](terminal.md) · [Hosts & connections](hosts.md) · [Git](git.md) · [Security & settings](security.md)
