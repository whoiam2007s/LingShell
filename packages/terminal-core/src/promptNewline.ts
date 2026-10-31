// 让 bash 的提示符总是另起一行（zsh 的 PROMPT_SP / fish 默认就这样）。
// 不然 cat 一个没有末尾换行的文件，提示符会粘在输出后面（"line4[root@host ~]#"），像是内容没显示全。
//
// 原理（zsh 同款）：每次出提示符前先打 COLUMNS 个空格再 \r。
//   光标在行首 → 空格恰好占满本行，光标停在行尾「待折行」处不真折，\r 回行首，提示符盖掉空格，看不出任何变化；
//   光标在行中 → 空格超出行宽自动折到下一行，\r 回到新行行首，提示符就另起一行。
//   （COLUMNS-1 不行：光标在第 1 列时也只是停在待折行处，\r 回同一行，提示符盖掉那 1 个字符）
// 依赖 COLUMNS 准确（否则空格不够折行，\r 回行首后提示符会盖掉输出），所以顺带打开 checkwinsize。
//
// 同一个钩子顺带打 shell integration 标记（OSC 133，VS Code/Warp 同款；UI 据此给命令标成败，见 shared/terminal/shellMarks.ts）：
//   PROMPT_COMMAND：133;D;<退出码>（上条命令结束）→ 633;P;Cwd=<目录> → 换行把戏 → 133;A（提示符开始）
//   PS1 末尾：133;B（提示符结束 = 用户输入开始；包在 \[ \] 里，readline 不计宽度）
//   PS0（bash ≥4.4，回车后、命令执行前打印）：133;C（命令开始）。PS0 里不能用 \[ \]（会原样输出 \x01\x02）。
//   bash <4.4 没有 PS0：设了也无效，没有 C 就没有成败标记，其余照常（不用 DEBUG trap：会和用户的 trap / bash-preexec 打架）。
//   空行 / 纯注释行 bash 不打 PS0，只有一个孤立的 D，UI 忽略。
// 钩子排在 PROMPT_COMMAND 最前（$? 还是用户命令的），末尾 return 原退出码，用户后续 PROMPT_COMMAND 看到的 $? 不变。
//
// 只对 bash 生效（zsh/fish 自带，sh/dash 没有 PROMPT_COMMAND）；用户原有 PROMPT_COMMAND/PS0/PS1 保留，只在末尾追加；
// 只改当前 shell 会话的变量，不碰任何配置文件；重复执行不叠加。
//
// 在 tmux 里（保持会话，见 shared/terminal/tmux.ts）：tmux 不转发不认识的 OSC，标记要包成 DCS 透传 ESC P tmux; ESC <标记> ESC \
// （内层 ESC 写两遍；ST 里的 \ 写成八进制 \134，printf 与 PS1 都认，免得层层转义）。tmux ≥3.3 还要会话开 allow-passthrough（建会话时已开）。p/s 为空 = 不在 tmux，与原来逐字节相同。
const HOOK = `__lingshell_nl() { local e=\${1:-$?} p= s=; [ -n "$TMUX" ] && p='\\033Ptmux;\\033' s='\\033\\134'; `
  + `printf "$p"'\\033]133;D;%s\\007'"$s$p"'\\033]633;P;Cwd=%s\\007'"$s"'%*s\\r'"$p"'\\033]133;A\\007'"$s" "$e" "$PWD" "\${COLUMNS:-80}" ''; `
  + `case "$PS1" in *'133;B'*) ;; *) PS1="$PS1"'\\['"$p"'\\033]133;B\\007'"$s"'\\]';; esac; `
  + `case "$PS0" in *'133;C'*) ;; *) PS0="$PS0$p"'\\033]133;C\\007'"$s";; esac; `
  + 'return $e; }'

// 顺带让 HISTCONTROL 含 ignorespace（本地 Git Bash 经环境变量已设）：AI 命令的哨兵包装行以空格开头，
// 含密钥保险箱明文的命令就不进 bash 历史（尽力而为：用户的 HISTCONTROL 之后被改掉、或非 bash 时无效）
const HISTCTL = 'case ":$HISTCONTROL:" in *:ignorespace:*|*:ignoreboth:*) ;; *) HISTCONTROL="ignorespace${HISTCONTROL:+:$HISTCONTROL}";; esac; '

export const PROMPT_NEWLINE_SETUP =
  `[ -n "$BASH_VERSION" ] && { shopt -s checkwinsize; ${HISTCTL}${HOOK}; `
  + 'case "$PROMPT_COMMAND" in *__lingshell_nl*) ;; '
  + '*) PROMPT_COMMAND="__lingshell_nl${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; }; true'

// 本地 Git Bash 直接经环境变量带上（bash 启动时把环境变量 PROMPT_COMMAND 当 shell 变量用），
// 不用往终端里发命令，没有与 AI exec 抢终端的竞态。Git Bash 5.x 默认开 checkwinsize。
// 环境变量带不了函数，每次出提示符现定义一遍（纯赋值，不 fork）；先存 $? 再定义（定义函数会把 $? 清 0）。
export const PROMPT_NEWLINE_ENV = `__lingshell_e=$?; ${HOOK}; __lingshell_nl $__lingshell_e`
