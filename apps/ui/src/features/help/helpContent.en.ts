// 使用帮助的英文版（纯数据）。结构须与 helpContent.ts 完全一致：章节顺序、id、图标、settings、块数、块字段、步骤 / 提示 / 快捷键行数（helpContent.en.test.ts 校验）。
// 改中文帮助时同步改这里。界面标签用英文界面上的写法加双引号（"Settings → 页名" 会自动变成链接）。
import {
  Activity, AppWindow, ArchiveRestore, AtSign, BarChart3, BookMarked, BookOpen, BookOpenText, Boxes, CalendarClock, CircleHelp, ClipboardCheck,
  Container, Cpu, Database, EthernetPort, Eye, FileCode2, FileKey2, FileSearch, FolderTree, GitBranch, GitBranchPlus, GitCompare, HardDrive,
  Keyboard, Layers, LayoutDashboard, Link2, ListChecks, ListTree, LockKeyhole, MessageSquare, MonitorDot, Network, Palette, Paperclip, Plug,
  Radar, Rocket, ScrollText, Search, Send, Server, ServerCog, Shield, ShieldCheck, Siren, Smartphone, Sparkles, Stethoscope, Table2,
  TerminalSquare, TrendingUp, Video, Wand2, Zap,
} from 'lucide-react'
import type { HelpSection } from './helpContent.js'
import type { SettingsTab } from '../settings/index.js'

/** 英文帮助正文里设置页的写法（"Settings → 页名"）：英文界面的设置页译名之外再认这一份，正文链接不依赖词典是否已对齐 */
export const HELP_SETTINGS_TITLES_EN: Record<SettingsTab, string> = {
  model: 'Model settings', ssh: 'Hosts & connections', terminal: 'Terminal', ai: 'AI & security', general: 'General',
  templates: 'Task templates', runbooks: 'Runbooks', schedules: 'Scheduled inspections', mcp: 'MCP servers',
  keys: 'SSH keys', network: 'Network proxy', recordings: 'Terminal recordings', about: 'About',
  maintenance: 'Backup & diagnostics', shortcuts: 'Keyboard shortcuts', skills: 'Skills', secrets: 'Secret vault', mobile: 'Mobile access',
  compliance: 'Compliance baseline',
}

export const HELP_SECTIONS_EN: HelpSection[] = [
  {
    id: 'quickstart', title: 'Getting started', icon: Rocket, settings: 'model',
    blocks: [
      { p: 'LingShell puts an AI chat on the left and local / SSH terminals on the right. Describe what you want in plain language; once you grant permission, the AI runs commands in the terminal, reads the results, and moves on to the next step.' },
      { h: '1. Set up a model and API key', steps: [
        'Click the gear "Settings" on the right of the title bar → "Model settings" (if no key is set yet, the chat area shows "No API key configured yet" and an "Open settings" button).',
        'Click the "Default" profile in the list to edit it, then pick a "Provider": DeepSeek, Qwen (DashScope), Kimi (Moonshot), Ollama (local, no key needed), or an OpenAI-compatible endpoint.',
        'Pick or enter a "Model", change the "API URL" if needed, enter the "API key", and click "Test connection" to make sure it works. Changes save automatically (the API key saves when you leave the field), and "Auto-saved" appears next to the title.',
      ], tips: ['Each profile\'s key is encrypted separately with the system keychain and never written to disk in plain text. You can set up several models; see "Model settings and switching models".', 'With Ollama, pick a model that supports tool calling.'] },
      { h: '2. Open a terminal / connect to your first host', steps: [
        'Click "+" at the top right of the terminal area: "Local terminal" opens one on this machine; "New SSH connection…" lets you enter the address, username, and auth method, then connect.',
        'Save hosts you use often in "Settings → Hosts & connections", then connect in one click from "Saved hosts (click to connect)" in the "+" menu.',
      ] },
      { h: '3. Let the AI work in the terminal', steps: [
        'Describe the task in the input box at the bottom left, e.g. "find which directory uses the most disk on this machine", and press Enter to send (Shift+Enter for a new line).',
        'The first time the AI accesses a terminal, a permission card pops up. Check the command and click "Allow".',
        'Commands really run in the terminal on the right, and you see the output too; the AI reads the result before deciding the next step. Click the red "Stop" at any time to interrupt.',
      ], tips: ['Not sure about a command? Click "Edit command" to change it before it runs, or "Deny" with a reason, and the AI adjusts accordingly.'] },
      { h: 'Requirements', p: 'On Windows, local terminals (and AI access to local terminals) need Git Bash from Git for Windows. Download and install it from https://git-scm.com/download/win and the app finds it automatically. Without it, the terminal area shows a "Git Bash not detected" guide card; SSH remote terminals are unaffected. macOS / Linux need nothing extra.' },
    ],
  },
  {
    id: 'palette', title: 'Command palette and search', icon: Search,
    blocks: [
      { p: 'Click the search box in the middle of the title bar ("Search hosts, sessions, commands, help…"), or press Ctrl+K (when focus is not in a terminal) / Ctrl+Shift+P (any time) to open the command palette: one search box that takes you straight to hosts, session history, runbooks, quick commands, task templates, settings pages, actions, and the content of Help. ↑↓ to select, Enter to run, Esc to close. With nothing typed, it shows recent and frequently used items.' },
      { h: 'Prefix filters', steps: [
        '`>` searches actions only, `@` hosts only, `#` session history only.',
        '`?` (the full-width question mark works too) followed by keywords searches Help only; `?` alone lists all Help chapters.',
      ] },
      { h: 'Searching Help', p: 'When you type keywords, the last result group, "Help", lists the most relevant Help sections (up to 5, more when searching Help only): the first line is "Chapter › Section", the second is the passage around the match, with matched words highlighted. Selecting one opens Help, scrolls to that section and briefly highlights it; matched words in the body are highlighted too.', tips: [
        'Separate multiple keywords with spaces; they must all appear in the same section. Matching is case-insensitive and literal (no pinyin).',
        'Chapter title matches rank first, then section titles, then body text.',
        '"Search help…" at the top left of the Help window (F1) uses the same search: chapters filter as you type and sort by relevance, it jumps to the most relevant section and highlights matches, and clicking another chapter scrolls to its match. Esc clears the search first; press it again to close.',
      ] },
    ],
  },
  {
    id: 'chat', title: 'AI chat and permissions', icon: MessageSquare,
    blocks: [
      { h: 'Sessions', p: 'The top of the chat area, left to right: session title (hover for "Rename" and "Export session"), current model name (click to switch), a small usage tag (total tokens + context percentage), and "New session" (+). The vertical activity bar on the far left of the chat area, top to bottom: "Explorer", "Session history", "Session permissions / Execution log" (shield), and "Knowledge base". Drawers slide out next to the activity bar, and the open one\'s icon is highlighted. Session history can be searched by title, chat content, and commands that were run.' },
      { h: 'Wide tables in chat', p: 'Markdown tables in AI replies size to their content: each column is 6–28 characters wide. When a table is wider than the bubble, a horizontal scrollbar appears, the first column stays fixed, and shadows on both sides hint at more content; narrow tables still fill the bubble width.', steps: [
        'Hover over a table and "Expand" appears at the top right: view it full width in a large window; press Esc or click outside to close.',
        '"Copy as Markdown" keeps the table format; "Copy for Excel" copies tab-separated text that splits into columns when pasted into Excel / WPS / Feishu Sheets.',
      ] },
      { h: 'Times and durations', p: 'Times in the chat show when things actually happened, and they persist when you reopen old sessions after a restart (sessions from before the upgrade without records show none).', tips: [
        'Your messages: the send time appears next to the bubble (today shows just hh:mm; other dates include month-day or the year). Hover for the full time.',
        '"Started answering hh:mm:ss" in the AI turn header = when the model started responding. Hover to see how long after your question it started.',
        'After "Steps · N" is the total time of the turn from start to finish; each tool card\'s title row ends with that tool\'s duration. In-progress items count up live.',
        'Tool durations start when the tool is recognized (including the time the model spends generating arguments): as soon as the model starts emitting a tool call, the card appears with a dashed border showing "Generating arguments…" and "Preparing", switching to "Running" once arguments are complete. Hover the duration to see exact "Recognized → Done" times and how long argument generation and execution each took. Cards interrupted before arguments finished are marked as failed.',
        'The "Thinking" row in the steps shows "Thinking · 12.3s · 1,234 chars": the duration runs from when this thinking starts streaming to when it finishes, counting live while streaming; hover for exact "Start → End" times. Characters are counted individually (each Chinese character, letter, digit, and punctuation mark counts as 1) and grow live while streaming. Sessions from before the upgrade have no thinking duration and show only the character count.',
        'In the "Session history" list and # session results in the command palette, each session is followed by its last activity time (just now / N min ago / hh:mm / N days ago). Hover to see created and last active times.',
      ] },
      { h: 'Permissions: the AI asks before running', p: 'Permissions are tracked per host (local counts as one host, each saved host counts as one), shared by all terminals on that host. A permission card appears the first time the AI accesses a host, or when it moves from Read to Write; clicking "Allow" records that permission level for the host in this session.', steps: [
        'The permission card shows the target terminal, Read / Write, the reason (e.g. "First access to this terminal", "This command matches a dangerous pattern. Run it?"), the AI\'s explanation, and the `$ command`.',
        '"Allow" runs it; "Edit command" lets you change it first, then "Run edited" (Ctrl+Enter works too).',
        '"Deny" first shows an input box where you can say why and what to do instead (optional). Press Enter or "Confirm deny" and the reason is sent to the AI.',
        'Requests left unanswered for 5 minutes are denied automatically; you get a system notification when the window isn\'t in the foreground.',
      ], tips: [
        'The permission level is shown at the top right of the card as "Read / Write": read-only commands like `pwd`, `ls`, `cat`, `df` only need "Read" even the first time, even though they go through an execution tool; a later write command on the same host shows another card to upgrade to Write.',
        'The first access to each host still shows one card (Read): the AI gets that host\'s output, which is what Read permission covers. Later queries on the same host don\'t ask again. To check several terminals at once, have the AI use batch run (`exec_on_terminals`), which merges into one card. The terminal list also includes each terminal\'s recent directory, so just asking "which directory" usually doesn\'t need `pwd` and doesn\'t show a card.',
        'Read-only detection uses the same conservative allowlist as scheduled inspections: commands it doesn\'t recognize (including ones with write redirection, command substitution, sudo, or interpreters) are always treated as Write.',
      ] },
      { h: 'Trust levels', p: 'Click the shield "Session permissions / Execution log" → "Session trust level" on the "Session permissions" page. Each session has its own setting; the default is "Autonomous".', tips: [
        'Autonomous: once a host is permitted, commands run directly; dangerous commands still need confirmation when "Confirm each dangerous command" is on (on by default).',
        'Confirm: every write command needs confirmation; reads aren\'t asked again.',
        'Read-only: write commands are always denied.',
        'Production hosts are treated as "Confirm" even under Autonomous, dangerous commands always need confirmation, and every upload and download needs confirmation.',
        'The same page shows "Granted (local/hosts)", with "Upgrade to Write" and "Revoke", or you can grant in advance with "Grant read" / "Grant write" under "Add permission".',
      ] },
      { h: 'Plans (propose_plan)', p: 'For multi-step changes that need 3 or more write commands, the AI first shows a "Plan" card: the purpose, host, and command of each step, with dangerous steps marked in red as "Dangerous".', steps: [
        'Edit commands right in the card, or click the trash icon to remove a step.',
        'After you click "Approve plan", commands in this turn that exactly match the plan skip per-command permission, each step usable once; commands outside the plan need permission as usual.',
        '"Deny" also takes a reason so the AI can re-plan; plans left unanswered for 5 minutes are denied automatically.',
      ] },
      { h: 'Execution log', p: 'The "Execution log" page in the shield drawer lists every AI action: time, host · terminal, decision (ran / ran edited / you denied / in plan…), exit code, and command. Check "Show all sessions" to see every session.', tips: [
        'The AI backs up files automatically before rewriting them, and the log entry has a "Restore" button.',
        'When there are successful commands, click "Save as runbook" to turn this work into a runbook.',
      ] },
      { h: 'Rollback plan before running', p: 'When the AI runs change commands (editing config, starting/stopping services, installing/removing packages, moving or deleting files, etc.), it also provides a rollback command and rollback notes; if something genuinely can\'t be rolled back, the notes say "Cannot be rolled back" and why. Read-only commands don\'t need one.', steps: [
        'The permission card shows "Run" and "Rollback" side by side, with the rollback notes below the rollback command. When the AI gave no rollback plan, the "Rollback" column is marked in yellow "AI provided no rollback plan"; you can deny and ask it to add one.',
        'On production hosts, change commands without a rollback plan don\'t show a permission card; they go straight back to the AI with a request to add one.',
        'After running, the entry in the shield drawer\'s "Execution log" shows the rollback command and a "Roll back" button below it; the command\'s tool card in the chat also has a "Rollback" button that does the same.',
        'Clicking it opens a confirmation showing the rollback command and which terminal it will run in. Click "Run rollback" to run it in a terminal on the same host and show the result; the execution log gets a new "Rollback" entry and the original is marked "Rolled back".',
      ], tips: [
        'Rollbacks still go through command rules and the session trust level: you can\'t roll back if a "Block" rule matches or the session is Read-only. When permission is needed (first access, elevation, production host), "Run rollback" in the confirmation is the permission for this one time and isn\'t saved as a lasting grant.',
        'If the rollback command matches a dangerous command pattern, you must first check "This is a dangerous command and I\'ve verified it" before it runs.',
        'If the original terminal is closed, another open terminal on the same host is used; if the host has no open terminal, open one first and then roll back. If the AI is running a command in that terminal, you\'re asked to try again later.',
        'Failed rollbacks (non-zero exit code) are marked "Rollback failed"; click "Roll back" again to retry.',
      ] },
      { h: 'Context and auto-compaction', p: 'When the context exceeds the "Auto-compaction threshold", earlier chat is compacted automatically without interrupting the task. The threshold is calculated automatically: the context window of the session\'s model × 60%, up to 600K (the window is set in "Settings → Model settings", and each profile shows its calculated threshold), so there\'s nothing to configure. When the step count reaches "Suggest new session after steps" (default 100) and compaction has happened, you\'re asked whether to "Start new session from summary": history is cleared, the working directory, terminals, and permissions are kept, and the compaction summary (editable) becomes the first message of the new session.' },
      { h: 'The "+" menu before the input box', steps: [
        '"Add context" ▸ File / Folder: attach the path of a local file (images show as images) or folder to this message; see "Chat attachments and images".',
        '"Working directory": shows the currently bound directory; click to change it. Local terminals the AI opens in this session start here, and it\'s also the Explorer root; the default is your home directory. Terminals already running don\'t switch directories (each keeps its own current directory; SSH terminals use the remote directory). When the AI needs to work in this directory it opens a new local terminal; if you ask "which directory", it explains the working directory and each terminal\'s actual directory separately.',
        '"Skills" ▸: pick a skill for the AI to load first for this message; see "Skills".',
        '"Common tasks" ▸: a submenu lists templates; picking one fills the input box (templates with `{{placeholders}}` show a form first) and doesn\'t send automatically. "Manage templates…" at the bottom opens "Settings → Task templates".',
        '"Runbooks" ▸: a submenu lists runbooks; pick one, fill in the parameters, check the target terminals, and click "Send to AI"; see "Runbooks".',
        'You can keep asking while the AI works: press Enter and the message is inserted into the chat after the current step and before the AI\'s next request (marked "Follow-up during this turn"), and the AI handles it within this turn instead of waiting until it\'s all done. Until it\'s delivered, you can "Withdraw" it from "Waiting to insert" at the bottom (the text goes back to the input box). Press Alt+Enter instead to queue it as a new turn after this one. Running commands aren\'t interrupted; to block a command awaiting permission, click "Deny". The red "Stop" ends the turn, and follow-ups not yet inserted are sent as a new turn once it stops.',
      ] },
      { h: 'Send terminal content to the AI', p: 'Selecting text in a terminal shows an "Ask AI" button; clicking it quotes the selection into the input box (not sent automatically). The red dot of a failed command also has a one-click "Ask AI".' },
      { h: 'Upload / download', p: 'The AI can upload local files to an SSH host, or download remote files to `~/Downloads/LingShell/` on this machine; each one shows a permission card to confirm. For transferring files manually, see "Files".' },
      { h: 'Export session report', p: '"Export session" next to the session title offers: "Chat only (Markdown)", "Full report (Markdown)", and "Full report (HTML)". The full report includes a summary, chat and steps, execution log, file changes, and permission records.', tips: [
        '"Redact sensitive info" is checked by default: passwords, tokens, private keys, and keys starting with sk- / AKIA are replaced with "[redacted]".',
        'When command output contains code fences like ```, a longer fence is used to wrap it automatically so the rest of the report doesn\'t render incorrectly.',
      ] },
      { h: 'Incident postmortem report', p: 'When troubleshooting is done, choose "Export session" → "Incident postmortem (Markdown)" (or search "Generate postmortem" in the command palette): this sends the current session a message starting with "[Generate postmortem]", with the session\'s execution log (time, host, command, exit code), files the AI changed, and host changes attached, and asks the AI to fill in a fixed template: title, impact summary, timeline (time | event | command / finding), root cause, handling, recovery verification, follow-up items (owner left as "TBD"), and appendix (key commands and output summaries).', steps: [
        'When the AI finishes replying, "Incident postmortem · Save as file" appears below the reply. Click it and choose where to save; the default file name is "postmortem-session title-date.md".',
        'Times in the timeline come from the real times in the execution log; the AI doesn\'t make them up. Events mentioned in the chat without an execution record get "—" as the time.',
      ], tips: ['You can\'t generate it while the session is still running (the AI is replying); wait for the turn to finish.', 'The attached execution log is handled as "Redact before sending to AI"; at most the latest 200 entries are attached.'] },
      { h: 'Notify when AI finishes', p: 'When the window isn\'t in the foreground (you\'ve switched to another app or minimized it), a system notification "AI finished: session title" pops up when an AI turn completes, or "AI error: error summary" on failure. Click the notification to return to the window and switch to that session.', tips: [
        'No notification when the window is in the foreground or you clicked "Stop" yourself; replaying history in an old session doesn\'t trigger it.',
        'Toggle it with "Notify when AI finishes" under "Settings → AI & security → AI execution" (on by default). While the app is locked, only generic text is shown.',
      ] },
      { h: 'Files changed this turn / Undo this turn\'s changes', p: 'When the AI changes files with the write-file tool during a turn, the end of that turn\'s reply shows "N files changed this turn". Click it to expand a list of each file\'s host (local / host name), path, and "New" / "Modified".', steps: [
        '"View diff": see how this file changed from before this turn until now (new files are compared against empty content).',
        '"Restore": undo just this one file. Modified files are restored from the backup taken before the first change this turn; new files are deleted.',
        '"Undo all changes this turn": undoes every file from this turn in reverse order. The confirmation lists new files that will be deleted; if a file was changed again after this turn (by you or by the AI in later turns), it\'s listed separately and only overwritten after you confirm.',
        'After undoing, each file shows "Deleted" / "Restored" or the reason it failed. Remote files are undone over SFTP, which needs a connected terminal on that host.',
      ], tips: [
        'The current content is backed up before undoing as well, and the execution log gets an "Undo this turn\'s changes" entry; click its "Restore" to undo the undo.',
        'Only changes the AI made with the write-file tool (write_file) are included. Files changed through terminal commands (`sed -i`, `echo >`, `cat <<EOF`, etc.) have no backup and can\'t be undone.',
        'The summary is read from the execution log, so it still shows when you open a past session after restarting the app; older records from before this feature launched aren\'t shown.',
      ] },
    ],
  },
  {
    id: 'models', title: 'Model settings and switching models', icon: Cpu, settings: 'model',
    blocks: [
      { p: 'You can set up several models (different providers, or the same provider with different keys / models) and choose which one each session uses.' },
      { h: 'Model profiles', p: '"Settings → Model settings" lists all profiles: name, "Default" badge, API protocol tag (Anthropic / OpenAI), provider · model, and whether a key is set.', steps: [
        '"New profile": fill in "Name", "Provider", "API protocol", "Model", "API URL", "API key", and "Context window", then click "Create".',
        'Click a profile or its "Edit" to open the form; changes save automatically. Leaving "API key" empty keeps the saved key; a new key saves only when you leave the field (a half-typed key isn\'t saved). After switching providers you must enter a new key for it to save, so the original key isn\'t lost.',
        '"Duplicate": create a new profile from this one (reusing its key), often used to pair one key with different models.',
        '"Set as default" (star): new sessions use the default profile; one-off calls such as natural-language commands and command explanations use it too.',
        '"Delete": at least one profile must remain; sessions using it switch to the default profile.',
        '"Test connection": sends a request only when clicked, tested with the selected "API protocol". OpenAI-compatible: lists models first (no tokens used), or sends a tiny chat request if the endpoint has no list; Anthropic Messages: sends a tiny request to `URL/v1/messages`. Failures show the reason (e.g. authentication failed, can\'t connect).',
      ], tips: [
        'Each profile\'s key is encrypted separately with the system keychain, and the UI can\'t read back the plain text. A profile whose "Provider" changes doesn\'t keep the old key; enter it again.',
        'Single-profile settings from older versions migrate automatically into a profile named "Default"; keys you previously saved for other providers each become their own profile.',
        'DeepSeek offers "DeepSeek V4 Pro" (deepseek-v4-pro) and "DeepSeek V4.1 Flash" (deepseek-flash, supports images; officially upgraded in place to V4.1-Flash-1017 on 2026-10-17), both with a 1M context window. Retired official models (deepseek-chat, deepseek-reasoner, deepseek-v4-flash, deepseek-v4-flash-vision-exp) in profiles using the official URL switch to deepseek-flash automatically, keeping the key; profiles with self-hosted gateway URLs are left as they are.',
        '"Model settings" in config export ("Settings → Backup & diagnostics → Config export") includes all profiles; keys are exported only when you set an export password.',
      ] },
      { h: 'API protocol', p: '"API protocol" below "Provider" in the edit form decides which format is used to call the model:', steps: [
        '"Anthropic Messages (recommended, officially supported)": the default for DeepSeek. Requests go to `URL/v1/messages` with the key in the `x-api-key` header. Leaving "API URL" empty or entering `https://api.deepseek.com` switches automatically to the official `https://api.deepseek.com/anthropic`.',
        '"OpenAI-compatible (Chat Completions)": requests go to `URL/chat/completions` with the key in `Authorization: Bearer`. When DeepSeek uses it, the official URL becomes `https://api.deepseek.com` automatically (an entered `/anthropic` is corrected too).',
        'Qwen, Kimi, Ollama, and OpenAI-compatible endpoints always use OpenAI-compatible; this can\'t be changed.',
        'The small tag next to each profile name in the list shows its protocol ("Anthropic" / "OpenAI").',
      ], tips: [
        'After you change the protocol (saved automatically), sessions using this profile call the model with the new protocol from the next turn, keeping the chat history; a turn the AI is working on isn\'t interrupted.',
        'DeepSeek profiles saved by older versions don\'t have this option and are treated as Anthropic Messages (the same as after upgrading).',
      ] },
      { h: 'If the model doesn\'t support the Anthropic protocol', p: 'If your DeepSeek URL is a self-hosted or third-party gateway that only supports the OpenAI format, Anthropic protocol requests fail (typically HTTP 404 / 405, or a malformed response).', steps: [
        'Edit the profile and click "Test connection". When a protocol mismatch is suspected, the result says "This URL may not support the Anthropic protocol" and a "Switch to OpenAI-compatible and retry" button appears.',
        'Click "Switch to OpenAI-compatible and retry" (or set "API protocol" to "OpenAI-compatible" manually and test again); the change saves automatically.',
      ], tips: ['Conversely, if "OpenAI-compatible" returns 404 / 405, the URL may be missing a segment (such as `/v1`), or the gateway may only support the Anthropic protocol; try switching back to "Anthropic Messages".'] },
      { h: 'Switching models', p: 'Switching affects only the current session (saved with the session, kept after restart):', steps: [
        'Click the model name to the right of the title at the top of the chat area to show all model profiles, then pick one (the current one is checked).',
      ], tips: [
        'Switch while idle and the next message uses the new model; switching while the AI is working doesn\'t interrupt the turn and takes effect after it ends ("(next turn)" appears next to the model name).',
        'Chat history is kept and the new model picks up from there. Usage stats record the model each request actually used.',
        'Profiles without a key are grayed out in the list; add a key in "Model settings" first.',
      ] },
    ],
  },
  {
    id: 'terminal', title: 'Terminal', icon: TerminalSquare, settings: 'terminal',
    blocks: [
      { h: 'Local terminals and SSH', p: '"+" at the top right of the terminal area: "Local terminal", "New SSH connection…", and the list of saved hosts (searchable). On Windows, "Local terminal (Git Bash)" looks in order for the bash.exe set manually in "Settings → General → Git Bash path", the `LINGSHELL_BASH` environment variable, the Git for Windows install location in the registry, git.exe / bash.exe on PATH, and common install directories (Program Files, your user folder, scoop, Git on each drive). It ignores `C:\\Windows\\System32\\bash.exe` (that\'s WSL). If none is found it doesn\'t fall back to PowerShell; the menu item is grayed out and marked "Not installed". macOS / Linux use `$SHELL`.' },
      { h: 'PowerShell / cmd / WSL', p: 'On Windows, the "+" menu also lists "PowerShell", "cmd", and each installed WSL distro ("WSL · distro name") below "Local terminal (Git Bash)". PowerShell and cmd are marked "Manual only": you can type commands yourself, but the AI can\'t run commands in them (reading command results relies on bash), though it can read the screen. When you need the AI to run PowerShell, have it call `powershell.exe` from a Git Bash terminal. WSL terminals are checked once when created: if the default shell is bash / zsh or similar, the AI can use it; if the check fails (e.g. fish), it\'s manual only as well. Hover a tab to see the terminal\'s shell and whether it\'s manual only; after a restart it reopens with the same shell.' },
      { h: 'Tabs', p: 'Tabs show the name and type. Production hosts have a red "Production" badge, non-UTF-8 tabs show the encoding, recording tabs have a red dot, and disconnected SSH tabs have a "Reconnect" button. Double-click a tab to rename it (clear the name to restore the default). Right-click menu:', steps: [
        '"Duplicate session" (Ctrl+Shift+D): opens another one with the same connection and directory, placed to the right.',
        '"Rename tab", "Color" (red / orange / yellow / green / blue / purple, "Clear color").',
        '"Close tab", "Close other tabs", "Close tabs to the right", "Close all". With split panes there\'s also "Show in current pane".',
        '"Pin": moves the tab to the far left, showing only a pin, icon, and short name (hover for the full name), with no close button. "Close other tabs", "Close tabs to the right", and "Close all" skip it, and closing with middle-click or Ctrl+Shift+W asks for confirmation first. Right-click "Unpin" to restore it. Pin state is saved with the layout and kept after restart.',
        'Drag tabs to reorder them (the highlighted vertical line shows where it will go); the order is saved with the layout and kept after restart. Pinned tabs can only move within the pinned area, and regular tabs can\'t be dragged in front of pinned ones ("Pin" them first to put them there). Drop a tab onto a split pane to show that terminal in the pane. Middle-click a tab to close it.',
      ], tips: ['Closing a terminal the AI is running a command in (X / middle-click / Ctrl+Shift+W) always asks first, since closing interrupts the command.', 'Reloading the UI (Ctrl+R, e.g. during development hot reload) refills the terminal with the output from before the reload; local terminals return to their last directory after a restart.'] },
      { h: 'Paste safety check', p: 'When you paste (Ctrl+V or right-click) into any terminal and the content contains dangerous commands (such as `rm -rf`, `curl … | bash`) or invisible hidden / control characters (ESC escape sequences, zero-width characters, bidirectional control characters, etc., a common trap when copying commands from web pages), a confirmation lists it line by line first: dangerous lines are red, and hidden characters show as orange placeholders like ⟨ESC⟩ and ⟨U+200B⟩.', steps: [
        '"Paste anyway" ("Confirm paste and run" when it contains line breaks): pastes as is.',
        '"Paste without hidden characters": appears only when hidden characters are present; removes them, then pastes.',
        '"Cancel": doesn\'t paste.',
      ], tips: ['Toggle it with "Paste safety check" under "Settings → Terminal → Input" (on by default). Pasting multi-line content into a production terminal always asks first, regardless of this switch.', 'Sending from the compose bar uses the same confirmation; when hidden characters are present you can "Send without hidden characters".'] },
      { h: 'Bell alerts', p: 'Get notified when a terminal receives a bell (`\\a`), handy for "tell me when it\'s done": run `long-task; printf \'\\a\'` on the remote side.', steps: [
        'When the tab isn\'t visible: a yellow bell appears on the tab and disappears when you switch to it (it doesn\'t replace an existing alert / done dot).',
        'When the window isn\'t in the foreground: a system notification pops up (at most once per 10 seconds per terminal).',
      ], tips: ['Choose under "Bell alert" in "Settings → Terminal → Alerts": badge + notification (default) / badge only / off.'] },
      { h: 'Split layouts', p: 'The "Split layout" button on the right of the terminal tab bar: single, side by side, top and bottom, three columns, or 2×2 grid. If there aren\'t enough terminals, new local terminals open to fill the panes. Click a tab to put that terminal in a pane, use Alt+arrow keys to move focus between panes, drag dividers to resize, and double-click a divider to split evenly. The layout is restored after restart (SSH terminals only if opened from saved hosts).' },
      { h: 'Broadcast input', steps: [
        'Click "Broadcast input" on the right of the terminal tab bar, or press Ctrl+Shift+B.',
        'All connected non-production terminals are checked by default; use the checkbox on each tab to add or remove it. Production terminals must be checked manually.',
        'Type or paste in any terminal in the group and it\'s sent to every terminal in the group. An orange bar at the top shows how many; click "Stop broadcast" to end.',
      ], tips: ['Disconnected terminals and ones the AI is running commands in are skipped automatically. Broadcast is always off after a restart.'] },
      { h: 'Find in terminal', p: 'With focus in a terminal, press Ctrl+F (shared with the chat area: with focus in the chat, Ctrl+F searches the chat; in a terminal, it searches the terminal. In vim / less, page down with PageDown or Space instead, or change it back to Ctrl+Shift+F in Settings → Keyboard shortcuts). A "Find" box appears at the top right (selected text is filled in automatically). Supports "Match case"; Enter / Shift+Enter for next / previous, Esc to close.' },
      { h: 'Quick commands', p: '"Quick commands · group name (count)" at the bottom left of the terminal area opens a list upward: click one to write the command into the current terminal (without going through the AI); with "Press Enter at end" on, it runs right away.', steps: [
        'Switch "Command group" at the top of the list (you can also create, rename, and delete groups); the search box filters by name or command. ↑↓ to select, Enter to send, Esc to close.',
        'Each item shows its name and the command that would actually be sent to the current terminal; hover to show edit, move up, move down, and delete on the right.',
        '"Add quick command" at the bottom: enter a "Button name" and the default command (multi-line allowed); `{{params}}` are filled in before sending.',
        'Expand "Per OS" to enter separate Linux / macOS / Windows (Git Bash) versions; empty ones use the default command. Check "Only available on configured OSes" to gray out the item on other systems.',
        'Optional send target: "Send to current terminal" or "Send to broadcast group while broadcasting" (marked "Broadcast" in the list).',
      ], tips: ['OS detection: local terminals use this machine\'s OS; SSH runs `uname -s` silently once after connecting, and falls back to the default command if it can\'t tell.', 'Before a dangerous command is sent to a production terminal, the panel asks for confirmation and the button changes to "Confirm send to production", so Enter can\'t send it by accident.'] },
      { h: 'Compose bar', p: 'The "Compose bar" button to the right of "Quick commands" at the bottom of the terminal area (or Alt+C) toggles a multi-line input box: write and polish a command before sending, without going through the AI.', steps: [
        'Enter sends, Shift+Enter adds a line; multiple lines run line by line (same as pasting). Esc or the "×" on the right closes it.',
        'Choose the send target on the right: "Send to current terminal", "Send to broadcast group" (needs broadcast input on; otherwise same as current terminal), or "Send to all terminals". Disconnected terminals and ones the AI is running commands in are skipped automatically.',
        '↑ / ↓ (with the cursor on the first / last line) browse the last 50 sends from this bar.',
      ], tips: ['Sending multiple lines to a production terminal, or content with dangerous commands or hidden characters, first shows a confirmation listing the lines to run (dangerous ones in red, hidden characters as placeholders).', 'With focus in a terminal, Alt+C toggles the compose bar and is no longer sent to the shell.'] },
      { h: 'Keyword highlighting', p: '"Settings → Terminal → Alerts → Keyword highlighting", on by default: error / failed / denied in red, warn in yellow, ok / success / active (running) in green, IPv4 addresses in cyan. Rules can be added and removed, use regex, and change color. It only changes display colors and doesn\'t affect recordings or the output the AI reads; it doesn\'t apply inside full-screen programs like vim / top.' },
      { h: 'Keyword alerts', p: 'Click the bell icon ("Alert") on a keyword highlighting rule to be notified whenever that keyword appears in terminal output, handy for watching logs with `tail -f`:', steps: [
        'When the tab isn\'t visible: a blinking yellow dot appears on the tab and disappears when you switch to it.',
        'When the window isn\'t in the foreground or the tab isn\'t visible: a system notification shows the matching line.',
        'When you\'re looking at that terminal: a brief "Alert: …" toast appears at the bottom left.',
      ], tips: ['Each rule alerts at most once per 30 seconds per terminal.', 'Only output while a command runs counts: the prompt and the command you typed (such as `grep ERROR`) don\'t; there are no alerts while the AI runs commands or inside full-screen programs like vim.', 'The "Keyword highlighting" master switch must be on.'] },
      { h: 'Long command notifications', p: 'When a command you typed runs longer than the seconds in "Settings → Terminal → Alerts → Long command notification" (default 30 seconds, 0 = off), and the window isn\'t in the foreground or the tab isn\'t visible when it ends, a system notification shows the command, result, and duration; background tabs also get a green (success) / red (failure) dot.', tips: ['Relies on command status markers (bash 4.4 or later); commands the AI runs don\'t notify.', 'No notifications while the app is locked.'] },
      { h: 'Links', p: 'http / https URLs in the terminal are underlined on hover; hold Ctrl and click to open them in your system browser (a plain click doesn\'t open them, so selecting text won\'t open one by accident). Chinese characters and emoji display as double width, so the cursor stays aligned.' },
      { h: 'Export buffer', p: 'Right-click a terminal tab: "Export buffer as .txt…" saves the terminal\'s entire content (including what has scrolled off) as a text file, and "Copy entire buffer" copies it to the clipboard. Plain text only, no colors. How much can be exported depends on "Scrollback lines".' },
      { h: 'Command status markers', p: 'In bash terminals, a small dot appears at the start of each command line: green = success, red = failure, gray = unknown. Hover to see the exit code and duration. Ctrl+↑ / ↓ jumps between commands (same as VS Code).', tips: ['Requires bash 4.4 or later; injected automatically into local Git Bash and SSH connections, changing only variables of the current session, not config files.', 'Only the last 200 commands on the main screen are tracked (not inside vim / less), and commands the AI runs aren\'t marked.'] },
      { h: 'Actions on a single command', p: 'Click any dot (green or red) to open a menu:', steps: [
        '"Copy command", "Copy output": output has colors and other control characters removed; anything over 200KB keeps only the last part.',
        '"Run again": writes the command into the terminal and presses Enter. Dangerous commands on production terminals are confirmed again in the menu first; multi-line commands aren\'t supported.',
        '"Ask AI": puts the command, exit code, directory, and output into the chat input box (not sent automatically). Ask why a failed command failed, or have the AI review the result of a successful one.',
        '"Save as quick command": opens the quick command editor prefilled, saving into the current command group.',
        '"Add to runbook": appends to the end of an existing runbook or creates a new one; the step type (check / change) is detected automatically and can be changed.',
      ] },
      { h: 'Let the AI troubleshoot failed commands', p: 'When a command you typed fails (red dot), a banner appears at the bottom of the terminal: "✕ Command `xxx` failed (exit code N) — Let AI troubleshoot".', steps: [
        'Click "Let AI troubleshoot": sends the command, exit code, directory, and the tail of the output straight to the current chat (creating a session if there is none), moves focus to the chat box, and the AI starts analyzing.',
        'Click "×" on the right of the banner to dismiss it; later failures of the same command in the same terminal won\'t prompt again.',
        'The banner disappears automatically when the next command starts.',
      ], tips: [
        'Commands the AI runs and ones interrupted with Ctrl+C (exit code 130) don\'t prompt; requires command status markers (bash 4.4 or later).',
        'Before sending, "Redact before sending to AI" applies (on by default): passwords, tokens, etc. are replaced with `[redacted]`.',
        'Toggle it with "Suggest AI troubleshooting when a command fails" under "Settings → Terminal → Alerts" (on by default).',
      ] },
      { h: 'Write commands in natural language', steps: [
        'With focus in a terminal and an empty prompt, press Ctrl+I (same as VS Code terminal inline AI); an input box pops up at the cursor.',
        'Describe what you want, such as "find who is using port 8080", and press Enter.',
        'The AI generates a command for the current terminal\'s OS (Linux / macOS / Windows Git Bash) and fills it into the prompt without pressing Enter; check it, then press Enter yourself to run it. Esc cancels.',
      ], tips: [
        'Only your description, the terminal OS, the current directory, and whether it\'s a production host are sent to the model; nothing from the terminal is sent.',
        'Dangerous commands show a red "Dangerous command. Check it before pressing Enter".',
        'Unavailable when the input line already has content, inside full-screen programs like vim, while a command is running, or while the AI is using this terminal; the reason is shown.',
        'These calls also count toward "Usage" (source: "Other").',
      ] },
      { h: 'Character encoding', p: 'If Chinese text is garbled on an older server, change "Character encoding" in the SSH host form to GBK / GB18030 / Big5 (default UTF-8); it applies to terminals opened afterward. Running terminals can\'t switch; local terminals don\'t have this option.' },
      { h: 'Command history', p: '"Command history" in the terminal\'s right activity bar lists commands recorded by this app for that host (local terminals share one list). Double-click to fill one into the terminal without running it. Input typed while the cursor is at a password prompt from sudo / ssh / mysql etc. isn\'t recorded.' },
      { h: 'Command autocomplete', p: 'Off by default. After turning on "Command autocomplete" in "Settings → Terminal → Input", typing after the prompt in a local Git Bash or SSH terminal shows up to 8 suggestions below the cursor: the host\'s command history (frequent and recent first), quick commands, and a few built-in common commands (such as `systemctl status`, `journalctl -u`, `docker ps`, `tail -f`). Prefix matches come first, substring matches also work, and the matched part is highlighted.', steps: [
        '↑ / ↓ to select (intercepted only while the popup is shown; otherwise ↑ browses shell history as usual).',
        'Tab or → accepts: completes the rest (for substring matches, what you typed is deleted first and the whole command written) without pressing Enter; clicking an item works too.',
        'Esc closes it (it won\'t pop up again until your input changes); pressing Enter runs what you\'ve already typed.',
        'Shift+Delete removes the selected item from the host\'s command history (quick commands and built-in commands can\'t be deleted here).',
      ], tips: [
        'Relies on command status markers (bash 4.4 or later) to tell whether you\'re at the prompt; it doesn\'t pop up inside full-screen programs like vim, while a command is running (including password prompts), or while the AI is using this terminal.',
        'It doesn\'t pop up when you move the cursor back into the middle of the command to edit, or when the input is empty or only spaces. Not supported in PowerShell / cmd terminals.',
      ] },
      { h: 'Terminal appearance', p: '"Settings → Terminal → Appearance": font size, color scheme (default "Follow app theme": uses the terminal colors matching the current app theme; or fix it to Dark, Light, Solarized Dark, Dracula, One Dark, Monokai, GitHub Light, Tokyo Night, Nord, Solarized Light, or High contrast), font, line height, cursor style (block / underline / bar) and blinking, and scrollback lines (default 5000). There\'s a preview below; changes save automatically and apply to open terminals right away. You can also adjust the font size in the terminal with Ctrl+= / Ctrl+- / Ctrl+0.', tips: ['Enter the name of a monospace font installed on your system; fonts that aren\'t installed fall back to the built-in font.'] },
    ],
  },
  {
    id: 'hosts', title: 'Hosts and connections', icon: Server, settings: 'ssh',
    blocks: [
      { h: 'Manage saved hosts', p: '"Settings → Hosts & connections": on the right of the top toolbar are "New host" and "More" (Import hosts / Bulk edit / Bulk set credential); below are the "Hosts", "Credentials", "Port forwarding", "Auto-respond", and "Trusted host fingerprints" groups. Click a group title to collapse it (the state is remembered). The "Hosts" group has a search box (tags / address / user / group / notes), and hosts are collapsed by group, with hosts without a group under "Ungrouped". Each host card has port forwarding, edit, and delete buttons; clicking the card also edits it.', steps: [
        'Click "New host" and fill in the name, host address, port (default 22), and username under "Basic".',
        'Choose the auth method: password / private key (optionally with a passphrase) / ssh-agent / Pageant. For a private key, "Key source" can be a pasted private key or an app key managed in "Settings → SSH keys".',
        'Optional: group, tier (unlabeled / Test / Production), and notes (the AI reads them when working on this host). Expand "Advanced" to set a jump host (default "Direct (no jump host)"), outbound proxy, ProxyCommand, run after login, agent forwarding, keepalive, timeout, compression, terminal type, and character encoding. Hover the question mark next to each option for details.',
        'Use "Test connection" to make sure it works, then click "Connect" or "Save".',
      ], tips: ['Passwords and private keys are encrypted with the system keychain.', 'A host used as a jump host by other hosts can\'t be deleted.', 'Saved hosts can also be connected straight from the terminal "+" menu or the command palette (type `@` to search hosts).'] },
      { h: 'Import hosts (~/.ssh/config / Xshell / PuTTY / MobaXterm / SecureCRT)', p: 'Choose "More" → "Import hosts" at the top, pick the source at the top of the dialog, check items in the preview, and click "Import selected". Hosts that already exist (same address + port + username) are unchecked by default.', steps: [
        '"~/.ssh/config": lists hosts in the config (including ProxyJump jump hosts), marking private key / passphrase needed / private key missing / password to fill in. Wildcard Host entries aren\'t imported on their own.',
        '"Xshell": reads .xsh files under Documents\\NetSarang Computer\\<version>\\Xshell\\Sessions, using subfolders as groups; if they\'re not in the default location, click "Choose session folder…".',
        '"PuTTY": reads sessions PuTTY saved in the registry; you can also click "Choose .reg file…" to import a registry file exported elsewhere.',
        '"MobaXterm": reads bookmarks from MobaXterm.ini (SSH sessions only, folders as groups); for the portable edition, click "Choose MobaXterm.ini…".',
        '"SecureCRT": reads session .ini files under Config\\Sessions, using subfolders as groups.',
      ], tips: ['Sessions from other clients import only name, address, port, username, and group; passwords are never imported. After importing, edit them in the list to enter passwords, or switch to SSH keys.', 'Non-SSH sessions (Telnet / RDP / serial, etc.) are skipped automatically; hosts that already exist are skipped during import.'] },
      { h: 'SSH keys', p: '"Settings → SSH keys" manages the app\'s own keys: private keys (and passphrases) are encrypted with the system keychain and stored on this machine; the UI shows only name, type, fingerprint, and creation time.', steps: [
        '"Generate key": enter a name, choose ED25519 (recommended) or RSA 4096 (compatible with older servers), and an optional passphrase; or "Import private key" to pick an existing private key file (OpenSSH / PEM / PuTTY .ppk; enter the passphrase if it has one).',
        'Buttons on each key card: Copy public key, Export public key, Export private key, Delete, and "Deploy".',
        '"Deploy": expands a deploy panel below the card. Pick a saved host and click "Deploy" to connect with its current auth and append the public key to ~/.ssh/authorized_keys (not appended again if already present; the directory is created and set to 700 / 600 permissions automatically). This is recorded in the execution log. Production hosts ask for confirmation first.',
        'After a successful deploy, click "Switch this host to key auth": the connection is tested first and only switched if this key alone can connect; otherwise the host keeps its original auth.',
      ], tips: ['Keys in use by a host can\'t be deleted; change that host\'s auth method in "Hosts & connections" first.', 'Config export doesn\'t include app keys; after importing the config on another computer, hosts using app keys need their key chosen again.'] },
      { h: 'Credentials (shared accounts for multiple hosts)', p: 'When many hosts use the same account, save "username + password / private key / ssh-agent" as a credential and have the hosts reference it; change the credential\'s password once and every referencing host (including ones used as jump hosts) picks it up.', steps: [
        'In the "Credentials" group of "Settings → Hosts & connections", click "New credential", enter a name and username, choose the auth method, enter the password or private key (the private key can be an app key), and click "Save".',
        'Edit a host and choose "Use credential: <name>" from the "Auth method" dropdown; the username and auth follow the credential. Click "Save".',
        'To change several at once: "More" → "Bulk set credential" at the top, choose a credential, check the hosts, and click "Apply" (passwords / private keys those hosts saved individually are cleared).',
      ], tips: ['Credentials referenced by hosts can\'t be deleted; the hosts using them are listed.', 'Credentials are encrypted with the system keychain just like host passwords; config export exports them with "Hosts", including passwords / private keys only when an export password is set.', 'Passwords / private keys in credentials are also replaced with [redacted] before being sent to the AI and in diagnostic bundles.'] },
      { h: 'Host fingerprints', p: 'The first connection shows "First connection. Please confirm the host fingerprint". Compare it with the output of `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` on the server, then click "Trust and connect". If the fingerprint changes, the connection is refused with a warning; only after confirming the server was reinstalled / rekeyed, click "I confirm the server was reinstalled/rekeyed, update fingerprint", then reconnect manually.', tips: ['Trusted fingerprints are in the "Trusted host fingerprints" group of "Settings → Hosts & connections", where you can "Import from ~/.ssh/known_hosts" (plain-text entries only) or delete them.'] },
      { h: 'ssh-agent / Pageant', p: 'The ssh-agent auth method doesn\'t save any credentials; load keys with `ssh-add` first. Windows checks, in order, the OpenSSH Authentication Agent service, Pageant 0.75+, and a named-pipe `SSH_AUTH_SOCK` (Git Bash / cygwin unix sockets aren\'t supported); macOS / Linux use `SSH_AUTH_SOCK`. The form shows the detection result, and you can "Detect again".' },
      { h: 'Port forwarding and SOCKS5', p: 'In the "Port forwarding" group of "Settings → Hosts & connections", choose a host at the top right (saved hosts only); you can also click the two-way arrow button on a host card to jump here.', steps: [
        '"Local forwarding": this machine\'s 127.0.0.1:port → remote address:port (the remote address as seen from the SSH server, default 127.0.0.1).',
        '"Dynamic forwarding (SOCKS5)": listens on port 1080 by default; use it like `curl --socks5-hostname 127.0.0.1:1080 …`.',
        '"Remote forwarding" (ssh -R): the server listens on 127.0.0.1:port → local address:port, exposing a debug service on this machine to the server (access `127.0.0.1:port` on the server).',
        '"Start", "Stop"; saved forwards with "Auto-start" on start automatically when the app launches. They reconnect automatically after a disconnect.',
      ], tips: [
        'When SOCKS5 listens on 0.0.0.0, anyone on the LAN can use your SSH host as a proxy; only do this on trusted networks.',
        'Remote forwarding usually fails to start because of server limits: the port is in use, ports below 1024 need root, or `AllowTcpForwarding no` in sshd_config. For the server to listen on 0.0.0.0 you also need `GatewayPorts yes` or `clientspecified`; otherwise it still listens only on 127.0.0.1.',
      ] },
      { h: 'Run after login', p: 'Edit a saved host, expand "Advanced", and enter one command per line in "Run after login" (such as `cd /app && source env.sh`, `sudo -i`). They\'re sent to the terminal in order after connecting; you see the echo, and they aren\'t added to command history.', tips: [
        'They run every time a terminal opens and after reconnecting; for hosts with "Keep session after disconnect (tmux)" on, they run only when a new tmux session is created, not when reattaching to an existing one.',
        'They\'re sent to production hosts too, with a note while editing. Commands the AI runs don\'t go through them; but if a login command switches user or shell (such as `sudo -i`), the AI\'s later commands also run in the new shell.',
      ] },
      { h: 'Advanced: agent forwarding, keepalive, timeout, compression, terminal type', p: 'Edit a saved host and expand "Advanced".', steps: [
        '"SSH agent forwarding" switch (off by default): use keys from this machine\'s ssh-agent / Pageant for `git pull` on the server or for sshing on to other machines. Works with any auth method, as long as a local agent is running.',
        '"Keepalive interval" (seconds, 0 = off), default 15: lower it if connections drop after sitting idle (NAT / firewall).',
        '"Connection timeout" (seconds), default 20: raise it if the network is slow and connections fail.',
        '"Compression" switch: helps on slow links, but is actually slower on a LAN.',
        '"Terminal type" ($TERM), default xterm-256color (256 colors for remote vim / htop / ls). If a very old system reports unknown terminal or colors are garbled, change it to xterm, xterm-color, or vt100, or use "Custom…" (letters, digits, and . _ + - only). Takes effect after reconnecting.',
      ], tips: [
        'The risk of agent forwarding: while connected, root on the server can borrow your agent to log in to other machines (it can\'t get the private key itself). Only enable it for servers you trust.',
        'If the server forbids agent forwarding (`AllowAgentForwarding no`) or no local agent is detected, login works as usual and a note above the terminal says forwarding isn\'t active. Old panes reattached in a kept session (tmux) don\'t get the new forwarding.',
        'Keepalive / timeout / compression apply to this host\'s terminals, port forwarding, and file transfers; as a jump host it uses its own settings.',
      ] },
      { h: 'Keep session after disconnect (tmux)', p: 'Use it for long tasks (backups, builds, data imports) that you don\'t want an SSH disconnect to interrupt: commands run in a tmux session on the server, unaffected by disconnects, reconnects, or app restarts, and you pick up the output when you come back.', steps: [
        'Edit a saved host and turn on "Keep session after disconnect" (off by default). Applies to newly opened terminals.',
        'After a disconnect, click "Reconnect" or wait for auto-reconnect to reattach to the same session; after an app restart it reattaches automatically based on the layout.',
        'When closing the tab: an idle session ends right away; if tasks are still running in the background you\'re asked "Close and end / Close but keep on server / Cancel".',
        'Kept sessions: right-click a terminal tab for this host, choose "N kept sessions on server", and click one to reattach in a new tab.',
      ], tips: [
        'The server needs tmux 1.8 or later; if it\'s missing or too old, or the host uses a non-UTF-8 encoding such as GBK, you\'re told and a regular session is used instead.',
        'Scrollback is kept by tmux, so the terminal only has output from after reattaching; the mouse wheel can\'t scroll tmux history, so use tmux\'s own copy-mode.',
        'Command status markers need tmux 3.3 or later to show reliably. When the AI runs commands in these terminals, you\'ll see its wrapper command on screen; this is normal.',
      ] },
      { h: 'Two-factor authentication (OTP / bastion hosts)', p: 'When the server requires keyboard-interactive auth (Google Authenticator codes, JumpServer and other bastion prompts), an "SSH two-factor authentication: host name" dialog appears with the server\'s instructions and one input per prompt (prompts the server marks as no-echo are password fields). Fill them in and click "OK".', tips: [
        'Only password prompts like "Password:" are answered automatically with the saved password; codes and other prompts ask you every time and aren\'t saved. If an auto-answered password is rejected and asked again, the dialog appears too.',
        'Temporary background connections such as batch run, multi-host compare, and file transfers show the dialog as well, with the host named in the title; multiple hosts queue up one by one.',
        'Clicking "Cancel" or not responding for about 3 minutes fails this connection. Unattended connections such as scheduled inspections don\'t show the dialog and fail right away.',
      ] },
      { h: 'Outbound proxy (HTTP / SOCKS5)', p: 'Use it when your company network requires a proxy to reach the internet. In "Settings → Network proxy", turn on "Use proxy for outbound", choose SOCKS5 or HTTP CONNECT, enter the proxy address and port, and a username and password if needed (saved automatically; the password saves when you leave the field, and invalid addresses or ports aren\'t saved). All new SSH connections after that (terminals, batch run, file transfers, port forwarding, etc.) go through it.', steps: [
        'Per-host override: edit the host in "Hosts & connections", expand "Advanced", and set "Outbound proxy" to "Follow global default" / "No proxy" / "Custom".',
        '"Test connection" tests with the proxy selected in the form.',
      ], tips: [
        'The proxy password is encrypted with the system keychain; leave the password empty while editing to keep it unchanged. Turning off "Use proxy for outbound" clears the saved proxy (including the password).',
        'Hosts reached through a jump host don\'t use the proxy (traffic goes through the jump tunnel); the jump host\'s own proxy setting applies.',
        'An HTTP proxy must support CONNECT and allow ports such as 22. When it can\'t connect, the error says whether the proxy was unreachable, authentication failed, or the proxy refused to connect to the target.',
      ] },
      { h: 'Auto-reconnect after disconnect', p: '"Settings → General → Connection → Auto-reconnect SSH", off by default. When on, it backs off 2s / 5s / 10s / 30s…, up to 8 attempts; the banner at the top of the terminal offers "Reconnect now" or "Cancel". A remote `exit` or closing the tab doesn\'t reconnect. If reconnecting fails, "Reconnect" on the banner lets you try again manually.' },
      { h: 'Host panel', p: 'Click the "Hosts" button on the left of the title bar (or Ctrl+Shift+H, or search "Open host panel" in the command palette) to pop up the host panel at the top left without taking up the terminal area. At the top are "Favorites" and "Recent" (last 10 hosts); below, all hosts are listed by group, with search at the top (Enter connects to the first host shown).', steps: [
        'Double-click / Enter to connect: if the host already has an open terminal it switches there, otherwise it opens a new one (disconnected terminals don\'t count and reconnect).',
        '"+" at the top right of the panel opens the new host form in "Settings → Hosts & connections" directly (connections with "Save as host" checked can also get there from the "+" menu).',
        'Keyboard: press ↓ in the search box to enter the host list, ↑↓ to move, Enter to connect, Shift+F10 / the Menu key to open the context menu.',
        'Right-click a host: "Connect", "Connect in new tab" (always opens another), "Favorite", "Edit" (opens "Settings → Hosts & connections"), and "Duplicate host" (copies it along with credentials and host rules; the label gets "copy"). The star at the start of a row also adds a favorite.',
        'Hover a group title for "Open whole group", or right-click the group: opens a terminal for each host, automatically split side by side / three columns / 2×2 grid for 2–4 hosts. If the group has more than one production host, you\'re asked to confirm first.',
      ], tips: [
        'The end of each row shows latency: the time for a TCP connection to the host\'s SSH port (connect only, no login), measured once a minute while the panel is open. Green < 100ms, yellow < 300ms, red slower or "Unreachable"; hosts behind a jump host / ProxyCommand show "Via jump host" / "Via proxy" and aren\'t measured; hosts whose address changes are measured again. The waveform button at the top right of the panel turns off latency probing.',
      ] },
      { h: 'Workspaces', p: 'Save the currently open terminals and split layout as a named workspace, e.g. "Order system" = 3 app servers + 1 database in a 2×2 grid, and open it in one click later.', steps: [
        'Open the terminals you need and arrange the split first, then switch to the "Workspaces" page in the host panel, click "Save current layout as workspace", and enter a name (the same name overwrites). The command palette also has "Save current layout as workspace…".',
        'To open: double-click or click the play button on the "Workspaces" page, or search "Open workspace" in the command palette. Each terminal is added as a new tab (SSH reconnects automatically) and arranged in the saved split; ones that fail to connect are listed at the top of the terminal area.',
        'Hover a workspace to rename or delete it; deleting doesn\'t affect open terminals or saved hosts.',
      ], tips: ['Temporary SSH connections (not saved as hosts) aren\'t stored in workspaces; tab colors and custom tab names are saved too.'] },
      { h: 'Bulk edit hosts', p: 'For data center moves, jump host address changes, or bulk changes to port / username / group / production tag, without editing hosts one by one. "Settings → Hosts & connections", "More" → "Bulk edit" at the top.', steps: [
        'Check the items to change and enter new values: address (find → replace with, plain text, e.g. `10.1.` → `10.8.`), port, username, jump host (can be set back to "Direct"), group (empty = clear group), and tier.',
        'Check hosts, or use "Select all hosts using jump host…" to select every host behind the same jump host at once, then click "Preview changes".',
        'The preview shows old value → new value for each host; hosts that can\'t be changed are marked "Skipped" with the reason. When it looks right, click "Confirm changes (N hosts)". Changing the tier to Production asks once more.',
        'Made a mistake: "Undo last bulk edit" above the list sets the fields changed that time back to their original values (other changes made since are kept).',
      ], tips: ['Credentials such as passwords / private keys aren\'t changed; hosts using a credential don\'t get their username changed (change it in the credential).', 'Before each run, host config is backed up automatically to config\\backups\\hosts-<time>.json in the data directory.', 'Hosts whose jump chain would loop or exceed 2 levels skip the jump host change; hosts with a ProxyCommand can\'t also have a jump host.'] },
      { h: 'ProxyCommand', p: 'Connect to SSH through a local command, like OpenSSH\'s ProxyCommand: Cloudflare Access, AWS SSM, Teleport, `ssh -W` jump hosts, etc. Edit the host, expand "Advanced", and enter the command in "ProxyCommand", such as `cloudflared access ssh --hostname %h` or `aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p`.', steps: [
        '`%h` is replaced with the host address, `%p` the port, `%r` the username. On Windows it runs through cmd, so the command must run directly from the local command line.',
        '"Test connection" tests with the command in the form; when it can\'t connect, the error includes the command\'s error output.',
      ], tips: ['Mutually exclusive with a jump host or a custom outbound proxy; the global default proxy doesn\'t apply to these hosts.', 'When the connection closes, the command process (and the child processes it started) is terminated.', 'When importing from ~/.ssh/config or a config file, hosts with a ProxyCommand are shown in red with "Will run a local command"; make sure the command is trustworthy before importing.'] },
      { h: 'Open ssh:// links', p: 'Click links like `ssh://root@10.0.0.5:22` in CMDB, monitoring alerts, wikis, and other web pages to connect right in the LingShell window that\'s already open.', steps: [
        'If the link\'s address + port (and username, if included) match a saved host: an "Open SSH link" confirmation appears; click "Connect" to open a new terminal.',
        'If not: "New connection" opens prefilled with the address, port, and username; fill in the auth and click "Connect" yourself.',
      ], tips: ['Only the address, port, and username are used; passwords, commands, and parameters in the link are always ignored.', 'Off by default: after turning on "Settings → General → Connection → Open ssh:// links", the installed version registers itself as the system handler for ssh:// (replacing the previous ssh:// handler, such as PuTTY); turning it off unregisters it. The development version doesn\'t register.'] },
    ],
  },
  {
    id: 'files', title: 'Files', icon: FolderTree,
    blocks: [
      { h: 'Explorer', p: 'Two entry points: "Explorer" in the chat area\'s left activity bar browses local files (root = the session working directory); "Explorer" in the terminal\'s right activity bar browses the remote host over SFTP for SSH terminals (root = the terminal\'s current directory) and local files for local terminals. The command palette also has "Open Explorer".', steps: [
        'Click a folder to expand it; double-click a file to open it in the editor (images / Markdown / CSV / PDF open in preview, see "File preview"). Ctrl-click and Shift-click to select multiple items.',
        '"New file" and "New folder" are at the top; right-click for "Rename" (or F2) and "Delete" (or Delete; folders are deleted with their contents). Local deletes go to the Recycle Bin; remote deletes can\'t be undone, and production hosts ask for confirmation in red.',
        'Hover or right-click: "Upload to server" for local files, "Download to local" for remote files (multi-select and whole folders supported); local files can also "Open with system app". You can drag files from your system straight into a remote folder to upload them.',
        'Edit the path bar and press Enter to jump; "Up one level" goes to the parent folder; right-click a folder and choose "Set as root" to make it the root.',
      ], tips: ['The root folder and its direct children (such as /etc) can\'t be deleted or renamed.'] },
      { h: 'File properties and permissions (remote)', steps: [
        'Hover a remote file to see its permissions, owner, size, and modified time; "Show permissions/size columns" at the top keeps size and octal permissions visible on the right of each row.',
        'Right-click "Change permissions…" ("Change permissions of N items…" for multiple): check read / write / execute, or type an octal value (such as 755); both stay in sync.',
        'When the selection includes folders, you can check "Apply recursively to all files and subfolders", same as `chmod -R`. Production hosts show one more warning in red.',
      ], tips: ['Every change is recorded in "Execution log" (Change permissions). The root folder and its direct children can\'t be changed recursively.'] },
      { h: 'Compress and extract (remote)', steps: [
        'Right-click "Compress to tar.gz" to create `name.tar.gz` in the same folder; with several items in the same folder selected, "Compress N items to tar.gz" names the archive after the folder. Name clashes become `name (1).tar.gz`.',
        'Right-click a .tar.gz / .tgz / .tar / .zip and choose "Extract here" to extract into the archive\'s folder. Existing files with the same name aren\'t overwritten.',
      ], tips: ['Runs tar / unzip on the server (in a separate channel, nothing is typed into the terminal) and is recorded in "Execution log" (Compress / Extract). If unzip isn\'t installed on the server you\'ll be asked to install it. Large files can take a while; progress shows at the bottom.'] },
      { h: 'Folder bookmarks', p: 'The "Folder bookmarks" button at the top opens the bookmark list: "Bookmark current folder", click a bookmark to jump there, hover and click × to remove it. You can also right-click a folder and choose "Add bookmark". Bookmarks are saved per host and persist across restarts.' },
      { h: 'Search by name (remote)', steps: [
        'Click "Search by name" at the top, type a file name and press Enter: searches recursively under the current root, case-insensitive, with * ? wildcards; without wildcards it matches names that contain the text.',
        'Click a result to reveal and select it in its folder; double-click a file to open it, or a folder to enter it.',
      ], tips: ['Searches up to 6 levels deep and shows up to 500 results; stops after 20 seconds and shows what was found so far. Runs find on the server, read-only.'] },
      { h: 'Quick filter', p: 'The filter box under the path bar (Ctrl+F to focus, Esc to clear) filters the current list as you type, for both local and remote. Case-insensitive "contains" matching, with * ? wildcards (such as `*.log`). Matches are highlighted; non-matching items in expanded folders are hidden, but parent folders of matches stay.', tips: ['Only filters content that\'s already expanded and loaded, without contacting the server; collapsed folders aren\'t searched. To search the whole tree on a remote host, use "Search by name" (clicking it in the filter hint carries the filter text over). The filter clears when you change folders.'] },
      { h: 'Edit files', p: 'Double-click a file in Explorer to open the editor. Press Ctrl+S or "Save" to see a diff in "Confirm changes"; the original file is backed up automatically before saving and can be restored from "Execution log". The file\'s line endings are preserved, and saving is refused if another program changed the file after you opened it.', steps: [
        'Syntax highlighting: Shell, conf / ini (including systemd units), nginx, YAML, JSON, XML, Dockerfile, SQL, Python, and common code are colored automatically; only colors change, not glyphs. Files over 300KB aren\'t highlighted.',
        'Title bar buttons: "Find / Replace" (Ctrl+F / Ctrl+H, match case, whole word, replace all), "Go to line" (Ctrl+G), "Show whitespace", "Check invisible / suspicious characters", and "Word wrap".',
        'Suspicious characters: BOM, zero-width characters, non-breaking spaces, full-width spaces, and control characters are marked in red; the status bar shows the count, and clicking it jumps to the next one. "Clean up" removes them along with full-width / non-breaking spaces and trailing whitespace (Ctrl+Z to undo).',
        'Status bar: line, column, and selection length; indentation (click to switch Tab / 2 spaces / 4 spaces); line endings (click to switch LF / CRLF, used when saving); file type. It also warns about trailing whitespace, mixed indentation, mixed line endings, and BOM.',
        'Editing shortcuts: Tab / Shift+Tab indents selected lines, Enter keeps indentation, Ctrl+/ toggles comments, Alt+↑↓ moves lines, Shift+Alt+↓ duplicates a line, Ctrl+Shift+K deletes a line; all can be undone with Ctrl+Z.',
        'Pre-save check: JSON / YAML syntax errors show the line number; you can jump there or "Save anyway".',
      ], tips: ['Files over 2MB, binary files, or files with a mismatched encoding can\'t be opened.', 'These aids only change the editing experience and never modify file content on save (except "Clean up", which can be undone).'] },
      { h: 'Upload', steps: [
        'Click "Upload to server" on a local file to open the "Upload to server" dialog.',
        'Pick a saved host on the left and a remote folder on the right.',
        'Choose "Encrypted upload (recommended)" or "Unencrypted" (the default is "Encrypt uploads by default" under "Settings → General → File transfer"), then click "Start upload".',
      ], tips: ['Flow: tar locally → when encrypted, AES-256-CBC with a one-time random password → transfer → the remote decrypts with `openssl` and extracts to the target folder → the temporary archive is deleted. The remote host needs openssl; you don\'t have to enter a password.', 'Track progress in the "Transfers" panel (see below).'] },
      { h: 'Download', p: 'Click "Download to local" on a remote file or folder ("Download N items to local…" for multiple), choose a local folder, and it downloads over SFTP. Folder structure is kept, and local name clashes are renamed automatically. Downloads can be paused and resumed; for large folders, "Compress to tar.gz" first and download that, which is faster.' },
      { h: 'Open in local editor (remote)', steps: [
        'Right-click a remote file and choose "Open in local editor": it\'s downloaded to a local temp folder and opened with the system default app. To always use VS Code, Notepad++, etc., set `code` or a program path in "External editor" under "Settings → General".',
        'When you save in the editor, the file is uploaded back to the server within seconds. The original is backed up first and recorded in "Execution log" (External edit upload) so it can be restored; results show as system notifications.',
        'If someone changed the file on the server after you opened it, you\'re asked before upload: "Overwrite", "Save as copy" (uploads a copy in the same folder with "(local edit)" in its name), or "Discard".',
        'Production hosts confirm before every upload; you can check "Don\'t ask again while editing".',
      ], tips: ['Closing that terminal or quitting the app stops watching and deletes the temp file; later saves won\'t upload. Files over 20MB ask first; the maximum is 200MB.'] },
      { h: 'Follow terminal folder', p: 'Explorer opened from a terminal has a "Go to terminal\'s current folder" button and a "Follow" toggle to the right of the path bar. When on, running cd in the terminal makes Explorer jump to the same folder (requires bash; syncs each time a prompt appears). The toggle is remembered.' },
      { h: 'Drag files onto a terminal', steps: [
        'Drag files or folders from your system onto an SSH terminal: the "Upload to server" dialog opens with the target folder prefilled as that terminal\'s current folder; confirm to upload.',
        'Drop onto a local terminal to insert quoted file paths at the cursor (no Enter); multiple files are separated by spaces.',
      ], tips: ['Ad-hoc SSH connections (not saved as hosts) don\'t support upload.'] },
      { h: 'Dual-pane file manager (WinSCP-style)', p: 'Local on the left, this server on the right; each pane is a full Explorer. Open it from the "Dual-pane file manager" icon (two panes with an arrow between them) in the title bar of an SSH terminal\'s Explorer.', steps: [
        'Drag between panes to upload / download (into the drop target folder); the → / ← buttons in the middle send the selection to the other pane\'s current folder; right-click also offers "Upload to right pane / Download to left pane".',
        'Uploads check for name clashes first: Overwrite / Skip / Keep both (encrypted uploads only Overwrite / Skip), and production hosts confirm once more. Downloads rename clashes automatically and never overwrite local files.',
        'Both panes refresh after transfers; the local pane remembers its last folder; the pane you click is highlighted; Esc closes.',
      ], tips: ['Dragging onto a folder in the same pane moves the item; dropping an item onto itself is ignored.'] },
      { h: 'sudo mode (view and edit folders / files you lack permission for)', p: 'In an SSH host\'s Explorer title bar, choose "View" (slider icon) → "Operate as root (sudo)", or click "Use sudo" / "Open with sudo" on a folder or file you don\'t have permission for. A red sudo badge appears in the title bar; click it to exit.', steps: [
        'Once on, listing, editing, creating, renaming, deleting, changing permissions / owner, and copy-paste all run on the server through sudo, marked [sudo] in the execution log.',
        'Passwordless sudo is tried first; if a password is needed, "Enter sudo password" appears. The password is passed to sudo via stdin (never on the command line) and kept only in local memory until you close the app.',
        'Use "Open with sudo" when opening a file is denied, and "Save with sudo" when saving is denied; your edits are kept, and the file\'s owner and permissions are preserved.',
      ], tips: ['Windows servers (built-in OpenSSH) don\'t show sudo. After exiting sudo, folder listings are re-read as the regular user.'] },
      { h: 'Windows servers (built-in OpenSSH)', p: 'When you connect to a Windows server with OpenSSH enabled, Explorer recognizes it from the SFTP home folder (like `/C:/Users/name`): the root lists drives and common locations, and copy / paste / duplicate / move, folder size, checksums, and search by name all run over SFTP.', tips: [
        'Change permissions / owner, compress / extract, live view, search by content, sudo, and encrypted upload are hidden (or explained) on these hosts; uploads can only be "Unencrypted (direct)".',
        '"Open in terminal" uses cmd: `cd /d "C:\\path"`.',
      ] },
      { h: 'Transfer queue', p: 'Uploads and downloads (including ones started by AI) share one queue. By default 2 run at once and the rest wait; change the number in "Concurrent transfers" under "Settings → General → File transfer". A floating badge at the bottom right shows "N transfers in progress · percent". Click it, or the "Transfer queue" button (up/down arrows icon) at the bottom of the terminal\'s right activity bar, to open the "Transfers" drawer at the bottom of the terminal area (it doesn\'t cover the chat or the upper part of the terminal; click the button again, click ×, or press Esc to close).', steps: [
        'The panel lists each task: Queued / In progress / Done / Failed / Canceled. In-progress tasks show bytes transferred, file count, speed, and time remaining.',
        'Unencrypted uploads and Explorer downloads can be "Paused" and "Resumed" from where they stopped; click "Retry" on failed / canceled tasks (resumable ones continue from the break point, others restart). Encrypted uploads can\'t be paused.',
        'If the target already has an item with the same name, choose "Overwrite / Skip / Keep both" before upload (encrypted uploads only have Overwrite / Skip). Multi-select encrypted uploads create one task per file, all queued at once.',
        'For queued tasks (when two or more are waiting), "Transfer first" moves it to the front so it starts next; the up / down arrows next to it reorder one step at a time. Queued tasks are listed in order below the in-progress ones, with status "Queued · #N"; running tasks aren\'t affected.',
        'For finished downloads, click "Open containing folder"; for finished uploads, "Reveal in Explorer" switches to that host\'s terminal and opens Explorer at the target folder (requires an open terminal for that host).',
        '"Clear completed" removes finished tasks.',
      ], tips: ['"Transfer speed limit" under "Settings → General → File transfer" (KB/s, 0 = unlimited) applies to each task, and changes take effect immediately on running tasks. Finished tasks persist across restarts (marked "History").', 'The remote "decrypt and extract" step of an encrypted upload can\'t be canceled, so a half-extracted folder is never left behind.', 'If transfers are still running when you close the window or quit, you\'re asked to confirm; "Quit anyway" aborts all transfers.'] },
      { h: 'Compare and sync folders (local ⇄ remote)', p: 'For publishing front-end static assets or syncing config folders: compare a local folder with a remote one and transfer only the files that differ.', steps: [
        'In Explorer (SSH), right-click a remote folder and choose "Compare/sync with local folder…", or search "Folder sync" in the command palette.',
        'Choose the remote terminal, enter the remote and local folders ("Choose…" opens a folder picker), adjust "Exclude rules" if needed (default `.git, node_modules`), and click "Compare".',
        'The results table lists "Local only / Remote only / Different / Same" (different size, or modified times more than 2 seconds apart, counts as different; with "Compare by content (sha256, slower)" checked, same-size files are compared by content too). By default "Differences only" is on and all differing items are checked; checking a folder checks everything under it.',
        'Choose a direction at the bottom: "Local → Remote (upload)", "Remote → Local (download)", or "Both ways (newer wins)"; check "Mirror deletes" if needed (deletes extra items on the target, off by default).',
        'Click "Build sync plan" to review the upload / download / delete counts and lists, then "Start sync". You can "Cancel" while it runs; it re-compares automatically when done.',
      ], tips: [
        'Files are transferred one by one over SFTP, without archiving or encryption. Each file is written to a temp file first and then swapped in, so canceling or failing never leaves a partial file. Modified times are set to the source\'s afterwards, so the next compare shows "Same".',
        'Mirror deletes are confirmed in red: remote deletes can\'t be undone, local deletes go to the Recycle Bin, and folders are only deleted when empty. Production hosts require checking a confirmation before starting. The root folder and its direct children can\'t be mirror-deleted.',
        'Up to 10,000 items and 32 levels at a time; beyond that, narrow the folder or add exclude rules. Symlinks and items that are a file on one side and a folder on the other aren\'t synced. Syncs that change the remote are recorded in "Execution log" (Folder sync).',
      ] },
    ],
  },
  {
    id: 'compare', title: 'Compare files across hosts', icon: GitCompare,
    blocks: [
      { p: 'For tracking down "why is this one different from the others": compare the same config file on several hosts against a baseline, one by one. Read-only; no files are changed.' },
      { steps: [
        'Click "Compare files across hosts (read-only)" in the terminal\'s right activity bar, or search "Compare files across hosts" in the command palette, to open the "Compare files" window. It opens on the "Line diff across hosts" tab (the other tab, "Key comparison between two sides", is covered in "Compare config keys").',
        'Check 2–6 hosts (this machine, saved hosts, online SSH terminals) and use the dot on each row to choose the baseline.',
        'Enter a remote path or pick a common one (such as `/etc/nginx/nginx.conf`, `/etc/hosts`); check "Ignore whitespace and comment lines (starting with # / ;)" if needed.',
        'Click "Start compare". The summary table shows each host as: Baseline / Same / Different +N −M lines / Read failed (with reason). Click a "Different" row to see its diff against the baseline below.',
      ], tips: [
        'Saved hosts without an open terminal are connected temporarily and disconnected when done (first connections still confirm the fingerprint as usual).',
        'Each file is limited to 1MB, and binary files aren\'t compared; a missing file, missing permission, or failed connection only affects that host.',
        'Files are decoded with each host\'s character encoding setting, so Chinese config on GBK hosts compares correctly too.',
      ] },
    ],
  },
  {
    id: 'batch', title: 'Batch run', icon: Layers,
    blocks: [
      { p: 'Run the same command on several hosts (check versions, disk usage, whether a process is running) and collect the results in one table. Commands run in a separate channel; they aren\'t typed into your terminal or added to command history.' },
      { steps: [
        'Click "Batch run" in the terminal\'s right activity bar, or search "Batch run" in the command palette.',
        'Check hosts: saved hosts are listed by group, and the checkbox before a group name selects the whole group; online SSH terminals that aren\'t saved form their own group; this machine is optional.',
        'Enter the command (multiple lines allowed), adjust "Timeout (s)" (default 30) and "Concurrency" (default 5) if needed, and click "Start".',
        'The table shows each host\'s status (Running / Succeeded / Failed (exit code) / Timed out / Connection failed), duration, and first line of output; click a row to expand the full output (stdout and stderr combined, up to 200KB per host).',
        'Hosts with identical output show "N hosts with same output"; check "Differs from majority" to see only the odd ones out, then expand one and click "Compare with majority" to see the diff.',
        '"Copy as Markdown" and "Copy as TSV" copy the whole table (TSV pastes straight into Excel); "Rerun failed only" reruns just the failed / timed-out / connection-failed / canceled hosts; click "Cancel" while running.',
      ], tips: [
        'A yellow notice appears when production hosts are selected; running a dangerous command (such as rm -r, reboot) on production hosts shows a red confirmation listing the production hosts involved.',
        'Saved hosts without an open terminal are connected temporarily and disconnected afterwards (first connections still confirm the fingerprint as usual); hosts with an open terminal reuse its connection.',
        'Every command run on each host is recorded in "Execution log" (marked "Batch run", with exit code).',
        'A timeout or cancel only closes the channel; on some servers the remote command may still finish in the background.',
      ] },
      { h: 'Run in batches (rolling release / canary)', p: 'For releases or config changes you don\'t want to push everywhere at once: turn on "Run in batches (rolling release / canary)" under the command box to advance batch by batch, with a health check after each batch and an automatic stop on problems.', steps: [
        'Enter the host count in "Per batch", or switch it to "%" on the right for a percentage (rounded up, at least 1 host); the line next to it shows "N hosts in K batches: …" live. Batches are cut in host list order.',
        '"Pause after the first batch (canary) until I confirm" is checked by default: after the first batch, the progress area shows "Batch 1 (canary) done". If the output looks fine click "Continue to next batch", otherwise "Abort".',
        '"Health check after each batch": choose "Command (exit code 0)" and enter a command (such as `systemctl is-active myapp`), or "URL (expect 200)" and enter an address (such as `http://127.0.0.1:8080/health`, checked with curl, or wget if curl is missing). It runs on every host in the batch that succeeded; failures are retried "Retries" times every "Interval" seconds, and a host still failing counts as failed.',
        '"When a host fails": "Stop" = if any host in this batch fails its command or health check, later batches don\'t run (marked "Canceled"); "Skip it and continue" = failed hosts are marked "Skipped" and the next batch runs. Even with skip, it stops when an entire batch (2+ hosts) fails or cumulative failures exceed 30% of all hosts.',
        'Click "Start batch run". The progress area shows each host\'s status, health check result, and first line of output by batch; click a row to expand the full output. You can "Abort" at any time.',
        'If you filled in "Rollback command (optional)", "Run rollback on executed hosts (N)" appears when the run ends (finished / stopped / aborted). It runs on hosts where the command actually ran (including "Aborted midway" hosts), after a confirmation listing the hosts and command (in red when production hosts are included; timed-out or aborted-midway hosts get a separate note that the remote command may still be running). Each run can be rolled back only once.',
      ], tips: [
        'The red confirmation for dangerous commands on production hosts happens once at the start and covers all batches; it appears if either the main command or the health check command matches a dangerous pattern, and lists both commands.',
        'Each host\'s command, health check, and rollback are recorded in "Execution log", marked "Batch run · batch k", "Batch run · batch k health check", and "Batch run · rollback", with exit codes.',
        '"Copy as Markdown" prefixes each host with its batch number. Pressing Esc or × while running asks first: closing means aborting, and the progress table and rollback entry disappear with it.',
      ] },
    ],
  },
  {
    id: 'docker', title: 'Containers (Docker)', icon: Container,
    blocks: [
      { p: 'View Docker containers and logs on SSH hosts, shell into containers, or start / stop them. Works with Linux / macOS SSH terminals; local terminals show this machine\'s Docker (see "Local views"). The top of the drawer can switch to the "Compose projects" tab.' },
      { steps: [
        'Switch to an SSH terminal and click "Containers (Docker)" in the right activity bar, or search "Containers" in the command palette.',
        'The list shows name, image, status, ports, and created time; click the "CPU / Memory" icon to sample resource usage once (about 2 seconds), and "Refresh" to update the list.',
        'For each container: "Logs (last 200 lines)" to view; on the log page, "Follow in terminal" opens a new tab that keeps streaming. "Shell into container (new terminal tab)" uses bash if available, otherwise sh.',
        'Start / Stop / Restart require confirmation; on production hosts the dialog says "Production host". All three are recorded in the execution log (Container start / stop / restart, with exit code).',
        '"Compose projects" tab: lists projects from `docker compose ls` (status, config files). "Start (up -d)" starts with the original config files; running projects also have "Stop and remove (down)" and "Restart", all confirmed and recorded in the execution log. "Logs" shows the last 200 lines, and "Follow in terminal" on the log page opens a new tab running `docker compose logs -f`.',
      ], tips: [
        'Commands run in a separate channel and stay out of your terminal and command history.',
        'On a permission error (user not in the docker group): if the user has passwordless sudo, a "Use sudo -n docker" button appears; otherwise only an explanation is shown, and a password prompt never appears.',
        'Docker not installed or the Docker service not running is reported directly.',
      ] },
    ],
  },
  {
    id: 'processes', title: 'Process manager', icon: Cpu,
    blocks: [
      { p: 'View processes on SSH hosts (CPU, memory, RSS, uptime, state, command line) and end them when needed. Works with SSH terminals (except Windows hosts); local terminals show this machine\'s processes (see "Local views").' },
      { steps: [
        'Switch to an SSH terminal and click "Processes" (CPU chip icon) in the right activity bar to open the drawer on the right.',
        'Click a column header (PID / User / CPU% / Mem% / RSS / Uptime / State / Command) to sort, click again to reverse; the box above filters by command, user, or PID.',
        'Refreshes every 5 seconds by default: "Pause auto refresh" stops it, and the dropdown next to it changes the interval; "Tree view (by parent)" indents by parent-child relationship, and keeps ancestors of matching processes when filtering.',
        'Click a row to expand actions: "End (TERM)", "Reload (HUP)", and "Force kill (KILL)" need a red confirmation; production hosts also require typing the PID.',
        '"Copy command line" copies the full command; "Ask AI" puts the process info into the chat input (not sent automatically).',
      ], tips: [
        'Commands run in a separate channel and stay out of your terminal and command history; shows at most the top 500 processes by CPU.',
        'Every signal sent is recorded in "Execution log" (marked "Process signal", with PID, command line, and exit code). sudo is never used, so other users\' processes report a permission error.',
        'Minimal systems like busybox have no CPU% / Mem% columns and show "—".',
      ] },
    ],
  },
  {
    id: 'ports', title: 'Listening ports and one-click forwarding', icon: EthernetPort,
    blocks: [
      { p: 'See TCP ports listening on an SSH host (Linux) and forward one to this machine with a click, so you can open the remote web service in your local browser (like the Ports view in VS Code). The button is hidden for Windows / macOS SSH hosts; local terminals show this machine\'s ports (see "Local views").' },
      { steps: [
        'Switch to an SSH terminal and click "Listening ports (forward to local)" (network port icon) in the right activity bar to open the drawer on the right, listing protocol, address, port, and process / PID. "Refresh" is at the top right, and the box above filters by port / address / process.',
        'Click "Forward to local" on a row to open a port on local 127.0.0.1 that forwards to that remote port. The local port matches the remote one by default; if it\'s taken, it tries +1 until free.',
        'Once it works, the row shows the local address (such as 127.0.0.1:8080); click it to "Open in browser". Click "Stop forwarding" when done.',
      ], tips: [
        'Temporary forwards aren\'t written to the host config and stop automatically when this terminal closes. Running forwards also appear in the list under "Settings → Port forwarding", where you can stop them.',
        'Forwarding opens a separate SSH connection (using this terminal\'s parameters) and doesn\'t affect the terminal itself; ports listening on 0.0.0.0 / :: are forwarded to the remote loopback address.',
        'The port list comes from `ss -ltnp`, falling back to `netstat -ltnp` on older systems without ss; commands run in a separate channel and stay out of the terminal and command history. Seeing other users\' process names requires root; otherwise the "Process" column shows "—".',
      ] },
    ],
  },
  {
    id: 'logs', title: 'Log viewer (tail -f)', icon: ScrollText,
    blocks: [
      { p: 'Follow server logs live in a panel at the bottom of the terminal area. Change filters, pause, or select a few lines and ask AI at any time. Only Linux / macOS SSH terminals are supported.' },
      { steps: [
        'Open: click the "Logs" icon in an SSH terminal\'s right activity bar, enter a file path and click "Open", or click a common path (/var/log/syslog, /var/log/messages, nginx access / error logs); enter a unit name (optional) and click "journalctl -f" for systemd logs. You can also right-click a remote file in Explorer → "Live view (tail -f)".',
        'The last 500 lines are shown first, then new lines keep appending (after log rotation it follows the new file automatically). "+" in the panel title bar opens another log, so several tabs can be open at once.',
        '"Pause" only stops the display; lines keep arriving in the background and the button shows how many are pending. "Resume" catches up in one go.',
        'Type keywords in the filter box (".*" toggles regex, "Aa" toggles case sensitivity); with "Matching lines only" on, only matching lines show; turn it off to show everything with matches highlighted.',
        'Click lines to select them (Ctrl for multiple, Shift for a range), then "Copy selected lines" or "Ask AI": the selected lines and the file path go into the chat input, not sent automatically.',
        '"Auto scroll": scrolling up stops following, scrolling back to the bottom resumes. "Max N lines" drops the oldest beyond the limit (default 10,000); "Clear" empties the current view; "Export current content as .txt" saves the lines currently shown.',
        'After "Collapse" in the title bar, logs keep being followed; click "Logs" in the right activity bar → "Show log panel" to bring it back. "Close all logs" or closing a tab stops following.',
      ], tips: [
        'Colors for ERROR / WARN etc. follow the "Keyword highlighting" rules and the terminal color theme.',
        'Read-only: commands run in a separate channel, stay out of the terminal and command history, and aren\'t recorded in the execution log. Closing a tab or disconnecting the terminal ends the remote tail process.',
        '"Ask AI" honors "Redact before sending to AI": when on, passwords, tokens, etc. are masked as `[redacted]` before going into the input.',
        'Up to 4 logs can be open at once per terminal (servers allow only 10 channels per connection by default). Files you don\'t have permission to read show tail\'s error in the panel.',
      ] },
      { h: 'Insights: group similar lines, time distribution, what happened in this period', p: 'Click "Insights" on the right of the log toolbar to open a sidebar on the right (the raw log on the left keeps scrolling; click again to collapse):', steps: [
        'Top row: current log line count, number of patterns, and ERROR / WARN line counts.',
        '"Time distribution": a bar chart by the timestamps in the log, with bucket size chosen automatically from 1 second to 1 day; red for errors, yellow for warnings, gray for others. Hover a bar to see its numbers. Click a bar to show only logs from that period, or drag to select a continuous range; the raw view on the left follows, a "Time: …" tag appears in the toolbar, and × there or in the sidebar clears it.',
        '"Group similar": replaces timestamps, numbers, IPs, UUIDs, hex, and numeric path segments with placeholders, merging lines with the same template into one "pattern" with count, level, and first → last time. Patterns with more errors come first; hover to see a sample line. When a time range is selected, only that range is counted.',
        'Click a pattern to show only those lines on the left (a "Pattern: …" tag appears in the toolbar; click again or × to cancel). "Ask AI" at the end of the row puts the pattern, count, and 3 most recent lines into the chat input, not sent automatically.',
        '"What happened in this period": sends the stats for the selected time range (if none, the last 5 minutes / 15 minutes / 1 hour / all from the dropdown, by log time), including level counts, time distribution, top patterns, and a few error samples, directly to AI as a message, asking it to summarize the main events, start time, peak, and likely causes.',
      ], tips: [
        'Recognized time formats: ISO 8601, syslog / journalctl (Oct 15 10:00:01), nginx / apache (15/Oct/2026:10:00:01 +0800), Python / Java logs, Tomcat, Kubernetes klog. Lines without a timestamp use the previous line\'s time; if the whole log has no timestamps, receive time is used.',
        'Levels: recognizes ERROR / WARN / INFO / DEBUG, [error], level=warn, and similar; access logs use status codes (5xx = error, 4xx = warning); otherwise keywords like error / exception / failed decide. Java stack "at …" continuation lines aren\'t counted separately.',
        'Stats cover only the lines kept in the panel ("Max N lines"); dropped lines aren\'t counted. Samples sent to AI honor "Redact before sending to AI".',
      ] },
      { h: 'Multi-host logs: merge several hosts into one stream', p: 'When one service runs on several machines, there\'s no need to switch between tabs. Search "Multi-host logs" in the command palette, or click "Logs" in an SSH terminal\'s right activity bar → "Multi-host logs / history search…", and choose "Live merge" at the top of the dialog:', steps: [
        'On the left, pick the log source: "Log file" with a path (same path on every host), or "journalctl" with a unit name (optional). On the right, check hosts (saved hosts by group, online unsaved SSH terminals in their own group, up to 12; hosts without an open terminal connect temporarily).',
        'Click "Start merge": the log panel gets a new tab (with a stacked icon, labeled "N hosts · merged"). Each host runs its own tail -F / journalctl -f, lines are ordered into one stream by log time, and each line starts with a colored "[host name]".',
        'A row of host buttons sits under the toolbar: click one to hide that host\'s lines, click again to show them. If a host can\'t connect or its channel ends, its button turns red with the reason, and the others continue.',
        'Filtering, pause, insights, "Ask AI" on selected lines, and export work the same as for a single host; copy / Ask AI / export prefix each line with "[host name]".',
      ], tips: [
        'New lines are buffered about 1.5 seconds before being inserted by time, so slightly late but earlier lines from another host land in the right place. At the start it waits for every host to begin producing data (up to 5 seconds) before showing anything, so a slow host\'s history doesn\'t all end up at the bottom.',
        'Ordering uses the timestamp in each line; lines without one (such as stack continuation lines) follow the previous line from the same host. Times without a time zone are read in the local time zone, so ordering may not line up across hosts in different time zones.',
        'Read-only; stays out of the terminal, command history, and execution log. Closing the tab closes all channels and the remote tails exit. Up to 4 multi-host tabs can be open at once.',
      ] },
      { h: 'Log history search (including rotated .gz)', p: 'Search "Log history search" in the command palette, or switch to "History search" at the top of the multi-host logs dialog:', steps: [
        'Pick the log source and hosts (as above; a single host works too). For "Time range", choose the last 15 minutes / 1 hour / 6 hours / 24 hours / 7 days / any time, or "Custom…" with start and end times.',
        '"Keyword" is optional; check "Regex" to match by regular expression. Matching is case-insensitive by default (check "Match case" to change). "Max per host" N lines (default 500, the newest within the range).',
        'Click "Start search": the log panel opens an "N hosts · search" tab with results from all hosts merged by time and each line labeled with its host. The bottom shows "Search done: N lines"; click "Search again" to rerun. Each host button shows its line count; hover to see which files were searched and whether results were truncated.',
      ], tips: [
        'Log files: searches the current file and rotated files with the same name (such as app.log.1, app.log.2.gz, app.log-20261018.gz), oldest to newest by modified time. .gz files are read with zcat, and rotated files modified before the start time are skipped. .bz2 / .xz aren\'t supported, and skipped files are listed.',
        'journalctl: uses --since / --until for the time range, then filters by keyword.',
        'Each host returns at most 20,000 raw matching lines (the newest), which are then filtered precisely by time range locally. When the limit is hit, the host button warns "Earlier lines may be missing"; add a keyword or narrow the range. Each host has a 60-second limit.',
        'Time zones: when log lines have no time zone, they\'re parsed in that host\'s own time zone (`date +%z`), not the local one, so time ranges filter correctly even when the server is on UTC and your computer is on Beijing time.',
        'Regex runs remotely with `grep -E`: JS-style syntax like `\\d` `\\w` `(?:…)` isn\'t supported and is flagged right away (write `\\d` as `[0-9]`). Files you can\'t read show "Skipped … (no read permission)" and never mix into the results.',
        'Read-only: uses only ls / stat / cat / zcat / grep / tail / journalctl, changes no files, and isn\'t recorded in the execution log.',
      ] },
    ],
  },
  {
    id: 'usage', title: 'Usage', icon: BarChart3,
    blocks: [
      { p: 'Counts tokens for every model request and estimates cost from the prices you enter. It\'s a separate dialog, not part of settings.' },
      { steps: [
        'Click the bar chart icon "Usage" on the right of the title bar (or search "Open usage" in the command palette). Pick a range at the top: Today / 7 days / 30 days / All; "Refresh" recalculates.',
        '"Overview": cards for requests, input / cached / output tokens, and estimated cost, plus a daily tokens trend chart, source share, model share, and top 5 sessions; click any of them to jump to the detailed view.',
        '"By day", "By source", "By session", "By model": a chart on top (hover for values) and a detail table below; click headers to sort. In "By session", click a session name to open it.',
        'To see cost: in "Prices" on the left, choose a currency, enter input / cache hit / output prices (per 1M tokens) for the models you use, and click "Save prices".',
      ], tips: [
        'Prices are empty by default; official prices aren\'t built in (they change and discounts vary by provider). Without prices it shows "No price set".',
        'The small usage tag to the right of the model name at the top of the chat area shows this session\'s total tokens plus a context progress bar and percentage (yellow at ≥80%, red at ≥95%). Hover for context usage, requests, cache hits, and cost details; click it to open Usage.',
        '"By session" lists only the top 20 sessions by tokens; sources are Chat / Scheduled inspections / Other (one-off calls outside sessions, such as natural-language commands).',
        'Records are stored locally and kept for the last 180 days; prices are exported with "Export config".',
      ] },
    ],
  },
  {
    id: 'runbooks', title: 'Runbooks', icon: BookOpen, settings: 'runbooks',
    blocks: [
      { p: 'A runbook is a reusable multi-step checklist: each step has a title, a command (which can contain `{{params}}`), and an "Expected result". AI runs the steps in order, checks them against the expectations, and stops to ask you when something doesn\'t match.' },
      { h: 'Run', steps: [
        'Click "+" in front of the input box → "Runbooks" ▸ and pick a runbook (you can also search for it in the command palette).',
        'Fill in the parameters (placeholders show the defaults) and check the "Target terminals".',
        'Click "Send to AI to run".',
      ] },
      { h: 'Step types', tips: ['"Check": runs directly.', '"Change": goes through an execution plan first and runs only after you approve.'] },
      { h: 'Turn an operation into a runbook', steps: [
        'In the shield drawer\'s "Execution log", click "Save as runbook".',
        'Check the commands to keep (only successful ones are listed), then "Next".',
        'Enter the "Runbook name" and description; use "Replace values in commands with parameters" to turn IPs, paths, and user@host into parameters; adjust step order and types, then "Save".',
      ] },
      { h: 'Manage', p: '"Settings → Runbooks": create, edit, and delete runbooks, and import / export JSON to share them.' },
    ],
  },
  {
    id: 'schedules', title: 'Scheduled inspections and alert bots', icon: CalendarClock, settings: 'schedules',
    blocks: [
      { h: 'Scheduled inspections', p: 'Have AI check hosts in the background on a schedule. Results are saved as sessions, and you\'re notified when something is wrong.', steps: [
        '"Settings → Scheduled inspections" → "New inspection".',
        'Enter a name and what to inspect (you can "Fill from template…"; `{{host}}` is replaced with the target host name).',
        'Choose targets (local or saved hosts, multiple allowed) and timing: "Daily" at a set time, or "Every" 1–168 hours.',
        'Optional alerts: which bots to notify, and "Only on anomaly / failure / timeout" or "Every run".',
      ], tips: [
        'Inspections run at the read-only level: AI can only run read-only commands on the allowlist, and change commands are rejected automatically.',
        'Runs only while the app is running; runs missed while it was closed are made up once on the next launch.',
        '"Run now" on a row runs it once manually; click an entry in "Recent runs" to open its session.',
      ] },
      { h: 'Alerts (group chat bots)', steps: [
        'On the same page, click "Add bot" and paste the webhook URL (DingTalk / WeCom / Feishu / generic JSON are detected automatically; the default type is "Generic JSON", pasting a known platform URL switches it automatically, and you\'re asked to confirm when the URL looks like another platform than the selected type).',
        'DingTalk needs a "Signing secret" (starting with SEC), or set the bot\'s custom keyword to the Chinese word for "inspection" that alert messages contain; Feishu needs a "Signing secret" only if signature verification is on.',
        'A test message is sent automatically after saving; click "Send test message" to test again later.',
      ], tips: ['Bots are triggered only by scheduled inspections.'] },
      { h: 'Watchdogs (alert conditions in plain language)', p: 'Write an alert condition in one sentence (such as "nginx 5xx over 10 per minute", "/data usage over 90%", "mysqld process missing"). AI turns it into a read-only check script that runs in the background at an interval while the app is running.', steps: [
        '"Settings → Scheduled inspections" → "Watchdogs" → "New watchdog", write a sentence under "Condition", and click "Generate check script".',
        'Review the generated script (you can edit it): it should print one line with the current value, and exit with 0 = normal, 1 = triggered, anything else = check failed. It can be saved only when "Read-only check passed" shows under the script; scripts with write operations can\'t be saved.',
        'Choose hosts (this machine or saved hosts, multiple allowed) or groups (all hosts in the group), a "Check interval" (every 1 / 5 / 15 / 60 minutes), and how many "Consecutive triggers" before alerting (default 1).',
        '"Open an AI troubleshooting session when triggered" is on by default: when triggered, a new session is created with the message "Watchdog "name" triggered on host: current value …, please investigate the cause", and AI starts investigating.',
      ], tips: [
        'A system notification appears when triggered; click it to open the troubleshooting session. The same host won\'t notify or open sessions again until it recovers, and you\'re notified once more when it does.',
        'Each watchdog in the list shows its overall status (Normal / Possibly triggered / Triggered / Check failed); click the name to expand each host\'s latest value, last check time, and the last 20 trigger / recovery events, where "Troubleshooting session" opens the matching session.',
        '"Check now" on a row runs it immediately; the toggle disables it.',
        'Checks use a separate channel (reusing the connection of an open terminal on that host, otherwise connecting temporarily and disconnecting afterwards), never type into the terminal, and aren\'t recorded in the execution log. Hosts connecting for the first time with an unconfirmed fingerprint fail the check; connect manually once first.',
        'Checks run only while the app is running, not while it\'s closed. They keep running while the app is locked, and notifications then show only generic text.',
      ] },
    ],
  },
  {
    id: 'mcp', title: 'MCP servers', icon: Plug, settings: 'mcp',
    blocks: [
      { p: 'Connect external MCP servers and make their tools available to AI.' },
      { steps: [
        '"Settings → MCP servers" → "Add server", and enter a name.',
        'For the connection, choose "Local command (stdio)" (start command, one argument per line, working directory, environment variables) or "Remote HTTP / SSE" (URL, request headers).',
        'Once "Test connection" passes, click "Save"; the list shows "Connected · N tools", and you can expand it to see the tools.',
      ], tips: [
        'Every call shows a permission card by default; only tools for which you turned on "No confirmation" in the expanded server card run directly.',
        'The read-only trust level and scheduled inspections can only use tools that don\'t need confirmation. All calls are recorded in the execution log.',
        'Environment variable and request header values are stored encrypted.',
      ] },
    ],
  },
  {
    id: 'recording', title: 'Recordings and session logs', icon: Video, settings: 'recordings',
    blocks: [
      { h: 'Terminal recordings', steps: [
        'Turn on "Allow terminal recording" in "Settings → Terminal → Logging".',
        'A round "Start recording this terminal" button appears on the right of the terminal tab bar; click "Stop recording this terminal" to stop. Recording only starts manually.',
        'In "Settings → Terminal recordings", view, "Replay" (1x / 2x / 4x, idle gaps over 2 seconds are compressed to 2 seconds), open the containing folder, or delete.',
      ], tips: ['Recordings capture typed input in plain text, including passwords.', 'Files are in `~/.lingshell/recordings/<date>/` in asciicast v2 format and can also be played with asciinema; recordings past "Keep recordings for (days)" are deleted at startup (0 = forever).'] },
      { h: 'Session logs', p: 'With "Settings → Terminal → Logging → Automatically save session logs" on, each terminal\'s output is saved as a plain-text .log (by default under logs/sessions in the data folder, one folder per date). You can set the folder, retention days, and "Timestamp each line". "Open this terminal\'s log" in the terminal\'s right activity bar opens it directly. Logs contain output only, not typed input, and aren\'t included in diagnostic bundles.' },
    ],
  },
  {
    id: 'hoststats', title: 'Host status', icon: Activity, settings: 'general',
    blocks: [
      { p: 'The "CPU n%" and "MEM n%" tags on the right of the quick commands bar at the bottom of the terminal area show the load of the current terminal\'s host: ≤75% green, ≤90% yellow, >90% red. Click for details: CPU (cores), memory, disk /, load, uptime, and a trend of the last 30 samples.' },
      { steps: [
        'Turn on "Collect host status" in "Settings → General" (off by default).',
        'Adjust "Collection interval (seconds, 5–300)", default 10 seconds.',
        'Production hosts aren\'t sampled by default; check "Also collect on production hosts (interval ×3)" if needed.',
      ], tips: [
        'SSH hosts read `/proc` and `df` over a separate channel, so nothing goes into your terminal or command history. Only Linux / macOS are supported; other systems show "Status —". Local status reads system info without going through your terminal.',
        'Only terminals currently visible are sampled; nothing is sampled while the window is hidden or locked. Multiple terminals on the same host share one sample.',
      ] },
      { h: 'Network and disk IO', p: '"↓… ↑…" next to CPU / MEM is the network download / upload rate (per second, physical NICs combined, excluding lo; hover for each NIC), and "IO …" is the combined disk read/write rate (hover for read / write). The details view shows each value with trend lines (blue for download / read, yellow for upload / write; hover for the scale). Linux hosts have both; local Windows has network only (from `netstat -e`), and macOS shows neither for now. Values that can\'t be read aren\'t shown.' },
    ],
  },
  {
    id: 'security', title: 'Security', icon: Shield, settings: 'ai',
    blocks: [
      { h: 'App lock', steps: [
        'In "Settings → AI & security → App lock", click "Enable app lock" and enter the master password twice.',
        'Set "Auto-lock when idle (minutes)" (default 10; 0 = lock only at startup / manually / on system lock); it saves automatically.',
        'A lock button then appears in the title bar, or press Ctrl+Shift+L to lock immediately. The app also locks automatically at startup, on idle timeout, and when the system locks / sleeps.',
      ], tips: ['Open connections and AI tasks keep running in the background while locked.', 'The master password can\'t be recovered: if you forget it, quit the app and delete the lock.json shown under "Forgot password?" on the lock screen. Saved credentials are encrypted by the system keychain and aren\'t affected.'] },
      { h: 'Production hosts', p: 'After choosing "Production" for "Tier" in the host form:', tips: [
        'The host list, terminal tabs, and command palette show a red "Production" badge, and the tab is red by default.',
        'Every AI write operation needs confirmation (even Autonomous is treated as "Confirm"), and dangerous commands are always confirmed. AI prefers read-only investigation and explains impact and rollback before changes.',
        'Broadcast input excludes production terminals by default; dangerous commands in quick commands ask again before going to production.',
        'Host status isn\'t collected by default; auto-reply doesn\'t trigger on production hosts by default.',
      ] },
      { h: 'Redact before sending to AI', p: '"Settings → AI & security → Privacy → Redact before sending to AI", on by default. Command output, files read, terminal content, and MCP tool results obtained by AI have secrets masked as `[redacted]` before being sent to the model:', tips: [
        'Exact-value replacement: host passwords / private keys you saved in the app, provider API keys, alert bot URLs and secrets, secret auto-replies, and secret-type environment variables and request headers of MCP servers.',
        'Pattern detection: environment variables like `DB_PASS=…`, Bearer / JWT tokens, keys starting with `sk-`, private key blocks, etc. Passwords that weren\'t saved in the app and have no fixed format may be missed.',
        'If AI tries to write `[redacted]` back into a file or command, it\'s rejected outright and you\'re asked to fill in the real value yourself, so configs don\'t get broken.',
        'Trade-off: AI can\'t see real secret values, which limits troubleshooting problems like "wrong password". Content you send in chat yourself, the terminal view, the execution log, and recordings aren\'t affected.',
      ] },
      { h: 'Dangerous commands', p: 'These count as dangerous: `rm -r` recursive delete, `chmod -R 777/000`, `chown -R` on system folders, `dd` writing raw disks, `mkfs`, `shutdown / reboot / halt / poweroff`, fork bombs, `git push --force`, `curl | bash` and similar, `find -delete`. On a match the permission card turns red with "This command matches a dangerous pattern. Run it?", AI\'s explanation is marked "Verify yourself", and the corresponding step in a plan card is marked "Dangerous".', tips: ['The toggle is "Confirm each dangerous command" under "Settings → AI & security" (on by default). It\'s a reminder, not a security boundary; you still need to read the command carefully.'] },
      { h: 'Command rules (allow / ask / deny)', p: '"Settings → AI & security → Command rules": set rules for terminal commands run by AI, so you don\'t have to click permission cards every time, or to block certain commands entirely. Each rule has a match type (prefix / regex), pattern, action (always allow / always ask / always deny), scope (all hosts / specific groups / specific hosts; "Local terminal" is also available), and note. Changes save automatically: the pattern box saves when it loses focus (a half-typed prefix doesn\'t take effect early); if any regex is invalid, the page doesn\'t save until it\'s fixed.', steps: [
        '"Add rule", choose a match type, and enter a pattern. Prefix: the command segment starts with it (case-sensitive, spaces count, so `rm ` doesn\'t match `rmdir`). Regex: searched within the command segment; anchor to the start with `^`.',
        'Use the up / down arrows on the right to order rules: top to bottom, first match wins.',
        'Compound commands (`;` `&&` `||` `|` newlines, `$( )`, backticks) are split into segments and matched one by one, without splitting inside quotes: any segment matching "always deny" → rejected outright; every segment matching "always allow" → no permission card; any segment matching "always ask" → a card always appears; otherwise the session trust level applies.',
      ], tips: [
        'Examples: regex `^systemctl status` always allow (no clicking just to check service status); prefix `rm ` always ask (file deletes ask first even under Autonomous); regex `mkfs` always deny (never allow formatting disks).',
        'Allow rules never override the "Read-only" trust level; dangerous commands on production hosts still need confirmation even when they match an allow rule.',
        'Commands allowed / asked by a rule show "By rule: …" in the execution log and on the permission card; commands denied by a rule are marked "Blocked by rule" in the execution log with the rule noted, and AI receives the reason too.',
        'Like dangerous command detection, this is a reminder and a convenience, not a security boundary: commands built from variables, `eval`, or inside script files aren\'t detected.',
      ] },
      { h: 'Auto-reply', p: '"Auto-reply" group in "Settings → Hosts & connections": when the terminal stops at a matching prompt (only the last line where the cursor is, case-insensitive, regex allowed), a reply is sent automatically, like Xshell triggers.', steps: [
        '"Add rule", enter a name, the prompt to match (turn on "Regular expression" if needed), and the reply (turn on "Secret" for passwords, stored encrypted and never echoed).',
        'Choose whether to "Press Enter after reply" and the scope (all terminals / specific hosts / local terminal).',
      ], tips: ['Never triggers while AI is running a command; if the same rule triggers more than 3 times within 1 minute, it\'s disabled for that terminal.', 'Doesn\'t trigger on production hosts by default; turn on "Also trigger on production hosts" to allow it.'] },
    ],
  },
  {
    id: 'backup', title: 'Backup & diagnostics', icon: ArchiveRestore, settings: 'maintenance',
    blocks: [
      { h: 'Export config', steps: [
        'In "Settings → Backup & diagnostics → Export config", check what to export: hosts (with credentials), trusted fingerprints, task templates, quick commands, scheduled inspections, app settings (Terminal / AI & security / General), model settings (with prices), alert bots, auto-replies, knowledge base, and secret vault.',
        'You can set an export password (at least 6 characters): only with one are credentials such as host passwords / private keys and API keys encrypted and exported; without one, no credentials are included.',
        'Click "Export config" to get a .lingshell-config.json file.',
      ], tips: [
        'The execution log, command history, sessions and chats, layout, local API token, recordings, and logs are never exported.',
        'Alert bot URLs (with tokens), secret auto-replies, and secret vault values are exported only with an export password; without one, only names / descriptions / scopes are exported and must be filled in again after import.',
        'App keys (keys.json) aren\'t exported with the config: hosts / credentials that use app keys need their private keys re-entered after import (they\'re listed under "Credentials to re-enter").',
      ] },
      { h: 'Import config', p: 'In "Settings → Backup & diagnostics → Import config", click "Import config", choose a file, and pick for each item: Don\'t import / Merge (keep local on name clash) / Overwrite (use the file\'s on name clash) / Replace (replaces app settings or model settings entirely, with a second confirmation). After "Start import", the counts of added, overwritten, and skipped items are shown.', tips: [
        'If the file came from someone else or was edited by hand, malformed entries (hosts missing an address / port out of range, invalid inspection times, templates without content, bad fingerprints, etc.) are skipped one by one and counted as "Skipped", so local data isn\'t corrupted and scheduled inspections don\'t break.',
      ] },
      { h: 'Diagnostic bundle', p: 'When you need to report a problem, click "Export diagnostic bundle" in "Settings → Backup & diagnostics → Diagnostic bundle". It contains version and environment info, the last 3 run logs, and redacted settings / host list / layout / inspection schedules. It doesn\'t include API keys, passwords, private keys, chat content, commands run by AI, or command history.', tips: ['Host notes, local notes, and custom rules are exported as-is; review them before sharing.'] },
      { h: 'Data folder', p: '"Settings → Backup & diagnostics → Data folder" shows where the data folder and run logs are; "Open data folder" and "Open log folder" open them in the file manager.' },
      { h: 'Updates', p: 'Click "Check for updates" on the "Settings → About" page; when the download finishes, click "Restart to update", or it installs automatically the next time you quit.' },
    ],
  },
  {
    id: 'shortcuts', title: 'Keyboard shortcuts', icon: Keyboard, settings: 'shortcuts',
    blocks: [
      { p: 'The tables below come from the same source as the actual key handling and show the keys currently in effect (including any you changed). Any key combo not listed here is passed through to the shell and terminal programs.' },
      { h: 'Customize shortcuts', steps: [
        'Open "Settings → Keyboard shortcuts". You can search by action name or by key.',
        'Click the key on the right of an item and press a new combo; it takes effect and is saved immediately. While recording, Esc cancels and Backspace sets it to unassigned.',
        'A new key must include a modifier such as Ctrl / Alt, or be F1–F12. If it conflicts with another item you\'ll be told, and can choose "Replace anyway" (the other item becomes unassigned) or "Cancel".',
        'Changed items show "Reset to default" on the right; "Reset all to defaults" in the page header restores everything at once.',
      ], tips: [
        'Taking a key the terminal commonly uses (such as Ctrl+C / Ctrl+R / Ctrl+W) shows a yellow warning: that key will no longer be sent to the shell inside the terminal.',
        'Mouse actions (clicking the green / red dot at the start of a command line, Ctrl+click on links) and ↑↓ / Tab / Esc in the completion popup can\'t be changed.',
        'Custom shortcuts are exported / imported along with "App settings".',
      ] },
    ],
  },
  {
    id: 'faq', title: 'FAQ', icon: CircleHelp,
    blocks: [
      { h: 'Git Bash not detected', p: 'On Windows, local terminals and AI-driven local terminals need Git Bash. When it isn\'t detected, no local terminal opens on startup and the terminal area shows a "Git Bash not detected" card (if the AI tries to open a local terminal it gets bash_not_found with the reason). SSH remote terminals are not affected.', steps: [
        'Click "Download Git for Windows" and install it (default options are fine), then come back and click "I\'ve installed it, check again".',
        'Installed elsewhere or using the portable version: click "Choose bash.exe…" and pick `bin\\bash.exe` under the Git install folder. You can change it later in "Settings → General → Git Bash path" with "Choose…", "Check again" or "Clear".',
        'Not installing for now: click "Use PowerShell for now (manual only)". You can type commands yourself, but the AI can\'t run anything there.',
      ], tips: ['`C:\\Windows\\System32\\bash.exe` is the WSL launcher and can\'t be used as Git Bash.'] },
      { h: 'No green / red dot at the start of command lines', p: 'Success / failure markers need bash 4.4 or later. They don\'t show when bash is too old or the remote login shell isn\'t bash (for example zsh). Commands inside full-screen programs like vim / less, and commands the AI runs, aren\'t marked either.' },
      { h: 'Ctrl+Shift+L doesn\'t lock the app', p: 'First make sure App lock is enabled in "Settings → AI & security". If another program\'s global hotkey has taken the shortcut, pick a different one in "Settings → Keyboard shortcuts", use the lock button in the title bar, or choose "Lock app" in the command palette (Ctrl+Shift+P).' },
      { h: 'Production hosts don\'t show CPU / MEM', p: 'Status isn\'t collected for production hosts by default. Turn on "Collect on production hosts too" in "Settings → General" (the interval is automatically ×3). SSH hosts that aren\'t Linux / macOS show "Status —".' },
      { h: 'F1 / Ctrl+K does nothing in the terminal', p: 'When the terminal has focus, F1 is left to terminal programs like mc and htop, and Ctrl+K is left to the shell (delete to end of line). Click the chat area first and press again, or use the help button in the title bar, or open the command palette with Ctrl+Shift+P.' },
      { h: 'Ctrl+I doesn\'t open the input box', p: 'It only works when the prompt is empty: clear the input line first (Ctrl+U), exit full-screen programs like vim, and wait until the command finishes or the AI is done with this terminal. If no API Key is set, the request times out or the model returns an error, the reason is shown right below the input box.' },
      { h: '"[redacted]" appears in AI replies', p: 'That\'s a secret value masked by "Redact before sending to AI", not an AI error. If it needs the real value to check something, send the value yourself, or temporarily turn off redaction in "Settings → AI & security".' },
      { h: 'Garbled Chinese text', p: 'Usually an old server using GBK. In the host edit form, change "Character encoding" to GBK / GB18030 and reopen the terminal.' },
      { h: 'AI says it has no permission / command was blocked', p: 'Check the trust level in the shield drawer under "Session permissions": "Read-only" rejects every write command. Every write on a production host needs your confirmation.' },
      { h: 'Encrypted upload fails', p: 'Encrypted upload requires `openssl` on the remote host. If you can\'t install it, switch to "No encryption" in the upload dialog.' },
      { h: 'Scheduled inspection didn\'t run on time', p: 'Inspections only run while the app is running. Runs missed while it was closed are caught up only once on the next launch.' },
      { h: '"Context is full, reset the session to continue"', p: 'Continue in a new session, or click the model name at the top of the chat area and switch to a model profile with a larger context window (the auto-compaction threshold scales with the window: window × 60%, up to 600K).' },
      { h: 'Old sessions won\'t open after upgrading / "History can\'t be restored"', p: 'After the AI engine is upgraded, session records left by the old version have to be converted to the new format. Old sessions where you had clicked "Stop" used to fail conversion; they are now repaired automatically when opened (the repair is written to a new copy, the original record is untouched), and history shows as usual.', steps: [
        'Click the session in "Session history" and wait a moment to see the original conversation.',
        'If one really can\'t be repaired, the chat area shows "This session\'s history can\'t be restored (reason); a new empty session has been opened" along with the location of the original record. You can keep chatting in that session.',
        'If opening a session fails and stops on an error page, click "Retry", "New session", "Back to previous session" or "Session history". The buttons at the top work as usual too.',
      ], tips: ['Original records are kept under `dsh-sessions` in the data folder. If needed, send the path along with the app log when reporting the issue.'] },
      { h: 'How settings are saved (there\'s no "Save" button anymore)', p: '"Model settings" (editing an existing profile), "Terminal", "AI & security", "General" and "Network proxy" save automatically as you change them: toggles and dropdowns after about 0.3 seconds, text and numbers about 0.8 seconds after you stop typing, and immediately when you leave the field, switch settings pages or close settings. The settings title shows "Saving…" → "Auto-saved" (fades after a few seconds); a failed save turns red with "Retry".', tips: [
        'Invalid values (such as an invalid regex or an empty proxy address) aren\'t saved. The title shows "Not saved: reason", and it saves automatically once fixed.',
        'API Keys and proxy passwords are saved only when you leave the field, so a half-typed value is never stored; the same goes for command rule patterns. "Test connection" only sends a request when you click it.',
        'New model profiles use "Create". Forms that add / edit a single item, such as Task templates, Runbooks, Scheduled inspections, MCP and Skills, still use "Save", and import, delete, reset and similar actions still ask for confirmation.',
      ] },
    ],
  },
  {
    id: 'skills', title: 'Skills', icon: Sparkles, settings: 'skills',
    blocks: [
      { p: 'A skill is a reusable set of task instructions: a folder whose `SKILL.md` holds the name, description and the actual procedure, optionally with resource files such as scripts and reference docs. Normally the AI only sees each skill\'s name and description, and loads the full instructions when a task matches; you can also ask for a skill by name in the chat.' },
      { h: 'Import', steps: [
        'Open "Settings → Skills", click "Import skill" and choose "From folder…" or "From .zip / .skill package…".',
        'In the confirmation dialog, review the SKILL.md content and the package file list. If a skill with the same name exists, choose "Import with new name" or "Overwrite existing".',
        'Click "Confirm import". It takes effect immediately, no restart needed.',
      ], tips: [
        'The package must contain SKILL.md (at the package root or inside a single top-level subfolder), starting with YAML frontmatter: `name` (lowercase letters, digits and hyphens) and `description`.',
        'Archives with out-of-bounds paths (such as `../`) or symlinks are rejected, and archives over 50MB are rejected outright (without extracting or filling a temp folder). The skill body is only a prompt for the AI; importing or using it never runs any file in the package automatically.',
        'Skills live under `skills/<name>/` in the data folder. "Open Skills folder" lets you browse or edit them by hand, and changes take effect automatically.',
      ] },
      { h: 'Create', steps: [
        'In "Settings → Skills", click "New skill".',
        'Fill in "Name" (such as `disk-check`), "Description" (the AI uses it to decide when to apply the skill) and "Instructions" (steps and caveats in Markdown).',
        'Click "Save" to store it as `skills/<name>/SKILL.md`. Later, click "Edit" on the card to change it, or "Delete" (resource files are deleted too).',
      ] },
      { h: 'Use in a chat', steps: [
        'Click "+" before the input box → "Skills" ▸ and pick a skill.',
        'A tag with its name appears above the input box (click × on the tag to remove it). Write what you want done and press Enter.',
        'The message starts with `/name`, so the AI gets the skill\'s full instructions before it starts. The tag applies to this message only.',
      ], tips: ['The list only shows skills that are enabled and allow manual invocation (skills with `user-invocable: false` in SKILL.md are hidden).'] },
      { h: 'Automatic use by the AI', p: 'Each skill card has two toggles: with "Enabled" off, the AI can\'t see the skill and it\'s not in the "+" menu; with "AI can invoke automatically" off, the AI won\'t load it on its own and you can only use it by picking it in "+" → "Skills". Both toggles are stored in the app only and don\'t modify SKILL.md.', tips: [
        'When the AI reads a skill\'s resource files (scripts, docs), it goes through the terminal as usual, so permission is required as usual and the output still goes through "Redact before sending to AI".',
        'You can also type "Open Skills" in the command palette to jump to the settings page.',
      ] },
    ],
  },
  {
    id: 'attachments', title: 'Chat attachments and images', icon: Paperclip, settings: 'model',
    blocks: [
      { p: 'You can attach local files, folders and images to a message. Attachments show as one-line tags above the input box (icon or small thumbnail + name + ×) and are cleared after sending. The sent message bubble shows the same tags for its attachments, and they\'re still there after restarting the app or browsing history.' },
      { h: 'Files and folders', steps: [
        'Click "+" before the input box → "Add context" → "File" or "Folder" (multi-select supported), or drag files / folders from your system onto the input box.',
        'Copy files or folders in the Explorer (Ctrl+C), then press Ctrl+V in the input box to add them as attachment tags as well. If you copied text, it pastes as text as usual.',
        'Tags show an icon and name; hover to see the full path. Click × to remove.',
        'Only the paths are sent to the AI (a "Local paths attached" section is appended to the message); file contents are not uploaded. When the AI needs them it reads them with a local terminal, which requires permission as usual. On Windows the Git Bash form is given too (such as `/c/logs/a.log`).',
        'Click a tag to open it: files open with the system default app, folders open in the Explorer. If it no longer exists, you\'ll be told.',
      ] },
      { h: 'Images', steps: [
        'First turn on "Supports images" for the profile you use in "Settings → Model settings" (models known to support vision have it on by default and show an "Image" tag in the list).',
        'Use "+" → "Add context" → "File" to pick images (png / jpg / jpeg / gif / webp / bmp / svg, up to 10MB each and up to 8 per message; you can multi-select them with ordinary files), press Ctrl+V in the input box to paste a screenshot, or drag images in. All of them show as images.',
        'Tags start with a small thumbnail; click to open the preview. After sending, the images go to the model with the message.',
      ] },
      { h: 'Image preview', steps: [
        'Scroll to zoom around the cursor. Use "−" / "+" in the top bar to zoom, and "Fit to window" / "1:1" to switch; the current percentage is shown in the middle.',
        'Double-click the image to toggle between "Fit to window" and "1:1"; when zoomed in, drag with the mouse to pan.',
        'When a message has several images, switch with the ← → keys or the arrows on either side. Press Esc or × in the top-right corner to close.',
      ], tips: [
        'If the current model doesn\'t have "Supports images" on, image files can still be added via "File", drag or paste, but the tag says "The current model doesn\'t support images; only the path will be sent", and only the path is sent. Pasted screenshots have no path, so you\'ll see "The current model doesn\'t support images. Turn it on in Model settings or switch models".',
        'Before sending, images are scaled down so the long side is at most 2048 pixels and re-compressed as PNG / JPEG. For GIFs only the first frame is used; BMP and SVG are converted to PNG too (SVG is rendered as a vector to a long side of at least 1024 pixels first). Images are archived under `sessions/attachments/` in the data folder, and history shows that copy, so deleting the original doesn\'t matter.',
        '"Redact before sending to AI" only handles text. Images are sent as-is, so blur any sensitive information in screenshots yourself first.',
        'If "Supports images" is on but the model doesn\'t actually support images, requests with images will fail with an API error.',
      ] },
    ],
  },
  {
    id: 'messages', title: 'Message actions (copy / regenerate / edit and resend / fork)', icon: GitBranchPlus,
    blocks: [
      { p: 'Hover a message in the chat and a few small icon buttons appear next to the bubble (left of your messages, right of AI replies). While the current turn is still running, Edit, Fork and Regenerate are grayed out; use them after the turn ends (or after stopping it).' },
      { h: 'Copy', p: 'Both your messages and AI replies have "Copy". For AI replies it copies the original Markdown (code blocks and tables intact), so formatting survives when you paste into notes.' },
      { h: 'Regenerate', p: 'The last AI reply of the last turn has "Regenerate" (circular arrows): it reruns the turn with the same message (including its attachments). The turn\'s original reply and execution steps are replaced; earlier conversation is unchanged and it stays the same session.', tips: [
        'The replaced turn is no longer shown but is still stored locally, and Session history search can still find its content.',
        'Regenerating makes the AI run the turn\'s commands again (with permission as usual). Changes already made in the terminal are not undone.',
      ] },
      { h: 'Edit and resend', steps: [
        'Click "Edit" (pencil) on one of your messages. The bubble turns into an input box; after editing, press Enter or click "Send" (Shift+Enter for a new line, Esc or "Cancel" to discard).',
        'The app forks a new session "Original title (fork)" from just before this message, switches to it and sends the edited text: the new session contains only the conversation before this message plus the edited turn.',
        'The original session is kept in full; switch back any time from "Session history" on the left.',
      ] },
      { h: 'Fork from here', p: '"Fork from here" (branch icon) on your messages also forks a new session and switches to it, but doesn\'t send: the message is put into the input box so you can edit it before sending, or ask a different way.', tips: [
        'The forked session keeps the original session\'s working directory and model profile. Terminal permissions aren\'t inherited; like a new session, they\'re granted again as needed.',
        'Attachments (files, images) on the message aren\'t carried over when editing / forking; add them again if needed.',
      ] },
      { h: 'Code blocks in AI replies', p: 'Hover a code block in an AI reply and buttons appear in the top-right corner. Every code block has "Copy code"; command code blocks (bash / sh / shell / zsh / console / PowerShell / cmd, or no language) also have "Insert into terminal" and "Run in current terminal". The "current terminal" is the one showing in the terminal area on the right (the focused pane when split). With no terminal open, these two buttons are grayed out.', steps: [
        'Insert into terminal (cursor icon): a single-line command is written after the current terminal\'s prompt without pressing Enter, and keyboard focus moves to the terminal so you can check or edit it and press Enter yourself. A multi-line command opens the "Compose bar" at the bottom of the terminal and fills it in (without running); review it and send from the Compose bar.',
        'Run in current terminal (play icon): sends to the current terminal and presses Enter; multiple lines run one by one. As with the Compose bar, dangerous commands (such as `rm -rf`) and hidden / control characters trigger a confirmation dialog first (dangerous lines in red); sending to a production terminal always asks first, even for a single line.',
        'For code blocks where every line starts with a `$ ` prompt (console style), the prompts are stripped automatically when inserting / running; blocks mixed with output are left as-is.',
      ], tips: [
        'If the AI is running a command in that terminal (terminal locked) or the terminal is disconnected, nothing is written, and the reason is shown next to the button.',
      ] },
    ],
  },
  {
    id: 'hostcheck', title: 'Host health check, config drift and change snapshots', icon: Stethoscope, settings: 'ai',
    blocks: [
      { p: 'Run a read-only health check on an SSH host (Linux) with one click; results are saved per host as an archive. Comparing with the previous check reveals config drift. Before and after the AI changes a host, snapshots are taken automatically, and at the end of the turn you\'re told what changed on the host.' },
      { h: 'Host health check', steps: [
        'Switch to an SSH terminal and click "Host health check" (stethoscope icon) in the right activity bar to open the drawer on the right, or search "Host health check" in the command palette.',
        'Click "Start check" in the top-right corner. It collects in one go: system / kernel / uptime, CPU and load, memory and swap, disk and inode usage per mount point, listening ports, failed systemd services, docker containers, key config files (sshd_config, nginx.conf and conf.d, my.cnf, crontab, hosts, fstab, resolv.conf, sysctl.conf), UID 0 users, recent logins, sshd PermitRootLogin / PasswordAuthentication, certificate expiry and the number of upgradable packages. It takes up to about 45 seconds.',
        'The report shows in section cards. "Issues found" lists what needs attention: disk or inode usage over 85%, failed services, certificates expiring within 30 days / already expired, root password login allowed, UID 0 users other than root, and available security updates.',
        '"Ask AI to interpret": sends a (redacted) summary of the report to the current chat as a message and asks the AI for recommendations ordered by severity.',
        'The "Archive" dropdown switches between this host\'s earlier health checks and AI change snapshots. The latest 20 are kept per host.',
      ], tips: [
        'Collection is read-only and uses a separate channel: it doesn\'t go into the terminal or command history, and doesn\'t pass through the AI. If one item can\'t be collected (no docker, no permission, timeout), only that item is left empty; the others are unaffected.',
        'Upgradable packages are read from the local cache only (no network refresh) with a 15-second limit; on timeout it shows "Unknown". Seeing other users\' process names and reading some config files requires root; otherwise it shows "No permission to read".',
      ] },
      { h: 'Compare with previous (config drift)', steps: [
        '"Compare with previous" at the top of the report compares against the most recent earlier check by default; pick any older one from the dropdown on the right.',
        'It lists ports added / gone, services newly failed / recovered, containers added / gone / changed image or state, key config files modified / new / removed, new UID 0 users, new login source IPs, and disk usage changes of more than 10 percentage points.',
        'For config files, click "View diff" to see which lines changed between the two checks (the text of these files is cached locally during a check, up to 256KB each). If the content wasn\'t cached that time, click "Fetch current content" to read what\'s on the remote host now and compare it with the last cached copy.',
      ] },
      { h: 'Snapshots before and after AI changes', steps: [
        'The first time in a turn the AI runs a modifying command (or writes a file, or uploads) on a Linux SSH host, a lightweight snapshot is taken first: ports, failed services, containers and key config files, with a 10-second limit. If it fails, execution isn\'t held up. Read-only commands like `cat` / `ls` / `grep` don\'t trigger it.',
        'Another snapshot is taken when the turn ends. If anything changed, the end of the reply shows "Host changes this turn: ports +1, nginx.conf modified…"; expand it for details, and config files can also "View diff". Nothing is shown when there are no changes.',
        'The toggle is "Snapshot before and after AI changes" in "Settings → AI & security", on by default. Snapshots also appear in the "Archive" of that host\'s "Host health check".',
      ] },
    ],
  },
  {
    id: 'systemd', title: 'Services (systemd)', icon: ServerCog,
    blocks: [
      { p: 'See which services exist on a Linux host and which have failed without typing commands, and start / stop / restart them directly. Linux SSH terminals only; the button doesn\'t appear for local terminals or Windows / macOS hosts.' },
      { steps: [
        'Switch to an SSH terminal and click "Services (systemd)" (server icon with a gear) in the right activity bar to open the drawer. It lists the service name, description, running state and whether it starts at boot ("Enabled" = starts at boot, "—" = doesn\'t).',
        'Failed services are shown in red and listed first by default. "Failed only" in the title bar keeps just the failed ones (count in parentheses); the pin button next to it toggles "Failed first / Sort by name", and "Refresh" reloads. The input box above filters by service name or description.',
        'Click a service to see `systemctl status` below (including the last 30 log lines); the small button in the top-right corner reloads it.',
        '"Start", "Stop", "Restart", "Reload", "Enable at boot", "Disable at boot": a confirmation dialog shows the command to be run first, with a red warning on production hosts. After you confirm, it runs and the result and state refresh automatically. Buttons that make no sense in the current state are grayed out (such as "Start" when already running).',
        '"View logs" follows the log in real time with `journalctl -u <service> -f` in the log panel at the bottom; "Ask AI" puts the service status and recent logs into the chat input box (processed by "Redact before sending to AI", not sent automatically).',
      ], tips: [
        'Start / stop and similar actions need root: when logged in as root they run directly; otherwise `sudo -n` is added automatically (passwordless sudo only, never a password prompt). If a password is required or there\'s no sudo, the raw error is shown above the buttons.',
        'Every action (success or failure) is recorded in the "Execution log" with a label like "Service · Restart (manual)" and the exit code.',
        'Commands use a separate channel and don\'t go into your terminal or command history. Hosts without systemd (Alpine, containers, WSL, etc.) say so directly.',
      ] },
    ],
  },
  {
    id: 'output-table', title: 'Command output as table / JSON tree', icon: Table2,
    blocks: [
      { p: 'Turn the output of a terminal command into a sortable, filterable table; JSON output is shown as a collapsible tree. This relies on command success / failure markers (bash 4.4 or later, enabled automatically for local Git Bash and SSH).' },
      { h: 'Open', steps: [
        'Click the small green / red dot at the start of a command line → "View as table". Works for any command.',
        'For common commands (`df`, `ps`, `docker ps` / `docker images` / `docker stats --no-stream`, `ss`, `netstat`, `free`, `lsblk`, `kubectl get`, `systemctl list-units`, `top -bn1`, `ls -l`, etc.) or JSON output, hover over the command\'s output and a "Table" button (or "JSON" for JSON) appears in the top-right corner; click it to open directly.',
      ] },
      { h: 'Table', steps: [
        'Click a column header to sort (numeric columns start from largest), click again to reverse, a third time to clear. Values like `1.2G`, `512M`, `45%`, `15:23` and `2d3h` sort by numeric value, not as text.',
        'Use "Search all columns" at the top left; the "Filter" box under each column filters that column only; "Columns (N/M)" picks which columns to show; "Clear sort and filters" restores everything at once.',
        '"Copy CSV" and "Copy Markdown" copy the rows and columns currently shown (sorted, filtered, hidden columns excluded); "Ask AI" puts the table into the chat input box (not sent automatically).',
        'If parsing is off (misaligned columns), change the split method manually in the dropdown at the top left: "Split by whitespace" (every run of whitespace is a separator; the last column takes the rest) or "Fixed width" (split at the positions where columns align).',
      ] },
      { h: 'JSON', steps: [
        'Shown as a tree; click an object / array to expand or collapse. With few nodes everything is expanded by default; otherwise only the first two levels are, and "Reset expansion" restores that.',
        '"Search keys / values" keeps only matching nodes and their ancestors, with matches highlighted.',
        'Click any node to select it; its path is shown at the bottom (jq syntax, such as `.a[2].b`) with "Copy path" and "Copy value". When the output is an array of objects (such as `docker ps --format \'{{json .}}\'`, one per line) you can also switch to "Table".',
      ] },
      { tips: [
        'Only output already displayed in the terminal is read (up to 20,000 lines); anything scrolled out of the scrollback buffer can\'t be read. The table shows up to 2,000 rows; copying and Ask AI include everything.',
        '"Ask AI" follows "Redact before sending to AI". The dialog can only be closed with × in the top-right corner or Esc.',
      ] },
    ],
  },
  {
    id: 'knowledge', title: 'Knowledge base (host / group / global cards)', icon: BookMarked,
    blocks: [
      { p: 'Record long-lived knowledge about your servers as knowledge cards: how things are deployed, where logs are, how to start / stop, known issues and so on. Each card has a title, content (Markdown) and a category (Deployment / Log locations / Start & stop / Known issues / Other), and is attached to a host, a group or "Global". Once the AI uses a host, it automatically reads the cards for that host, its group and global (newest first, about 4,000 characters total; beyond that only titles are listed), so it gets to know your servers better over time.' },
      { h: 'Open the knowledge base', steps: [
        'Click the "Knowledge base" icon (bookmark) in the left activity bar, or search "Open knowledge base" in the command palette.',
        'In the Host panel ("Hosts" in the title bar), right-click a host → "Knowledge base" to see that host\'s cards directly; right-click a group header → "Group knowledge base".',
        'Filter by "All / Global / Group / Host" on the left; the search box at the top searches titles and content in full text (separate multiple words with spaces); the dropdown on the right filters by category.',
      ] },
      { h: 'Add / edit / delete manually', steps: [
        'Click "New card" in the top-right corner: choose where it belongs (Global / a group / a host) and a category, fill in the title and content, and click "Save".',
        'The pencil on the right of a card is "Edit"; the trash can is "Delete" (asks once more).',
      ] },
      { h: 'AI-suggested cards', p: 'When troubleshooting turns up something worth remembering long term (where a service is deployed, log locations, how to start / stop it, pitfalls you hit), the AI shows an "AI suggests saving to knowledge base" card in the chat (or "AI suggests updating a knowledge card" when correcting an existing card; expand it to see the original). You can edit the title, category and content first. Nothing is written until you click "Save"; "Ignore" writes nothing. After saving, click "View in knowledge base".', tips: [
        'The AI only suggests stable, non-sensitive facts. Don\'t put passwords, keys or tokens in the knowledge base.',
        'Knowledge cards are your own notes and can go stale. When the AI finds they don\'t match what\'s actually on the host, it trusts the host and suggests an update.',
      ] },
      { h: 'Old "Host notes"', p: 'The old "Notes" in the host form and "Local notes" in "Settings → AI & security" have been migrated automatically into a "Host notes" card for that host (or this machine), with nothing lost. Editing the notes later updates this card too.' },
      { h: 'Backup', p: 'Check "Knowledge base" in "Settings → Backup & diagnostics → Export config" to include it in the config export. On import you can merge or overwrite (per card). Host cards are matched to the imported hosts; host cards whose host can\'t be found locally are dropped, so import them together with "Hosts".' },
    ],
  },
  {
    id: 'fleet', title: 'Cross-host questions (which hosts / all hosts / compare each)', icon: Network,
    blocks: [
      { p: 'Just ask the AI "Which hosts have disks over 80%?", "Kernel version on all hosts" or "Compare the nginx version on each host in the web group". The AI uses run_on_hosts to run the same read-only command in parallel on several saved hosts (each over its own channel, with no terminal opened or tied up). Results show as a table in the chat (host / status / exit code / duration / output summary; click a row for the full text), and the AI then summarizes them into a comparison table.' },
      { h: 'How to use', steps: [
        'Ask directly in the chat, or search "Ask across hosts" in the command palette and choose "All hosts" or a group. The input box is prefilled with "Check on all hosts in <group>: "; add what you want to check and send.',
        'Right-clicking a group header in the Host panel → "Ask across hosts" does the same.',
        'The first time these hosts are accessed, one permission card lists every host that will be accessed; click "Allow" once to confirm (Read permission). The same session won\'t ask again.',
      ], tips: [
        'Only read-only commands are allowed (viewing commands like `cat` `ls` `grep` `df` `ps` `systemctl status` `journalctl`). Commands that delete or modify, write redirections, `sudo` and command substitution are rejected outright and never run. To make changes, have the AI work on a single host (with permission as usual).',
        '"Settings → AI & security → Command rules" applies too: if a command is "Always block", the whole batch doesn\'t run.',
        'Each host\'s run is recorded in the "Execution log" (labeled "Ask across hosts", with exit code). Hosts that can\'t be reached / time out are shown in red in the table without affecting the others.',
        'Up to 8 hosts run in parallel, with a default 30-second timeout per host. Hosts with an open terminal reuse its connection; the rest connect temporarily and disconnect when done.',
      ] },
    ],
  },
  {
    id: 'dashboard', title: 'Host dashboard (multi-host wall)', icon: LayoutDashboard,
    blocks: [
      { p: 'See the status of every saved host on one screen: one card per host showing online status, CPU / memory / disk (fullest mount point) / load with mini trend lines of the last 60 samples, number of failed services, containers (running / total), recent alerts (keyword alerts, watchdog triggers) and the number of issues found in the most recent host health check.' },
      { h: 'Open', steps: [
        'Click "Dashboard" to the right of the "Hosts" button in the title bar, or search "Open dashboard" in the command palette.',
        'Summary bar at the top: total hosts / online / with issues / production. Filter by group, choose "Connected only", or search by name / address.',
      ] },
      { h: 'Where the data comes from', steps: [
        'Connected hosts (with an open terminal): sampled over the terminal\'s connection, with no extra connection. When "Host status" collection is on, the CPU / memory / load it collects also feed the trend lines.',
        'Hosts not connected: turn on "Sample" in the card\'s bottom-right corner (or "Sample all" at the top). While the dashboard is open, it connects temporarily at the chosen "Interval" (15 / 30 / 60 seconds, default 30) and keeps reusing the same connection. Closing the dashboard stops sampling and disconnects (the sampling toggle is remembered and resumes next time).',
      ], tips: [
        'Sampling runs only one fixed read-only command (reads `/proc`, `df`, `systemctl list-units --state=failed`, `docker ps -a`) over a separate channel. It doesn\'t go into the terminal or command history, and writes nothing on the host. Linux hosts only.',
        'Without systemd / docker or without permission, the corresponding item shows "—" and doesn\'t count as an issue.',
        'The first temporary connection to a host whose fingerprint hasn\'t been confirmed asks you to confirm the fingerprint. If it can\'t connect, the card shows "Sampling failed" with the reason and retries with a doubling interval.',
      ] },
      { h: 'Issues', p: 'CPU or memory over 90%, the fullest mount point over 85%, failed systemd services, or an active watchdog alert on the host: if any applies, the card gets a red border, moves to the front, and lists the reasons below.' },
      { h: 'Card actions', steps: [
        'Click a card to open that host\'s terminal (or switch to it if already open); the dashboard closes.',
        '"…" menu in the card\'s top-right corner: "Host health check", "Services", "Ports" (switch to / connect that host\'s terminal and open the matching drawer), "Knowledge base", "Ask across hosts" (prefilled with the host\'s group), "Ask AI" (sends the host\'s current status, issues, alerts and health check results to the AI as a message).',
      ] },
    ],
  },
  {
    id: 'appearance', title: 'Appearance (theme / UI zoom / icon size)', icon: Palette, settings: 'general',
    blocks: [
      { p: '"Settings → General → Appearance": changes apply and save immediately, and persist after restart.' },
      { h: 'Theme', p: '10 color themes + "Follow system". Click a swatch to switch instantly. The whole UI changes together: chat, terminal, settings, dialogs, title bar and scrollbars. The moon / sun button ("Switch theme") on the right of the title bar opens a theme dropdown, and searching "Theme" in the command palette lets you pick one directly.', tips: [
        'Dark (default): dark, easy on the eyes for long terminal sessions.',
        'Midnight: Tokyo Night style, deep indigo background with blue accents, softer at night.',
        'Dracula: classic Dracula, purple accents and vivid colors.',
        'Nord: Nord cool gray-blue, low saturation and gentle contrast, for people who don\'t like pure black.',
        'Solarized: Solarized Dark, deep teal background with orange accents.',
        'Rosé: Rosé Pine, dark purple-black background with rose accents, soft and calm.',
        'High contrast: pure black background, pure white text, bright yellow accents and stronger borders (text contrast meets WCAG AAA); for low vision or bright light.',
        'Light: black on white with blue accents; for daytime, bright rooms and presentations.',
        'Lavender: white background, pale purple panels and purple accents; a fresh light theme.',
        'Sepia: paper beige (Solarized Light), softer than pure white, good for long reading.',
        '"Follow system": choose which theme to use for system dark / light mode in "When system is dark" and "When system is light" below the swatches (defaults: Dark / Light).',
        'Terminal colors default to "Follow UI theme"; each theme comes with a matching terminal palette (Midnight → Tokyo Night, Nord → Nord, Sepia → Solarized Light, High contrast → High contrast…). If you pick a specific palette in "Settings → Terminal → Colors", it stays fixed and no longer follows the UI.',
      ] },
      { h: 'UI zoom', p: '80% / 90% / 100% (default) / 110% / 125% / 150%; text, icons and spacing scale together. Shortcuts: `Ctrl+Shift+=` zooms in one step, `Ctrl+Shift+-` zooms out one step, `Ctrl+Alt+0` resets (changeable in "Settings → Keyboard shortcuts").', tips: [
        '`Ctrl+=` / `Ctrl+-` / `Ctrl+0` in the terminal only change the terminal font size, not the UI zoom.',
      ] },
      { h: 'Icon size', p: 'Small (default) / Medium / Large: enlarges only the icons on buttons, the activity bar and so on; text size stays the same. If icons are hard to see, choose "Medium" or "Large"; to make everything bigger, use "UI zoom".' },
      { h: 'Language', p: 'Follow system (default: Chinese if your system is Chinese, otherwise English) / Simplified Chinese / English. After changing it you are asked to "Restart to change language"; click "Restart now", or restart later yourself. Restarting closes open terminals and SSH connections; chat history is kept.', tips: [
        'With the English UI the AI replies in English by default; if you write in Chinese it answers in Chinese.',
        'Names you create yourself (hosts, sessions, rules, quick commands) are never translated.',
      ] },
    ],
  },
  {
    id: 'secrets', title: 'Secret vault (AI uses placeholders, never sees plaintext)', icon: LockKeyhole, settings: 'secrets',
    blocks: [
      { p: 'Store database passwords, API tokens and the like in "Settings → Secret vault", and the AI references them in commands as `{{secret:name}}`. The app swaps the placeholder for the real value only at the moment the command is actually sent to the terminal. The main session model, the AI review model, command prediction, config explanation, Deploy review and the mobile page only ever see the placeholder or `[redacted]`.' },
      { h: 'Create / replace / delete', steps: [
        'In "Settings → Secret vault", click "New secret": fill in "Name" (lowercase letters, digits, - and _, such as `mysql-root`), "Scope" (local terminals only / specific hosts / specific groups / all hosts), "Description" and "Value", then click "Save".',
        'Once saved, the value can\'t be viewed; you can only replace it entirely with the pencil "Edit / Replace value" (leave empty = unchanged). The name can\'t be changed after creation.',
        'The `{ }` icon "Copy placeholder" copies `{{secret:name}}`; "Copy value" asks for confirmation first, and the clipboard is cleared automatically after 30 seconds; the trash can is "Delete".',
      ] },
      { h: 'How the AI uses it', p: 'The system prompt lists the names, descriptions and scopes of available secrets (no values). Just say "Log in to the database with mysql-root and check the table count", and the AI writes `mysql -uroot -p{{secret:mysql-root}} -e …`.', tips: [
        'Permission cards, tool cards in the chat, the Execution log, command history, session logs and recordings all show the placeholder. If the real value appears in terminal output, it\'s swapped back to the placeholder before going to the AI.',
        'Placeholders are only substituted in exec-type commands (run command / run on multiple hosts / background tasks). Using one on a terminal outside its scope is rejected outright and the AI is told why. Cross-host questions and file writes don\'t support placeholders.',
        'On substitution the value is escaped according to the surrounding quotes (wrapped in single quotes when not inside quotes), so spaces, $ and quotes in the value are fine.',
        'Command rules, dangerous command detection and rollback plans all see the original placeholder text.',
      ] },
      { h: 'Use manually in the Compose bar', p: 'When text sent from the Compose bar contains `{{secret:name}}`, a "Use secret vault" confirmation dialog lists the secrets that will be used; after you confirm, they\'re substituted locally and sent. Typing a placeholder directly in the terminal is not substituted.' },
      { h: 'Limits to be aware of', tips: [
        'The model never sees the plaintext, but once the command runs it may still be visible on the server: command-line arguments in the process list (ps), the program\'s own logs, audit logs and so on. That\'s normal shell behavior. For programs that accept passwords via environment variables / config files, prefer those.',
        'Commands containing secrets are sent with a leading space, and bash\'s `HISTCONTROL` is set to include `ignorespace` so they stay out of shell history as far as possible. This is best effort (it doesn\'t work for non-bash shells or if HISTCONTROL is changed later).',
        'The terminal itself shows real values in command results (such as those printed by `echo`); that\'s the execution result. Rewriting output back to placeholders applies only to what goes to the AI and to logs / recordings. Values must be at least 4 characters; shorter ones can\'t be detected reliably.',
        'Values are encrypted with the system keychain. When the system keychain isn\'t available (some Linux setups), it falls back to plaintext readable only by the local user; don\'t store your most sensitive credentials in such environments. If the keychain becomes available after the app starts, earlier plaintext values are migrated to ciphertext automatically.',
        'Checking "Secret vault" in config export: without an export password only names / descriptions / scopes are exported (marked "Value not set" after import and need replacing); with an export password, values are exported encrypted with that password.',
      ] },
    ],
  },
  {
    id: 'mobile', title: 'Mobile viewing and approval (LAN)', icon: Smartphone, settings: 'mobile',
    blocks: [
      { p: 'When you\'re away from your computer, use a phone browser on the same LAN to follow AI session progress and handle permission requests. The phone can only view and approve; it can\'t send messages or run commands.' },
      { h: 'Enable and pair', steps: [
        'In "Settings → Mobile access", turn on "Allow phones on the LAN to view and approve" (off by default). "Network address" defaults to the first LAN address; if your computer has several network adapters, pick the network your phone is on. "Port" is chosen at random the first time you enable it and can be changed.',
        'Click "Generate pairing code", open the displayed address in your phone browser (such as `http://192.168.1.8:43521/`), enter the 6-digit pairing code and tap "Pair". Even easier: scan the QR code on the page with your phone camera or WeChat (it\'s the link with the code, `…/#c=123456`), which pairs automatically when opened.',
        'After pairing, the phone is remembered (browser cookie, valid for 30 days; pair again after it expires), so you can just open the address next time. "Paired devices" shows each phone\'s expiry, last access time and address. Click "Revoke" to cut a phone off immediately; if a phone is lost, use "Revoke all".',
      ] },
      { h: 'What you can do on the phone', tips: [
        'Session list: title, status (running / waiting for permission / done) and last update time. Tap one to see the recent conversation (your messages, AI replies, tool call summaries like "Ran xxx · exit code N"); running sessions refresh every 3 seconds.',
        'Only conversations since the app was last started are shown; older sessions become visible on the phone after you open them once on the computer.',
        'Pending permission cards show the command, host, reason, risk and a "Production" badge. Tap "Allow" or "Deny", with exactly the same effect as on the computer; in the Execution log this approval is marked "Approved on mobile".',
        'For safety, the phone can only "Allow" running commands / reading the terminal on a single host. Dangerous commands on production hosts, file changes (change details aren\'t visible on the phone), multi-host runs, MCP calls and plan approvals can only be "Deny" or "Handle on computer".',
      ] },
      { h: 'Security notes', tips: [
        'Only enable it on a trusted LAN (home / corporate intranet), never on public Wi-Fi (cafés, airports, hotels). Turn it off when not in use; turning it off stops the service and disconnects all phones immediately. Turning it off doesn\'t revoke paired devices: if a phone is lost or you\'re unsure it can be trusted, use "Revoke" / "Revoke all".',
        'It uses HTTP rather than HTTPS: a self-signed certificate makes phone browsers show warnings, which trains people to tap "Continue" without thinking. Anyone on the same network who can sniff traffic could in theory see what\'s transferred, which is why it should only be used on trusted networks.',
        'It binds only to the LAN address you choose. Public addresses don\'t appear in the list and can\'t be selected, and only LAN-origin requests are accepted.',
        'Pairing codes are valid for 5 minutes and single-use. 5 wrong attempts from the same device lock it out for 10 minutes, but that doesn\'t lock your pairing code or stop you from generating a new one. Device tokens are stored only as hashes locally and expire after 30 days.',
        'Content on the phone is redacted: model keys, host passwords / private keys, secret vault values and so on show as `[redacted]`; tool calls show only a summary, not the output.',
        'While the app is locked, the phone only shows "App is locked" and recovers after unlocking. Pairing and approvals are all recorded in the app log.',
      ] },
    ],
  },
  {
    id: 'cron', title: 'Scheduled tasks (crontab / systemd timer)', icon: CalendarClock,
    blocks: [
      { p: 'See at a glance which scheduled tasks a Linux host has and when they run, and create new ones from a single sentence. Linux SSH terminals only.' },
      { h: 'Open', steps: [
        'Switch to an SSH terminal and click "More views" (four-square icon) in the right activity bar → "Scheduled tasks", or search "Scheduled tasks" in the command palette.',
        'Grouped by source: the current user\'s crontab (editable), root\'s crontab, `/etc/crontab` and `/etc/cron.d/*` (read-only), and finally systemd timers (`systemctl list-timers`).',
        'Each entry is translated into plain language ("Daily at 03:00", "Every 5 minutes", "Weekdays at 09:30", "Monthly on the 1st at 00:00"; forms like `@daily` are recognized too). On the right are the next run time (host local time) and how far away it is; the line below shows the original expression, command and user. Tasks commented out with # are marked "Commented out".',
      ] },
      { h: 'Create', steps: [
        'Click "New" in the title bar, describe it in a sentence in the input box (such as "Every day at 3 AM, clean up files in /tmp older than 7 days") and click "Generate with AI" (or Ctrl+Enter). The AI provides the schedule expression, command and description, with a live preview of the plain-language schedule and next run time below.',
        'Everything generated can be edited, or skip the AI and fill in "Schedule", "Command" and "Description" yourself (the description is written as a # comment line above the task). Dangerous operations in the command are highlighted in red.',
        'Click "Add to crontab…" and confirm once more (red warning on production hosts) before it\'s written.',
      ] },
      { h: 'Comment out / restore / delete', p: 'For tasks in the current user\'s crontab, hover to see "Comment out (disable but keep)" / "Restore" and "Delete" on the right; these also ask for confirmation first.' },
      { tips: [
        'Only the current login user\'s own crontab is changed (`crontab -`). Root\'s crontab and system files are read-only; to change them, edit with sudo in the terminal.',
        'Before each write, the original crontab is backed up to `~/.lingshell/backups/` on the host, and the backup path is shown on success. To restore, run `crontab <backup path>` in the terminal. The crontab is re-read just before writing; if the tasks were changed elsewhere in the meantime, the write is refused, so refresh and try again.',
        'Every change (success or failure) is recorded in the "Execution log" with a label like "Scheduled task · Add (manual)" and the backup path.',
        '`%` has a special meaning in crontab and is escaped to `\\%` automatically when adding. Reading root\'s crontab requires passwordless sudo; if it can\'t be read, that\'s noted.',
      ] },
    ],
  },
  {
    id: 'runbook-view', title: 'Runbook view (run step by step manually)', icon: BookOpenText, settings: 'runbooks',
    blocks: [
      { p: 'Shows a whole runbook as "notes + command blocks". Fill in the parameters once at the top, then click each command block to run it in the current terminal; the exit code and duration are shown next to the block (similar to Warp Notebooks). If you\'d rather not click through yourself, you can still "Hand off to AI".' },
      { h: 'Open', steps: [
        'Click "Open" on a runbook in the "Settings → Runbooks" list;',
        'or search "Open runbook view" / "Run step by step: runbook name" in the command palette (`Ctrl+Shift+P`);',
        'or click the book icon "Runbook (run step by step in current terminal)" in the "Multi-host tools" group (the last group) of the terminal\'s right activity bar.',
      ] },
      { h: 'Run', steps: [
        'The dropdown at the top switches runbooks; the top-right corner shows the "current terminal" commands will be sent to (the focused terminal on the right). The view docks on the left, and the terminal on the right stays visible and usable.',
        'Fill in `{{param}}` in the parameter boxes (leave empty to use the default). Parameters not yet filled are flagged in yellow below the command blocks.',
        '"Run in current terminal" next to a command block: as with the Compose bar, dangerous commands, hidden characters, or multiple lines sent to a production terminal ask for confirmation first. After sending it shows "Running…", and when finished "Exit code 0 · 1.2s" (non-zero in red). "Copy" copies only the command with parameters filled in.',
        '"Run all in order (stop on error)": confirm all commands once, then send each block in turn and wait for it to finish. If a block exits non-zero it stops, and the rest are marked "Not run because an earlier step failed". While running you can click "Stop" (it just stops waiting; commands already sent keep running in the terminal).',
        '"Hand off to AI": sends the runbook with parameters filled in to the AI, which runs the steps in the current terminal and checks the expected results (same as "Runbooks" next to the input box). This button is disabled until all parameters are filled, so the AI doesn\'t guess values from placeholders.',
      ], tips: [
        'Exit codes and durations come from the terminal\'s command markers and need bash (local Git Bash / bash over SSH). PowerShell / cmd terminals send without waiting, show "Sent (exit code not available in this terminal)", and can\'t use "Run all in order".',
        'A command block with several lines runs line by line, collecting results per line; the first non-zero exit code is used and durations are summed.',
        'Esc closes the view (when the terminal has focus, Esc goes to the terminal program and doesn\'t close the view).',
      ] },
    ],
  },
  {
    id: 'quick-scope', title: 'Show quick commands only on some hosts', icon: Zap,
    blocks: [
      { p: 'Quick commands and command groups can both be limited to "Show only on these hosts / groups" (multi-select; nothing checked = all hosts). The "Quick commands" bar at the bottom of the terminal and the command palette list only those that apply to the current terminal. Local terminals count as "This machine"; ad-hoc SSH connections (unsaved hosts) only show commands with no scope set.' },
      { h: 'Set up', steps: [
        'Commands: in the quick command list, hover an item and click the pencil "Edit" (or "Add quick command"), expand "Show on", check This machine / groups / hosts, and click "Save".',
        'Command groups: in the command group dropdown at the top left of the list → "Edit current group (name / show on)…" or "New command group…", and check them in "Show on" the same way.',
      ], tips: [
        'If a command group doesn\'t apply to the current terminal, the list automatically shows the first group that does; if none apply, it says "No command groups to show for this terminal".',
        'Hover a command to see its description and "Only on: …" scope. Existing quick command data is unaffected (defaults to all hosts).',
      ] },
    ],
  },
  {
    id: 'ai-propose', title: 'AI-generated quick commands / runbooks', icon: Wand2, settings: 'runbooks',
    blocks: [
      { p: 'After working through a set of checks, tell the AI "Save these checks as quick commands" or "Save as a runbook". The AI turns them into an editable preview card, and nothing is written until you click "Save".' },
      { h: 'Quick commands', steps: [
        'Preview card "AI suggests saving as quick commands": edit the command group name and each item\'s name / command / description, or "Delete this item" / "Add an item".',
        'Click "Save" to write them into "Quick commands" at the bottom of the terminal: if a group with the same name exists they\'re appended to it (identical commands aren\'t duplicated); otherwise a new group is created and selected. "Ignore" writes nothing.',
      ] },
      { h: 'Runbooks', steps: [
        'Preview card "AI suggests saving as a runbook": just like the runbook editor, you can edit the title, description, parameters and steps (check / change, reorder, add, remove). Values that vary (host, path, service name) are turned into `{{param}}` by the AI.',
        'After you click "Save" it appears in "Settings → Runbooks", and the card lets you "Open runbook view" directly to run it step by step.',
      ] },
      { h: 'From the Execution log', p: 'In the session\'s "Execution log", click "Save as runbook" and check the commands to keep. Besides editing it yourself with "Next", you can click "Let AI turn it into a runbook": the checked commands are sent to the AI, which names it, extracts parameters, separates checks / changes, and shows the same preview card in the chat.' },
    ],
  },
  {
    id: 'trend', title: 'Trend forecasts (days until disk full / certificate expiry)', icon: TrendingUp,
    blocks: [
      { p: 'Linear extrapolation from historical data: "/data full in about 9 days", "Certificate expires in 23 days". Under 14 days is yellow, under 3 days is red; no forecast when there isn\'t enough data.' },
      { h: 'Where to see it', steps: [
        'The "Trends" section on the "Health check" page of the Host health check drawer: forecasts per mount point from the health check archive, forecasts from the dashboard\'s recent samples, and certificates expiring within 90 days.',
        'Small text "full in ~N days" next to the "Disk" row on Host dashboard cards (the one filling fastest; the mount point name is added when it isn\'t the fullest one). Hover for all forecasts and their basis.',
      ] },
      { h: 'How it\'s calculated', tips: [
        'Health check archive (long term): one is saved each time you "Start check". Used percentage per mount point is extrapolated with a least-squares line, preferring the last 7 days; if there are fewer than 3 in the last 7 days, all archives are used. It only forecasts with at least 3 data points spanning more than half a day and actually rising. After a cleanup (a drop of more than 5 percentage points) it counts from the cleanup onward, and isolated spikes are removed.',
        'Dashboard samples (short term): only the latest ~60 samples per host are kept (a few dozen minutes). A forecast needs at least 10 points spanning over 10 minutes with a good enough linear fit, and is labeled "Short term, for reference only".',
        'Certificates: remaining days are computed directly from the expiry date collected by the health check.',
      ] },
    ],
  },
  {
    id: 'compliance', title: 'Baseline compliance check (Linux security baseline)', icon: ListChecks, settings: 'compliance',
    blocks: [
      { p: 'A built-in Linux baseline (17 items): no SSH password login for root, no accounts with empty passwords, SSH not on port 22 (advisory), firewall enabled, automatic security updates, separate /tmp mount (advisory), time sync, no extra UID 0 accounts, password policy, auditd, SELinux / AppArmor, log rotation, no world-writable files in /etc, sudo NOPASSWD scope, kernel parameters (IP forwarding [advisory], ICMP redirects, ASLR).' },
      { h: 'Single host', steps: [
        'Switch to a Linux SSH terminal, open "Host health check" in the right activity bar, go to the "Compliance" tab, and click "Start check".',
        'Results are ordered Fail → Advisory → Unknown → Pass, with the pass rate at the top. Click an item to expand its details and "Fix suggestion" (copyable).',
      ] },
      { h: 'Batch', steps: [
        'Use "Batch compliance check" on the "Compliance" tab, search "Batch compliance check" in the command palette, or use the button at the top of "Settings → Compliance baseline".',
        'Check hosts on the left (whole groups at once if you like) and click "Start check": hosts run in parallel and produce a "host × item" matrix: ✓ pass, ✗ fail, ! advisory, ? unknown. Click a cell for details and the fix suggestion.',
        '"Export CSV": each cell is written as "status: note", followed by per-status counts and the check time. Opens in Excel without garbled text.',
      ] },
      { tips: [
        'Read-only: the script runs once over a separate channel, without sudo, changes nothing, and never enters command history or the AI. Fix suggestions are commands only; you review and run them yourself.',
        'Items that need root to read (/etc/shadow, /etc/sudoers, iptables) are marked "Unknown" when checked as a regular user.',
        'Turn off items that don\'t apply (e.g. hosts running Docker need IP forwarding) in "Settings → Compliance baseline"; they are skipped for both single and batch checks, and the item count on the "Compliance" tab updates accordingly.',
        '"Firewall enabled" only checks whether inbound traffic is actually filtered: it passes if firewalld / ufw is running, or nftables / iptables drops inbound by default and has inbound rules. Rules Docker writes to the forward chain don\'t count (otherwise hosts without a firewall would pass by mistake).',
      ] },
    ],
  },
  {
    id: 'deploy-review', title: 'Deploy review (doc analysis, risk detection, environment pre-check)', icon: ClipboardCheck,
    blocks: [
      { p: 'Once developers hand over deployment docs and artifacts, review them here before going live: AI turns the docs into a deployment checklist and finds risks, runs a read-only environment pre-check on the target hosts, gives a recommendation per item and a review verdict, and exports a report. Once approved, convert it into a runbook and follow it.' },
      { h: 'Steps', steps: [
        'Click "Deploy review" in the right activity bar or search "Deploy review" in the command palette, then click "New review".',
        '"Docs & artifacts": import docs (Markdown / Word .docx / PDF / text / HTML, or paste directly); optionally add artifacts (sha256 is computed and archive contents listed); check target hosts; pick Test / Production at the top.',
        'Click "AI analysis": you get a deployment checklist (overview, prerequisites and check commands, steps, config and database changes, verification, rollback). The "Risks" tab lists issues found by rules and by AI, each with evidence and a suggestion.',
        'Click "Environment pre-check": runs the prerequisite check commands on the target hosts (only read-only ones; the rest are marked "Not run"), then AI judges whether each is met, and unmet ones are recorded as risks automatically. If the review environment is Production, or a checked host is marked Production, you\'re asked to confirm first.',
        'On the "Risks" tab, mark each item Accepted / Ignored / Sent back to dev, with an optional note. In "Verdict & report", choose a verdict (one is suggested), enter the reviewer and comments, and export Markdown / HTML / PDF.',
        '"Convert to runbook": pre-checks + deployment steps + verification become a runbook you can run step by step in the terminal from the runbook view.',
      ] },
      { tips: [
        'Rule checks (no model involved): plaintext passwords, high-risk commands, no rollback plan, database changes without a backup, no verification step, downtime not explained, artifact checksum / version not matching the docs, artifacts not mentioned in the docs.',
        'Reimport after the docs change: old versions are kept, and "Compare with previous" shows changed lines. After re-analysis, decisions on the same risk are kept (including ones you changed while analysis was running).',
        'For docs over 60,000 characters, AI only analyzes the first 60,000 (rule checks still read the whole thing); the checklist and Risks tab say so. Please review the rest manually. A single doc can have at most 1,000,000 characters of text; split larger ones.',
        'The pre-check only runs single-line read-only commands (plus a few fixed forms for checking versions, ulimit, and port reachability). Multi-line commands and anything that writes are never run and are marked "Not run".',
        'Docs and pre-check output sent to the model go through "Settings → AI & security → Redact before sending to AI"; quoted doc text and pre-check output in the report are redacted the same way.',
        'Legacy .doc isn\'t supported; save as .docx. Scanned PDFs (images) have no readable text.',
      ] },
    ],
  },
  {
    id: 'chat-plus', title: 'Chat extras (@ mentions / ! run commands / AI question cards / chat navigation and search)', icon: AtSign,
    blocks: [
      { h: '@ mention terminals, hosts, past sessions, files', steps: [
        'Type `@` in the chat input to show suggestions: "Terminals" (currently open), "Hosts" (saved, sorted by group), "Session history" (title + time), "Files" (Choose a local file…).',
        'Keep typing to filter; ↑↓ to select, Enter (or Tab) to confirm, Esc to close, or just click.',
        'The selection becomes a chip above the input (in the same row as attachments); × removes it. Hover a chip to see the text that will be sent to the AI with your message.',
      ], tips: [
        'Terminal / host: tells the AI "the user wants this terminal / host" (with its id), so it doesn\'t have to guess which machine.',
        'Past session: attaches a summary of that session: the compaction summary if it was compacted, otherwise the last few prompts and the AI\'s final replies, up to 2000 characters.',
        'File: like "+ → Add context", only the path is attached; the content isn\'t uploaded.',
      ] },
      { h: 'Starting with !: run a command in the terminal', steps: [
        'Start the input with `!` (e.g. `!df -h`): a yellow "Terminal" marker appears on the left and the send button turns into a terminal icon.',
        'Enter doesn\'t send to the AI; it runs the command in the current terminal on the right. Dangerous commands, commands with hidden characters, and commands on a production terminal ask for confirmation first.',
        'When it finishes, the command, exit code and the tail of the output (up to 4KB) become a "Terminal block" chip above the input. It\'s an attachment for your next message and isn\'t sent on its own.',
        'Then type your question and send, e.g. "Is 67% disk usage OK, which directory takes the most?": the AI sees the output directly without running it again. The chip is cleared after sending.',
      ], tips: [
        'Typical use: run `!df -h`, `!free -m`, `!tail -50 /var/log/nginx/error.log` one after another, stack the three terminal blocks, then ask "What looks wrong here?".',
        'Just want to run a command without asking the AI? Click × on the chip. Leaving it is fine too; it will go along with your next message.',
        'If no terminal is open, the terminal is disconnected, or the AI is running something in it, you get a notice and nothing runs.',
        'Output is processed by the redaction switches in "Settings → AI & security" before it reaches the AI, and plaintext from the secret vault is swapped back to placeholders. The command is recorded in the execution log (chat_shell).',
      ] },
      { h: 'AI question cards', p: 'When the AI needs you to choose between a few clear options (e.g. "restart or reload"), it shows a question card in the chat: single or multiple choice, sometimes with an "Other" text box. Make your choice and click "Submit"; it goes back to the AI, which continues. Clicking "Skip", not answering for 10 minutes, or stopping the turn all count as "user did not answer": the AI won\'t decide for you or run any commands, and only explains what still needs your decision. After you answer or skip, the card collapses to one line (question + your choice).' },
      { h: 'Chat navigation and in-session search', keys: [
        ['Ctrl+↑ / Ctrl+↓', 'With focus in the chat, jump between "my prompts" (skipping tool steps); at the top, earlier messages load. In the terminal these keys are still "Previous / Next command"'],
        ['Ctrl+F', 'With focus in the chat, opens the in-session search bar: highlights matches, Enter / Shift+Enter for next / previous, Esc to close. In the terminal Ctrl+F still goes to the shell'],
      ], tips: ['Clicking an empty spot in the chat counts as "focus in the chat". Change the keys in the "AI chat" group of "Settings → Keyboard shortcuts".', 'Only displayed content is searched; text inside a collapsed "Execution steps" isn\'t highlighted.'] },
      { h: 'Cross-session search and "Ask AI: how did I fix … last time"', steps: [
        'Open "Session history" in the left activity bar and type keywords in the search box (Chinese matches in two-character groups, English / commands match whole words). Or type keywords in the command palette and choose "Search session history content".',
        'Results are grouped by session, each with up to 3 matching snippets (prompt / AI / command, keywords highlighted) and a time. Click a snippet to open that session and scroll to the matching message (if it\'s inside collapsed execution steps, it scrolls to that turn\'s prompt).',
        'When there are results, "Ask AI: how did I fix "…" last time" appears below the search box: it sends the top 3 snippets to the current chat as context chips and asks the AI to summarize the cause and the steps taken.',
      ], tips: ['Search covers prompts, AI replies and commands the AI ran in all sessions, plus actions you took in containers / services / Explorer and other views recorded in the execution log.'] },
    ],
  },
  {
    id: 'terminal-plus', title: 'Scrollbar marks, quick select, instant replay, double-tap Alt to summon', icon: TerminalSquare, settings: 'terminal',
    blocks: [
      { h: 'Scrollbar marks', p: 'A thin ruler on the terminal\'s right scrollbar shows positions across the whole buffer at a glance: left lane green / red = each command you typed succeeded / failed (gray = exit code unknown), middle lane yellow = "Find in terminal" matches, right lane orange = keyword alert matches. Hover a mark to see the start of the command (or alert line); click it to jump to that line. Clicking empty ruler space or dragging the thumb scrolls as usual. The chat has a matching ruler on its right: blue dashes mark each of your prompts; hover to see the start, click to scroll there.', tips: [
        'Command status marks share their source with the green / red dots at line start and need bash (local Git Bash, bash over SSH). Colors follow the current theme.',
        'Alert marks come from rules with the bell turned on in Settings → Terminal → "Keyword highlighting".',
      ] },
      { h: 'Quick select (default Alt+S)', p: 'Press it with focus in the terminal: visible IPs / IPv6, URLs, absolute paths, git hashes / container IDs, ports (like `:8080`) and PID-like numbers are boxed and labeled with letters. Press a letter to copy that item; press Shift+letter to copy and paste it at the prompt. Esc, any other key, or a mouse click exits. With more than 26 candidates, two-letter labels are used.', tips: ['Works even with a Chinese IME on (letters are read by key position).'] },
      { h: 'Instant replay (default Ctrl+Alt+R)', steps: [
        'Press the shortcut with focus in the terminal, or click "Instant replay" (rewind icon) in the right activity bar.',
        'Drag the timeline at the bottom to view the screen at any moment, including screens wiped by `clear`, `top` or `vim`. ← / → step through; Home / End jump to the oldest / newest.',
        'Esc or ✕ at the top right closes it.',
      ], tips: [
        'Each terminal keeps its last 4MB of output in memory (change it in Settings → Terminal → "Instant replay buffer", 0 = off). Nothing is written to disk and it\'s gone when the terminal closes. When full, the oldest output is dropped first, so the earliest bit may look incomplete.',
        'For long-term records, use "Recording & session log".',
      ] },
      { h: 'Double-tap Alt to summon (Quake mode)', steps: [
        'Turn on "Double-tap Alt to summon" under Settings → General → "Window" (saved automatically); it takes effect when "On" appears beside it.',
        'When the app is in the background (minimized or covered), quickly tap Alt twice: the window shows and the cursor goes to the current terminal. Double-tap again while it\'s in front to minimize.',
      ], tips: ['Taps must be within 0.4 s of each other, each held no more than 0.3 s. Alt combined with other keys (Alt+Tab, Ctrl+Alt+…) doesn\'t trigger it.', 'If the app is locked, summoning shows the lock screen; unlock first.', 'Windows only for now.'] },
      { h: 'AI background jobs stay out of your terminal', p: 'When the AI runs long commands as background jobs (builds, installs, `python3 -m http.server` and the like), starting them, checking status and reading logs all use a separate channel: a separate channel on the same SSH connection, or a separate bash process locally. Wrapper commands like `mkdir -p /tmp/lingshell-jobs …` and polling loops no longer show up in your terminal, and the terminal stays free. Jobs start in that terminal\'s current directory; tool cards in the chat still show commands and results.', tips: [
        'Variables you exported or virtual environments you activated in the terminal aren\'t inherited; the AI writes them into the command itself.',
        'WSL terminals have no separate channel, so jobs still run in the terminal, but wrapper commands and output are hidden.',
      ] },
    ],
  },
  {
    id: 'firewall', title: 'Firewall rules (read-only)', icon: ShieldCheck,
    blocks: [
      { p: 'Turns firewalld / ufw / nftables / iptables rules into one table: direction, action (allow / deny), protocol, port, source, and a plain-language note (e.g. "Allow any address to access 22/tcp"). Read-only; rules are never changed. Linux SSH terminals only.' },
      { steps: [
        'Switch to an SSH terminal and click "More views" → "Firewall" in the right activity bar, or search "Firewall rules" in the command palette.',
        'Each detected tool gets a tab; the one actually in effect is marked "Active" and selected by default (firewalld running > ufw enabled > nftables has rules > iptables). The lines above show default policies (e.g. "Inbound default: drop").',
        '"Raw output" shows the original command output (`firewall-cmd --list-all`, `ufw status verbose`, `nft list ruleset`, `iptables -S` / `-L -n -v`).',
        'Type a question in the top box, e.g. "Why can\'t port 8080 be reached from outside?": if it contains a port number, rules for that port are highlighted and you see whether anything is listening on it. Click "Ask AI" to put the question, raw rules and listening status into the chat input (processed by "Redact before sending to AI", not sent automatically).',
      ], tips: [
        'Reading rules usually needs root: it reads directly when logged in as root, otherwise uses passwordless `sudo -n`. If sudo needs a password, it shows "Root required".',
        'Cloud security groups don\'t live on the host and can\'t be seen here; check your cloud console.',
      ] },
    ],
  },
  {
    id: 'ai-terminal-link', title: 'AI and terminal integration (command marks / terminal blocks / alert summary / predicted commands / recording summaries)', icon: Link2, settings: 'terminal',
    blocks: [
      { h: 'Commands run by the AI get a purple mark in the terminal', p: 'Commands the AI runs in a terminal (run command / multi-host run) get a small purple diamond at the start of the line, distinct from the green / red dots on commands you type yourself.', steps: [
        'Hover the purple diamond to see "Run by AI · session title · time" and the command.',
        'Click the purple diamond: the chat on the left switches to that session, expands "Execution steps", scrolls to the matching tool card and flashes it.',
        'Click "Locate in terminal" on a tool card in the chat: switches to the terminal that ran it, scrolls to the start of that command\'s output and flashes it.',
      ], tips: [
        'The link lives in memory only: after an app restart, closing the terminal, clearing the screen, or the output scrolling past "Scrollback lines", the mark disappears and "Locate in terminal" says "Output is no longer in the terminal buffer".',
        'Commands not run through the chat, such as one-click rollback or inspections, aren\'t marked.',
        'AI background jobs (start / check background job) use a separate channel and have no output in the terminal, so they aren\'t marked and their cards have no "Locate in terminal".',
      ] },
      { h: 'Terminal blocks: attach commands and output to the chat', steps: [
        'Click the green / red dot at the start of a command and choose "Attach to chat": the command line, exit code, directory and output (only the tail if over 8KB) become a "Terminal block" chip above the input. Attach several in a row, then type a question and send.',
        'You can also select text in the terminal and drag the selection onto the chat input to create a terminal block containing only that output text.',
        'Hover a chip to see its content; × removes it. On send, each block is appended to your message as text.',
      ], tips: ['Output goes through "Settings → AI & security → Redact before sending to AI" (on by default); passwords, tokens and the like become [REDACTED].'] },
      { h: 'Alert summary', p: 'Every line matched by a rule with the bell on in "Settings → Terminal → Notifications → Keyword highlighting" is collected under "Alerts" (siren icon with an unread count) in the terminal\'s right activity bar. The last 500 entries are kept in memory.', steps: [
        'Click "Alerts" to open the drawer: each entry shows the time, terminal, rule and the line itself, newest first.',
        'Click an entry to switch to that terminal and scroll to the line (it flashes).',
        '"Ask AI": puts the line plus 20 lines before and after into the chat input (processed by your redaction settings); add a question and send.',
        '"Clear" removes all entries.',
      ], tips: ['System notifications / tab badges are still limited to once per rule every 30 seconds; the summary records every line (up to 20 per output burst, to avoid flooding). Output while the AI is running, or inside full-screen programs like vim / less, doesn\'t count.'] },
      { h: 'AI predicts your next command', p: 'With "Settings → Terminal → Input → AI predicts next command" turned on (off by default), when the prompt has been empty for 0.8 seconds the current model is asked once, based on this terminal\'s last 5 commands and the end of the last output, and the predicted command is shown in gray after the cursor.', steps: [
        'Press `→` to put the prediction at the prompt (without Enter); press Enter yourself once you\'ve checked it.',
        'Press any other key to dismiss it and type as usual.',
      ], tips: [
        'Asked once per prompt, at most 6 times a minute. Nothing shows if no API Key is set or the model isn\'t confident.',
        'On production hosts only commands are sent, not output; output goes through "Redact before sending to AI".',
        'No prediction while the command completion popup is open. Only the terminal with keyboard focus gets predictions.',
      ] },
      { h: 'AI recording summaries', steps: [
        'In "Settings → Terminal recordings", click "AI summary" in a recording\'s actions column: the recording is split by command (commands run by the AI count too), the command sequence and a digest of each output segment are sent to the current model, and it produces chapters of "timestamp + what happened". They\'re saved to a .summary.json next to the recording, and replay opens automatically when done.',
        '"Chapters" on the right of the replay window lists each chapter; click one to jump to its time. The chapter currently playing is highlighted. Without a summary, click "Generate AI summary"; with one, click the refresh icon to regenerate.',
      ], tips: [
        'Only output is sent, never keystrokes (which may contain passwords). Output goes through "Redact before sending to AI", and only the start and end of each segment are used.',
        'Replay compresses idle gaps longer than 2 seconds, and chapter times already reflect that. Deleting a recording also deletes its summary file.',
      ] },
    ],
  },
  {
    id: 'topology', title: 'Service topology (who talks to whom)', icon: Network,
    blocks: [
      { p: 'Draws connections between processes / containers on a Linux host as a graph: entry points (services listening on external addresses) on the left, internal services in the middle, databases / middleware and external addresses on the right. An arrow A → B means A is connected to that port on B; thicker lines mean more connections. Read-only, Linux SSH terminals only.' },
      { steps: [
        'Switch to an SSH terminal and click "More views" → "Service topology" in the right activity bar, or search "Service topology" in the command palette.',
        'Click a node to highlight its connections; below it lists the PID, listening addresses, counts of external inbound / local inbound / outbound connections, and each relationship. Click empty space to deselect. "Refresh" at the top right collects again.',
        'Connections to addresses outside the host are grouped into "External address:port" nodes (e.g. an external database). Docker containers are shown by name (recognized via port mappings or container networks).',
      ], tips: [
        'Data comes from `ss -tnp` (established), `ss -ltnp` (listening) and `docker ps` / `docker network inspect` at the moment of collection. It\'s a snapshot, not live traffic, so short-lived connections may be missed.',
        'Seeing other users\' process names needs root or passwordless sudo; otherwise nodes are shown by port.',
      ] },
    ],
  },
  {
    id: 'config-explain', title: 'View config files with explanations', icon: FileSearch,
    blocks: [
      { p: 'When you open a common config file in Explorer, the editor gets an "Explain" button at the top right: AI explains each section (block / directive) in plain language, with risk notes and suggested changes (e.g. "PermitRootLogin yes: allows remote root login; consider prohibit-password").' },
      { steps: [
        'Recognized files: nginx.conf and configs under conf.d / sites-enabled, sshd_config (including sshd_config.d), my.cnf / mysqld.cnf, redis.conf, docker-compose.yml / compose.yaml, systemd units (.service / .timer etc.), /etc/fstab, sysctl.conf / sysctl.d. Detected by file name; works locally and remotely.',
        'Click "Explain" to open the side panel; risky entries are marked yellow / red. Click an entry to highlight and select the matching lines on the left. With the panel open, click a line number on the left to jump to the entry explaining that line.',
        'Results are cached by file content (config-explain in the data directory). If the content hasn\'t changed, reopening shows it straight away (marked "From cache") without a new request. After edits, the panel shows "Content changed, explain again"; the refresh button at the top right ignores the cache and starts over.',
      ], tips: [
        'It explains the current content of the editor. Before sending to AI, passwords etc. are redacted by "Redact before sending to AI" (replaced line by line, line numbers unchanged). For very long files, only the first 1500 lines are explained.',
        'AI explanations are for reference only; double-check before changing a config.',
      ] },
    ],
  },
  {
    id: 'file-preview', title: 'File preview (images / Markdown / CSV / PDF)', icon: Eye,
    blocks: [
      { p: 'Double-click (or right-click "Preview") these files in Explorer to view them inside the app, locally or remotely: images (png / jpg / gif / webp / svg / bmp), Markdown (.md), CSV / TSV, PDF.' },
      { steps: [
        'Images: full-screen view, scroll to zoom, drag to pan, "Fit to window" / "1:1", double-click to toggle.',
        'Markdown: rendered (tables, code blocks, lists); "Edit" at the top right switches to the text editor for the source.',
        'CSV / TSV: shown as a table (first row as header, with row numbers); "Search all columns" filters. Up to 2000 rows are shown.',
        'PDF: built-in PDF viewer (paging, zoom, search). If it won\'t display, click "Open with system app".',
      ], tips: [
        'In-app preview size limits by type: Markdown 2MB, CSV / TSV 5MB, images / PDF 20MB (Markdown renders in one go and tables show only the first 5000 rows; anything bigger would lag). Larger files prompt you to download instead.',
        'Remote "Open with system app" downloads at most 30MB (it reads into memory and then writes to a temp directory). For larger files use "Download": streamed, with progress, pausable, and it won\'t freeze the main process. Local "Open with system app" hands the file straight to the system default program without the app reading it, so this limit doesn\'t apply.',
        'Other files still open in the text editor on double-click; for previewable files, right-click "View/Edit" to see the source.',
      ] },
    ],
  },
  {
    id: 'safety-flow', title: 'Layered rules, AI review, dry-run mode and timed elevation', icon: ShieldCheck, settings: 'ai',
    blocks: [
      { h: 'Layered rules (global → group → host → working directory)', p: 'Rules for the AI can be written at four levels; the more specific one wins:', steps: [
        'Global: "Global custom rules" in "Settings → AI & security", applied to all sessions.',
        'Group: click "Hosts" in the title bar to open the host panel, right-click a group → "Group rules…". Example for a database group: "Never restart mysqld; run mysqldump before any change".',
        'Host: in the host panel, right-click a host → "Rules…", or edit the host in "Settings → Hosts & connections" and fill in "Rules".',
        'Working directory: if the session\'s working directory (input "+" → "Working directory") contains `AGENTS.md` or `.lingshell/rules.md`, it is read automatically; edits apply from the next request.',
      ], tips: [
        'Group / host rules are only injected after the AI has used that host (opened / used its terminal, or accessed it in a cross-host question), so unrelated hosts don\'t take up context.',
        'Total injected length is capped. When over the limit, more specific layers are kept first (working directory > host > group), and what doesn\'t fit is listed by name only. Don\'t put passwords or other secrets in rules.',
      ] },
      { h: 'AI review (a second model checks high-risk commands)', steps: [
        'In "Settings → AI & security → AI review", turn on "Enable AI review", pick a "Review model" (you can choose a cheaper model profile) and the "Review scope": write commands on production hosts / all dangerous commands / all write commands.',
        'Commands in scope go to the review model before the permission card appears (with the host, recent session context, and that host\'s rules and knowledge card titles; file writes also include the diff, redacted by "Redact before sending to AI" with vault values swapped for placeholders). The card shows "AI review: risk · reason".',
        'When the review says "Suggest blocking", the command is denied by default and the reason is passed to the AI (the execution log records "Blocked by AI review"). Set "When review suggests blocking" to "Warn only, don\'t block" to show the card as usual.',
      ], tips: [
        'Review has a 15-second limit. On timeout or error the card shows "AI review: not reviewed" and appears as usual.',
        '"Safe" never auto-approves on its own. The card is skipped only when "Auto-approve if review passes" is on, the host isn\'t production, the session trust level is "Confirm", and the command isn\'t dangerous (the execution log notes "Passed AI review").',
        'Review results are written to the execution log (session permissions drawer → "Execution log").',
      ] },
      { h: 'Dry-run mode (plan, don\'t act)', steps: [
        'Click the flask button (Dry run) on the right of the session title bar, left of "New session". The button lights up and shows "Dry run", and a "Dry-run mode" bar appears above the input (click the button again or × on the bar to turn it off). Applies to the current session only.',
        'While on, the AI can still investigate read-only, but write commands, file writes, uploads and external tool calls are blocked (the execution log records "Blocked by dry run (not executed)"). It writes the full plan and the impact of each command in its reply.',
        'A "Plan steps" card appears at the end of the reply: check the steps you want and click "Run selected steps". Dry run turns off, the selected steps go to the AI as an approved plan, and commands that match exactly don\'t ask for permission one by one.',
      ], tips: [
        'Plan steps come from the AI\'s plan tool. If the AI didn\'t make a plan, the card takes commands from bash code blocks in the reply; these have no target terminal, so permission is asked as usual when they run.',
        'The dry-run switch is in memory only; after an app restart you\'re back in normal mode.',
      ] },
      { h: 'Timed sudo elevation', steps: [
        'When the AI wants to run `sudo …` (or a write command on a host logged in as root), the permission card gets an extra line "Allow elevation on this host for [15 minutes]", with 5 / 15 / 60 minutes. Check it, then click "Allow".',
        'During that time, commands needing elevation on this host don\'t prompt one by one, and the execution log marks them "Timed elevation". Dangerous commands and those matching an "Always ask" rule still ask.',
        '"Timed elevation" in the session permissions drawer shows the time left and offers "Revoke now"; it\'s revoked automatically when it expires. Memory only; an app restart cancels it.',
      ] },
    ],
  },
  {
    id: 'ai-troubleshoot', title: 'One-click AI troubleshooting for alerts', icon: Siren,
    blocks: [
      { p: 'Click "Troubleshoot with AI" wherever an alert appears: a new session opens (titled "Troubleshoot: host alert") and sends "<host> has <alert>: <context>, please find the cause" to the AI without interrupting your current chat. Redaction rules are applied before sending.' },
      { h: 'Entry points', steps: [
        'Terminal keyword alerts: while you\'re viewing that terminal, a notice "Alert: …" with "Troubleshoot with AI" appears at the bottom left (it hides after 10 seconds, but stays while hovered). If you\'re not viewing it, you get the usual tab badge / system notification, and the notice shows when you switch back. Context is the terminal\'s last 40 lines of output.',
        'Host health check "Issues found": "Troubleshoot with AI" after each issue; context is a summary of that health check.',
        'Host dashboard anomaly cards: "Troubleshoot with AI" on the red anomaly line; context is current metrics, recent alerts, health check and trends.',
      ], tips: [
        'The AI investigates read-only first and gives a cause with evidence. If changes are needed, it explains the impact and how to roll back, then waits for your confirmation.',
        '"Ask AI" in the dashboard card menu still sends to the current session.',
      ] },
    ],
  },
  {
    id: 'background', title: 'Tray, floating ball and launch at startup', icon: AppWindow, settings: 'general',
    blocks: [
      { p: '"Settings → General → Startup & background": changes apply and save immediately.' },
      { h: 'Launch at startup', p: 'With "Launch at startup" on, LingShell starts automatically when you log in (off by default). Also turn on "Start in tray only" to skip the main window at launch and wait in the system tray; AI sessions, inspections and watchdogs keep running. Turning the switch off removes the startup entry from the system.', tips: [
        'The dev build registers electron.exe + the app directory; rely on the installed build. Not supported on Linux yet.',
        '"Start in tray only" is Windows only: login items on macOS 13+ can\'t launch hidden, so the option isn\'t shown there.',
      ] },
      { h: 'Startup splash', p: 'A separate loading window (logo, status text and progress bar, about 3 seconds) shows first; the main window only appears once its content is ready, so there\'s no white flash. If rendering fails, the main window still shows after at most 12 seconds. With "Start in tray only", neither the splash nor the main window is shown.' },
      { h: 'System tray', p: 'While the app runs, the LingShell icon sits in the tray. Hover it to see "LingShell · N sessions running · M pending approvals"; a red dot appears at the icon\'s top right when approvals are pending.', tips: [
        'Left click: show / hide the main window. Double-click: show the main window.',
        'Right-click menu: Show main window, New session, New local terminal, Connect to host (saved hosts), Pending approvals (each entry is "session title · command"; click to switch to that session and handle it), Dashboard, Watchdogs: Pause all / Resume all, Show floating ball, Lock app (only available with app lock enabled), Settings, Quit.',
        '"Minimize to tray when closing the main window" is on by default: clicking × at the top right just hides to the tray, and the first time a notification says "LingShell is still running in the background; open it from the tray". To really quit, use "Quit" in the tray or floating ball right-click menu; if transfers are still running you\'re asked to confirm. With this switch off, × quits directly.',
        'While the app is locked, the tray only shows "LingShell (locked)" and the right-click menu only has "Show main window" and "Quit".',
      ] },
      { h: 'Floating ball', p: 'Turn on "Show floating ball" (or search "Floating ball" in the command palette) and a small always-on-top ball appears on the desktop: gray = idle, spinning blue = AI running, flashing orange + number = approvals pending, red = watchdog alarm or recent AI error (clears once you view the main window).', tips: [
        'Hover to expand a status card: running sessions, pending approvals (command + host + "Handle"), watchdogs, transfer progress, and the current host\'s CPU / memory (only with "Host stats collection" on). The card lists up to 5 sessions and 3 pending approvals, with "N more" beyond that; the number in the heading is the total. Move the mouse away to collapse it.',
        'Left click: show / hide the main window. Right click: Show main window, Quick ask (opens the main window and focuses the chat input), Handle pending approvals, Open dashboard, Pause / resume watchdogs, Lock app, Opacity (40% / 60% / 80% / 100%), Hide floating ball, Quit.',
        'Drag it anywhere; the position is remembered. Dragged to the left or right screen edge it snaps, and with "Auto-hide at edge" on only half the ball shows after the mouse leaves; hover to slide it out fully. After switching monitors / changing resolution it moves back on screen automatically.',
        'While the app is locked the ball shows a lock, hovering only shows "Locked", and the right-click menu only has "Show main window", "Hide floating ball" and "Quit".',
      ] },
    ],
  },
  {
    id: 'conn-probe', title: 'Connectivity probe', icon: Radar,
    blocks: [
      { p: 'For "why can\'t A reach B": test DNS resolution, TCP ports and HTTP status codes from several source hosts (including this machine) to several targets at once. The result is a "source × target" matrix that shows at a glance where it breaks. Read-only.' },
      { steps: [
        'Search "Connectivity probe" in the command palette, or click "Test connectivity" in the "Firewall" view (the current host is preselected as a source).',
        'Check sources on the left: this machine, saved hosts (by group), and online SSH terminals that aren\'t saved. On the right, enter one target per line: `host:port` (e.g. `db.internal:3306`), a URL (e.g. `https://api.example.com/health`) or a domain name.',
        'Check what to test: "DNS resolution", "TCP port", "HTTP status" (all checked by default), then click "Start probe" (or Ctrl+Enter).',
        'Each matrix cell: green "✓ time" = all OK; red "✗ reason" = failed (resolution failed / connection refused / timeout / network unreachable / certificate error, etc.); yellow "! HTTP 503" = connected but status 4xx / 5xx; gray "? … can\'t test" = a command is missing on the source host. A whole row of red "Connection failed" means the source host itself couldn\'t be reached.',
        'Click a cell to see each check\'s result, time, command used and raw output below; click again to collapse.',
        '"Copy as Markdown" copies the whole table and the failure details; "Ask AI to analyze" puts it in the chat input (not sent automatically) so the AI can reason about it together with the firewall and so on.',
      ], tips: [
        'No DNS check when the target is an IP; no TCP check without a port; no HTTP check for non-URLs (those cells show "N/A"). URLs without a port are TCP-tested on 80 / 443.',
        'Remote hosts use getent (falling back to nslookup / host), bash /dev/tcp + timeout (falling back to nc), and curl (falling back to wget). This machine uses the app\'s built-in networking and doesn\'t depend on local commands. DNS times out after 5 s (shown as "DNS timeout", distinct from "Resolution failed"), TCP after 3 s, HTTP after 8 s. Targets run in parallel, so one stuck target doesn\'t hold up the rest.',
        'IPv6 can be written as `::1` (resolution / HTTP only); to test a port write `[::1]:443`. Credentials in URLs (`https://user:pass@host`) are stripped and never appear on remote command lines or in results. "Ask AI to analyze" goes through "Redact before sending to AI".',
        'Commands use a separate channel; they don\'t enter the terminal or command history and aren\'t written to the execution log. Saved hosts without an open terminal are connected temporarily and disconnected when done.',
      ] },
    ],
  },
  {
    id: 'disk-usage', title: 'Disk usage analysis (what\'s using the space)', icon: HardDrive,
    blocks: [
      { p: 'After a disk alert, see in one screen which directories and files are using space, and find files that are "deleted but still held open by a process". Read-only: it only uses du / find / df / lsof to measure and never deletes anything. Works in local terminals (measured with Git Bash) and Linux / macOS SSH terminals.' },
      { steps: [
        'Open it from "More views" → "Disk usage" in the right activity bar; "Analyze usage" on a disk item in host health check "Issues found" (goes straight to that partition); right-click a directory in Explorer → "Analyze disk usage"; or search "Disk usage analysis" in the command palette.',
        '"Directory usage" tab: subdirectories and files in the current directory sorted by size, with bars showing their share. Click a directory to drill down; click a segment of the path above or "↑" to go up, or type a directory in the path box and press Enter. The top shows the partition\'s used percentage and free space.',
        '"50 largest files": files over 50MB under the current directory (same partition), largest first.',
        '"Common hogs" (Linux only): how much system logs, journal, Docker, package caches, core files, temp directories and ~/.cache take, with suggested cleanup commands.',
        '"Deleted but still open" (Linux only): files that were deleted while a process still holds them open. When `df` says full but `du` can\'t find it, this is usually why. Lists the process, PID and size; space is freed only after that process restarts.',
        'Hover a directory and click the folder icon to "Open in Explorer". "Ask AI how to clean up" at the top puts the measured results (processed by your redaction settings) into the chat input.',
      ], tips: [
        'Only the same partition is measured (du -x). Each run takes at most 25 s (40 s for large files); on timeout it shows "Timed out, only partially measured".',
        '"Common hogs" takes at most 20 s in total. With many or very large directories, when time runs out it says "Some items weren\'t measured in time" rather than failing the whole page.',
        'Without root, other users\' directories can\'t be read and it shows "N locations unreadable, results may be low"; for deleted files you only see your own processes.',
      ] },
    ],
  },
  {
    id: 'git-assistant', title: 'Git assistant', icon: GitBranch,
    blocks: [
      { p: 'In the repository of the current terminal: view changes and diffs, stage and commit, manage branches / tags / remotes, browse the commit graph, compare revisions, stash, blame line by line, resolve conflicts, and clean up commits. AI can also write commit messages, review changes and generate changelogs. Works in local terminals and Linux / macOS SSH terminals.' },
      { steps: [
        'Click "Git assistant" (branch icon, below "Command history") in the right activity bar, or search "Git assistant" in the command palette. By default it reads the repository containing the terminal\'s current directory (subdirectories work too). Change the directory in the box above and press Enter; "Follow terminal directory" re-targets the terminal; local terminals also have "Choose directory…".',
        'The "Changes" tab groups files into "Conflicts / Staged / Unstaged / Untracked"; the letter is the status (M modified, A added, D deleted, R renamed, U conflict, ? untracked). Click a file name to see its diff. Hunks can be staged individually, and the list button at a hunk\'s top right lets you stage / unstage / discard by line.',
        '"AI commit message" generates a message from the staged diff; "Commit (N)…" runs git commit after confirmation, with an "Amend last commit" option, or "Commit and push". The top has fetch / pull (merge / rebase / ff-only) / push.',
        'The "Branches" tab switches, creates, renames, deletes, merges and rebases, and manages tags and remotes. The "History" tab shows the commit graph, searches by message / author / code, compares revisions, and cherry-picks / reverts / resets / checks out. Right-click a commit for "Clean up commits from here" (interactive rebase: squash, reorder, reword, drop) or "New branch from here".',
        'The "Stash" tab stashes current changes (optionally including untracked files), shows the files and diffs inside, and applies / pops / drops.',
        'When there are conflicts, a red bar "Conflicts: N files" appears at the top. Click a conflicted file to open the three-way merge editor (current / base / incoming), choose hunk by hunk or edit by hand, then save and mark resolved. You can also "Let AI resolve conflicts", or after resolving use "Continue / Skip / Abort" in the banner.',
      ], tips: [
        'Status and diffs are read over a separate channel (a separate exec channel over SSH, a background Git Bash locally), so they don\'t flood your terminal or enter command history.',
        'Writes such as stage, commit, push and reset are recorded in the "Execution log" (with exit code). Discard, delete, force push, rebase and other risky actions ask for confirmation first. Push uses --force-with-lease, so it never blindly overwrites others\' commits.',
        'AI commit messages / change review / changelogs are one-off model calls and count toward usage. Before sending, content goes through "Redact before sending to AI", secret vault values become placeholders, and overly long diffs are truncated.',
        'The merge editor refuses to save binary files, files over 3MB, or files changed by another program after opening. For those conflicts, use git checkout --ours / --theirs in the terminal to pick a side, then git add.',
        'Locally you need Git for Windows (Git Bash); remote hosts need git installed. Windows SSH hosts aren\'t supported.',
      ] },
    ],
  },
  {
    id: 'file-links', title: 'Open error locations in one click (file:line / VS Code Remote)', icon: FileCode2, settings: 'general',
    blocks: [
      { p: 'Error and stack lines in the terminal like `src/foo.ts:42:7`, `File "app.py", line 12`, `at x (Main.java:88)`, `main.go:31`, `a.ts(42,7)` or `--> src/main.rs:10:5` get underlined on hover; Ctrl+click opens the file in an editor at that line.' },
      { steps: [
        'Local terminal: relative paths resolve against the terminal\'s current directory; if not found, it searches the current directory by file name (e.g. Java stacks with only `Main.java`), and opens with "Settings → General → External editor" at that line.',
        'SSH terminal: clicking shows a small menu. "Open in local editor" downloads to a temp directory and jumps to the line, uploading automatically on save (same as "Open in local editor" in Explorer). "Open with VS Code Remote" edits the file on the server directly in VS Code.',
        'In Explorer (SSH), right-click a directory → "Open with VS Code Remote" to open the whole remote directory in VS Code.',
        'The line-jump arguments are in "Settings → General → Go-to-line arguments": by default they\'re detected from the editor (VS Code / Cursor use `code -g`, JetBrains uses `--line`; Notepad++ and Sublime are recognized too), or you can customize them. With no external editor set, VS Code is tried first, then the system default program (without jumping to the line).',
      ], tips: [
        'VS Code Remote connects with the system ssh. The first time you use a host it asks for confirmation, then appends a Host entry marked "Managed by LingShell" to the end of `~/.ssh/config` (with ProxyJump if there\'s a jump host). Only that block is changed; your own entries are left alone.',
        '`~/.ssh/config` is replaced atomically: even if the app crashes or the file is briefly locked by the system mid-write, no half-written config is left behind. Existing file permissions are kept, and if the config is a symlink, the real target file is written.',
        'Requires VS Code on this machine (`code` on PATH) and the Remote - SSH extension. For hosts whose key is stored in LingShell, add the private key to ssh-agent or put it under ~/.ssh; for password hosts, VS Code will prompt for the password itself.',
        'URLs and "domain:port" (e.g. example.com:443) aren\'t matched; only common source / config extensions and file names like Dockerfile and Makefile.',
      ] },
    ],
  },
  {
    id: 'api-debug', title: 'API debugging', icon: Send,
    blocks: [
      { p: 'A request panel like REST Client / Postman: fill in method, URL, headers and body, click "Send", and see the status code, time, response headers and body. Send from this machine, or from a connected SSH host (to reach internal APIs too).' },
      { steps: [
        'Click "API debugging" (paper plane icon, in the bottom group) in the right activity bar, or search "API debugging" in the command palette.',
        'Choose the method and enter the URL. On the "Headers" tab add headers line by line (uncheck on the left = don\'t send for now). On the "Body" tab choose JSON / form (one key=value per line) / form with files (file fields use key=@path) / raw; Content-Type is added automatically for JSON and form if you didn\'t set it (the sending side generates the boundary for file forms). Press Enter in the URL box or click "Send"; in other inputs use Ctrl+Enter.',
        'The response area shows the status code (2xx green, 3xx blue, 4xx orange, 5xx red), time and actual byte count. JSON in "Body" is formatted automatically; click "JSON tree" for a tree view and to copy jq paths. "Headers" shows all response headers. "Copy" copies the raw response body, not the prettified text. Redirects aren\'t followed; 3xx is shown as is.',
        '"Send from" at the top right: "This machine" or any open SSH terminal (Linux / macOS). With a host selected, the request is sent with curl on that host (~/.curlrc isn\'t read and URL globbing is off); the URL, headers and body are passed to curl via stdin, so they never appear on the remote command line. Production hosts are marked with a red "Production".',
        '"Save" stores the current request in "Collections" on the left (click a saved request, edit, and "Save" again to update). "History" lists the last 50 sends (including failure reasons); click one to reload it. "Import from curl" turns a pasted curl command into a request; "Copy as curl" does the reverse (HEAD uses -I, and [] {} in URLs aren\'t globbed).',
        '"Environments" tab: add environments (e.g. dev / staging), each a set of variables. Pick the current one from the "Environment" dropdown at the top right; `{{base}}` in a request is replaced by the current environment\'s value, and variable values can reference other variables.',
      ], tips: [
        'For passwords / tokens, write `{{secret:name}}` (the name in the secret vault). It\'s swapped for the plaintext in the background only when sending, and the send location is checked against the secret\'s "Allowed scope". Works in the URL, headers and body (including forms), and plaintext echoed back in responses is swapped back to the placeholder. Collections, history and "Copy as curl" only contain placeholders / variable templates, never expanded values.',
        'Collections, environments and history are saved in api-debug.json in the data directory (readable only by you; if the file is corrupted, it\'s backed up as .corrupt-* and started fresh), saved automatically on change. Only http:// and https://. 30-second timeout; response bodies show up to 2MB (streamed, so large files aren\'t read into memory whole). Binary content like images isn\'t displayed.',
        'In a normal body, content starting with `@` is sent literally and never reads files. Only file fields `key=@path` in the "form with files" body read files: with "This machine" the path is a local file; with an SSH host it is a file on that host. Newlines / NUL in headers are stripped to prevent header injection.',
        'The dialog only closes via × at the top right or Esc.',
      ] },
    ],
  },
  {
    id: 'certs', title: 'Certificate and domain inspection', icon: FileKey2, settings: 'schedules',
    blocks: [
      { p: 'Checks HTTPS certificates from outside by domain or host:port (CDNs, load balancers and commercial certificates all work, not just letsencrypt): days left, issuer, whether the certificate covers the domain, whether the chain is complete, and protocol version. Checked automatically once a day, with reminders before expiry.' },
      { steps: [
        '"Certificate and domain inspection" on the "Settings → Scheduled inspections" page: enter `example.com` or `api.x.com:8443`, choose where to check from (default "Check from this machine"; for internal-only sites choose "Check from <host>"), and click "Add and check". Searching "Certificate and domain inspection" in the command palette also gets you there.',
        '"Discover from host": pick a host; its nginx / apache configs are read for HTTPS-enabled domains, which you can check and add.',
        'Each entry shows "N days left": within 30 / 14 / 3 days it\'s marked yellow / orange / red; expired and failed checks are red. Problems are flagged as "Domain mismatch", "Missing intermediate", "Self-signed" or "Untrusted". The line below shows expiry date, issuer, protocol and the domains in the certificate.',
        '"Check all now", or ▶ check now on each entry. "Check daily", "Remind days before" and "Push to group bot" can be changed in the same place.',
      ], tips: [
        'Checks only run while the app is open (like scheduled inspections), once 24 hours have passed since the last full check.',
        'Reminders: entering the yellow / orange / red tier or expiring triggers a system notification and a push to the bots enabled under "Alert push (group bots)" on this page. Expiring within 3 days, expired, and failed checks remind once a day; once renewed and back to normal, reminders stop.',
        '"Check from host" runs `openssl s_client` (read-only) on that host, which needs openssl installed. The host dashboard shows "N certificates expiring within 30 days" at the top.',
        'Entries appear in the list right after adding; if the immediate first check fails, the entry is kept with the reason, and you can click ▶ to retry.',
        '"Discover from host" only reads nginx / apache configs that aren\'t commented out and actually enable HTTPS: a commented-out `ssl_certificate` won\'t list a plain HTTP site by mistake, and `listen 8443` isn\'t taken as 443.',
      ] },
    ],
  },
  {
    id: 'local-views', title: 'Local views (containers / ports / processes)', icon: MonitorDot,
    blocks: [
      { p: 'When you switch to a local terminal, the right activity bar also has "Processes (local)", "Containers (local Docker)" and "Listening ports (local: what\'s using a port)" buttons, using the same drawers as for SSH hosts to look at this machine. Data is fetched in the background, not by running commands in your terminal.' },
      { steps: [
        '"Listening ports (local: what\'s using a port)": lists TCP ports listening on this machine and the process name / PID using each (Windows uses netstat -ano + tasklist). Type 3000 in the box above to find the process on port 3000; "End process" on that row ends it after confirmation (on Windows, taskkill /F force-kills it).',
        '"Processes (local)": lists local processes (Windows shows image name, session and memory; no CPU% or command line). Click a row to "End (taskkill)" or "Force end (taskkill /F)", with confirmation.',
        '"Containers (local Docker)": uses the local docker command to list containers, view logs, open a shell in a container, and start / stop. The "Compose projects" tab manages docker compose projects.',
      ], tips: [
        'If Docker isn\'t installed, the drawer says "Docker is not installed on this machine"; if Docker Desktop isn\'t running, it asks you to start it first.',
        'Ending processes and starting / stopping containers / Compose projects are recorded in the "Execution log". System processes (PID 0 / 4) can\'t be ended; ending admin or other users\' processes requires running LingShell as administrator; LingShell\'s own processes can\'t be ended.',
      ] },
    ],
  },
  {
    id: 'database', title: 'Database quick query, scripts and backup (MySQL / PostgreSQL / Redis / MongoDB)', icon: Database,
    blocks: [
      { p: 'Uses the `mysql` / `psql` / `redis-cli` / `mongosh` already installed on the host (or this machine), or `docker exec` into a database container, to view sessions, lock waits, aggregated slow queries, table sizes, replication status and schema, and to run read-only queries. For Redis: overview, clients, keys, slow log, big keys and memory. Queries use a separate channel, so they don\'t flood your terminal or enter command history. No database drivers need to be installed in LingShell.' },
      { steps: [
        'Click "More views" → "Database" in the right activity bar (also available for local terminals), or search "Database quick query" in the command palette.',
        'First time, click "New connection": choose the "Host" (where commands run; for an SSH host, open its terminal first), "Type", and "Connection method" ("Local client" or "Docker container" + container name), address / port (empty = client default, connects locally), user and database; pick the "Password" from the secret vault. Click "Test connection"; once you see the version number, "Save".',
        'The dropdown at the top left switches connections; "Database" on the right switches the current database (MySQL / PostgreSQL list all databases; Redis lists db0–db15 with key counts; each connection remembers the last one used). MySQL / PostgreSQL tabs: "Sessions" (processlist / pg_stat_activity, idle hidden by default, ≥ 10 s marked yellow, lock waiters red), "Lock waits" (who waits on whom), "Slow queries", "Table sizes" (top N tables), "Replication", "Query", "Schema".',
        'Common result table actions: click a column header to sort (again to reverse, a third time to clear); drag a header\'s right edge to resize. "Filter results" above keeps only rows containing the keyword. "Copy" offers tab-separated (paste straight into Excel) / CSV / Markdown / INSERT statements; "Export CSV" saves to a file (opens in Excel without garbled text). Click a cell to select it and Ctrl+C to copy; right-click to copy the cell / whole row / INSERT for this row. Over 1000 rows are shown in batches; results over 1.5MB return only the first rows, with a notice.',
        '"Slow queries": for MySQL it reads the slow log (last 4MB of the file, or mysql.slow_log when log_output=TABLE) and groups similar SQL by fingerprint (numbers / strings become ?, IN lists folded), with count, total time, average, max and average rows examined. Click a row to see the slowest instance; "EXPLAIN this" takes it to the "Query" tab and shows the plan. PostgreSQL reads pg_stat_statements (the extension must be installed first).',
        '"Query": write one SQL statement and click "Run" (Ctrl+Enter) to run it read-only against the current database; results appear in the table below (with time and row count). The editor has SQL syntax highlighting; "History" lists the last 50 statements run on this connection; click one to put it back in the editor. Without its own LIMIT, a statement shows 100 rows per page by default (100 / 200 / 500 / 1000), with previous / next page, fetching only the current page from the database. Only a single SELECT / SHOW / DESCRIBE / EXPLAIN is allowed; writes, multiple statements, FOR UPDATE and functions with side effects are rejected, and the session is also set to a read-only transaction. "EXPLAIN" shows the plan without actually running it; "Ask AI to interpret" sends the SQL and plan to the chat so the AI can point out full table scans, unused indexes and the like, with suggestions.',
        '"Schema": the left side lists tables and views in the current database (filterable, with sizes). Click a table to see "Data", "Columns", "Indexes" and "CREATE statement" on the right. "Data" pages through the table\'s rows (100 / 200 / 500 / 1000 per page, previous / next, fetching only the current page) (MySQL uses SHOW CREATE TABLE; PostgreSQL builds it from columns, constraints and indexes). "First 100 rows" queries the table directly in the "Query" tab.',
        'Redis tabs: "Overview" (version, connections, memory, hit rate, Keyspace; "Raw output" for the full INFO), "Clients" (CLIENT LIST; "Disconnect" at the start of each row disconnects that client), "Keys" (SCAN by pattern in batches, never KEYS, so the instance isn\'t blocked; "Continue scan" fetches the next batch; click a key to see type, TTL, size, memory and the first 100 items, and delete it if needed), "Slow log" (SLOWLOG GET 128), "Big keys" (redis-cli --bigkeys scans the whole database, so it only runs when you click "Start scan"; refresh returns to the prompt page and you click again), "Memory" (INFO memory + MEMORY DOCTOR).',
        'MongoDB tabs: "Query" takes read-only statements in shell syntax, like `db.orders.find({ status: "paid" }).sort({ _id: -1 }).limit(20)`, supporting find / findOne / aggregate / countDocuments / distinct / getIndexes / stats and show collections / show dbs; filters can use ObjectId("…"), ISODate("…") and regexes. LingShell parses the statement itself before handing it to mongosh, so your text is never executed as JavaScript; writes and $where / $function / $out / $merge are rejected; find without a limit returns at most 1000 documents. Each document is one row, with nested fields shown as JSON. "EXPLAIN" uses explain(\'executionStats\') to show the plan (full collection scans are flagged). Also "Overview" (serverStatus), "Current ops" (currentOp, with kill = killOp), "Slow queries" (the current database\'s profiler, system.profile), "Collection sizes", "Replication" (replica set members and lag), and "Schema" (fields inferred from a 200-document sample, indexes, and create collection / index statements). The "Script" tab runs mongosh (JavaScript) scripts; use printjson(...) to see results; confirmation is required before running. Backups use mongodump --archive --gzip.',
        '"Script" tab: write a script, or click "Import file" to load a local .sql (up to 5MB). Then click "Smart check": checks each statement for syntax (unbalanced quotes / brackets / comments), UPDATE / DELETE without WHERE or with an always-true WHERE, DROP / TRUNCATE, table-locking ALTER, privilege changes, statements not allowed in a transaction, and more. Click an issue to select that line in the editor. For a deeper review, "Ask AI to review" sends the script and check results to the chat (review only, nothing runs). Checks only run when you click, and editing the script prompts you to check again.',
        'Running: click "Run" (or Ctrl+Enter) to open a confirmation dialog listing counts per statement type and high-risk items. With high-risk items you must check "I\'ve reviewed this" first, and on production hosts you also type the connection name. MySQL / PostgreSQL check "Single transaction" by default: any error rolls everything back (MySQL DDL commits implicitly and can\'t be rolled back; the check warns about this). Afterwards it shows the client output, time and errors (with line numbers). Drafts are saved locally per connection automatically.',
      ], tips: [
        'Read-only by default: each tab\'s statements are fixed read-only queries, and the "Query" tab only allows a single read-only statement. PostgreSQL sessions are also set to read-only transactions, and MySQL sets the session to READ ONLY before queries and EXPLAIN.',
        'The only writes are "Kill" / "Disconnect" at the start of session / client rows (MySQL `KILL`, PostgreSQL `pg_terminate_backend`, Redis `CLIENT KILL`), deleting on the "Keys" tab (`DEL`), and running on the "Script" tab. All require confirmation, production hosts ask once more, and success or failure is recorded in the "Execution log" (marked "Database · kill session" / "Database · delete key" / "Database · run script").',
        'Deleting a connection also deletes its scheduled backup plans and script drafts; backup files already created are left alone.',
        'Passwords can only come from the secret vault; connections store only the name. At run time the plaintext is fetched in the background and passed via stdin to the remote side, which reads it into an environment variable (MYSQL_PWD / PGPASSWORD / REDISCLI_AUTH / MONGO_PWD; for MongoDB the script builds the connection string from the environment variable and authenticates against the admin database; mongodump\'s password goes into a temp config file readable only by you, deleted after use). It never appears on the command line, in process lists, the terminal, logs or AI messages; if the password shows up in output, it\'s swapped back to the placeholder. The secret\'s "Allowed scope" must include the host chosen for the connection.',
        'Connection configs are stored in db-conns.json in the data directory. If the database is on another machine (the address isn\'t local), its slow log file isn\'t on this host, so create the connection on the database\'s own host. Without permission to read the slow log file, passwordless `sudo -n` is tried.',
      ] },
      { h: 'Backup (including scheduled backups)', p: 'The "Backup" tab in the database drawer (MySQL / PostgreSQL / Redis / MongoDB): opening it pre-checks the backup directory, free space on the partition, estimated size and the export tool; you can\'t start if a tool is missing or space is short.', steps: [
        'Export tools: MySQL uses `mysqldump --single-transaction` (optionally including stored procedures and functions), PostgreSQL uses `pg_dump -Fc`, Redis uses `redis-cli --rdb` (7.0 or later required), MongoDB uses `mongodump --archive --gzip`.',
        'Backup files go to `~/lingshell-backups/<connection name>/` on the database\'s machine by default, written as `.part` first and renamed on success. They run in the background on that machine, so closing the app or an SSH disconnect doesn\'t affect them. Progress shows size written, elapsed time and speed, and you can cancel.',
        '"Existing backups" can be downloaded to this machine (via the transfer queue) or deleted. Start, completion and deletion are recorded in the execution log (marked "Database · backup").',
        'Scheduled backups: choose "Daily at HH:MM" or "Every N hours" and set how many to keep. While the app is open they run on time, no terminal needed; afterwards only the latest N for the same database are kept, and the result is pushed to group bots (failures also show a system notification). You can also "Run now".',
      ], tips: [
        'Restoring overwrites existing data, so it isn\'t offered here. The bottom of the tab gives restore commands per database type (mysqldump: `gunzip -c file | mysql dbname`, PostgreSQL: `pg_restore`, MongoDB: `mongorestore --archive`, Redis: replace dump.rdb).',
        'Production databases ask for confirmation once more before starting: backups only read the database, but they use disk IO and CPU, so for large data sets run them off-peak.',
      ] },
    ],
  },
  {
    id: 'k8s', title: 'Kubernetes view', icon: Boxes,
    blocks: [
      { p: 'Like k9s: views the cluster with kubectl on the machine of the current terminal (an SSH host with kubectl installed, or this machine). Lists Pods / Deployments / StatefulSets / Services / Ingresses / Events by context and namespace, with unhealthy ones (CrashLoopBackOff, Pending, not ready, frequent restarts) pinned to the top in red. All queries run in the background (kubectl … -o json), so they don\'t flood your terminal.' },
      { steps: [
        'Switch to an SSH terminal (Linux / macOS) or a local terminal and click "More views" → "Kubernetes" in the right activity bar, or search "Kubernetes view" in the command palette. Without kubectl or a kubeconfig, the drawer explains how to install / configure it; click "Detect again" once set up.',
        'Two dropdowns in the title bar: context on the left (defaults to the kubeconfig current context, marked "Default"), namespace on the right ("All namespaces" available). The context is only added to this view\'s commands (--context) and never changes the kubeconfig default; each host remembers your last choice.',
        'Tabs above switch resource types; the box filters by name / status, and "Unhealthy only" keeps just the problem ones. Click a row to see describe / YAML below; Pods also have "Logs" (last 500 lines, choose a container, check "Previous container (--previous)" for logs from before the restart).',
        'Pod: "Follow logs" streams kubectl logs -f in the log panel (local terminals open a new terminal tab instead); "Exec into container" opens a new terminal tab running kubectl exec -it (bash if available, otherwise sh); "Forward to local" starts forwarding after you enter a port.',
        'Deployment / StatefulSet: "Rolling restart" first shows a confirmation dialog with the full command, then runs kubectl rollout restart and records it in the "Execution log" (marked "K8s rolling restart (manual)"). Production hosts, or contexts whose name looks like a production cluster (containing prod / production etc.), are marked red and require checking "I confirm…" before you can confirm.',
        '"Send describe to AI" sends the selected object\'s describe output to the current chat so the AI can interpret its status, problems and likely causes (processed by your "AI redaction" settings).',
        '"Cluster health check" tab: finds in one go Pods not Running / Completed, Pending Pods and why scheduling failed, Pods restarted more than 5 times (with the last exit reason, e.g. OOMKilled), nodes that are NotReady / under resource pressure / cordoned, and Warning events from the last hour (merged by object and reason). Click "Troubleshoot with AI" to open a new session and send the results to the AI.',
      ], tips: [
        'Port forwarding: on SSH hosts, kubectl port-forward runs in the background on the remote side (listening only on 127.0.0.1) and is forwarded over SSH to a free local port. The top of the drawer lists "127.0.0.1:local port → target"; click "Stop" to end it, leaving no remote process. Local terminals and macOS hosts instead run kubectl port-forward in a new terminal tab; press Ctrl+C to stop.',
        'The health check covers all namespaces by default. Without permission to list all namespaces it falls back to the current namespace; without permission to list nodes it skips node checks (explained under "Not checked").',
        'LingShell doesn\'t bundle kubectl and doesn\'t read credentials from the local kubeconfig; it only uses the configuration already on the target machine. Errors such as unreachable API server, missing permissions (RBAC) or expired credentials are explained in plain language with the original message attached.',
      ] },
    ],
  },
  {
    id: 'config-keys', title: 'Config key comparison (environment differences)', icon: ListTree,
    blocks: [
      { p: 'For "works in test, broken in production", compare two configs: .env, properties, ini / conf, YAML, JSON and TOML are flattened into "key → value" and aligned by key, so differences in order, indentation, comments or quoting don\'t count. Each side can be any local path or a path on any host (the paths can differ). Read-only.' },
      { steps: [
        'Click "Compare files across hosts (read-only)" in the terminal\'s right activity bar to open "Compare files" and switch to "Compare by key", or search "Config key comparison" in the command palette.',
        'For sides A and B choose "This machine" or a host (saved hosts without an open terminal connect temporarily), enter the file path and click "Start comparison". The format is detected from the file name by default, or set it under "Format".',
        'Results list keys by "Different / Only in A / Only in B", with "Differences only" checked by default; filter by key name.',
        'Keys that look like passwords, tokens or secrets (password / secret / token / key…) or values that look like secrets are shown as ●●●●●● by default, marked "Same on both sides / Different"; click the eye icon to see the plaintext.',
        '"Ask AI to explain differences": puts the diff table into the chat input (sensitive values always masked, then processed by your redaction settings); add a question and send.',
      ], tips: ['Each file is limited to 1MB. YAML only supports the forms common in config files (mappings, lists, multi-line text); flow style like [a, b] is compared as a whole.'] },
    ],
  },
]
