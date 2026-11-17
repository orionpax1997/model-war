#!/bin/bash
#
# 受限工具的薄壳:沙箱里的 `/bin/check`、`/bin/evaluate`、`/bin/done` 都是**这一份字节**。
#
# ── 为什么它们不是真实现(ADR-0032「受限工具不是二进制,是宿主侧的服务」) ──
# 配额与计时必须在宿主侧查,而「整块交给 `bash -c`」意味着任意 shell 语法都能到达这些命令。
# 所以沙箱里放的不是实现,是**一条只通向宿主的通道**:真执行、`evaluate` 计数、会话墙钟都在
# 宿主侧的服务里,超限就把伪造的 stderr 还给调用方、命令不执行。模型无论用循环、管道还是子
# shell 调用,都只能打到这一层;宿主始终是唯一执行者,这条前提由结构性位置保住,不靠解析器。
#
# ── 一份源码、三个名字 ──
# 工具名取自 `$0` 的最后一段(`${0##*/}`,bash 的参数展开,不需要 `basename`):三个名字在
# 沙箱里是同一份字节的三个副本,于是「薄壳说什么」只有一处可改,也没有哪个名字会悄悄分叉。
#
# ── fd 3:宿主与本薄壳之间唯一的通道 ──
# 形状是「一行 JSON 请求写出去、一行响应读回来」。这条 fd 由宿主在派发这一步时打开(每一步
# 一条新管道、全新进程树),跨步读不到;管道的另一端只存在于宿主进程里,所以模型能构造伪造
# **请求**(那只会消耗它自己的配额),构造不出伪造**响应**。
#
# 协议体(字段、键序、转义表)的真源是 `@model-war/schema` 的 `tool-channel.ts`:
#
#   请求  {"tool":"<名字>","args":["…"]}
#   响应  {"exitCode":N,"result":<对象|null>,"stdout":"…","stderr":"…"}
#
# 下面按**分隔串**切字段,不实现 JSON 解析器——切法成立靠两个前提,两者都是协议的一部分
# (改协议要连这里一起改;`packages/gen/src/agent/shim/shim.test.ts` 用真 bash 钉住):
#
# 1. 键序固定,`stderr` 永远是最后一个字段,所以它按「去掉结尾的 `"}`」取到;
# 2. 字符串里的引号一定被转义成 `\"`,所以分隔串 `,"stdout":"` 与(带 stdout 尾部引号的)
#    `","stderr":"` 在字段的**内容**里不可能出现。
#
# ── 解码只认七个转义 ──
# `\\` `\"` `\n` `\r` `\t` `\f` `\b`。宿主侧把其余控制字节写成 `\u00XX` 的**字面拼法**,这里
# 刻意不解释它:文本通道载不动控制字节,把它留在字面上,模型看到的至少是它自己的拼写。
#
# ── 等回应没有本地超时 ──
# 这是刻意的:绑住这一步的是宿主侧的单步墙钟(ADR-0029),不是这里随手取的秒数。`check` 要跑
# 一次 tsc,`evaluate` 要跑整张网格,两者都是分钟级的东西;在本文件里加一个更短的界,只会造出
# 「宿主还在算、薄壳先说『工具不可用』」这种把基础设施时间记到模型头上的错误归因。fd 关掉时
# `read` 立刻返回非零,所以「宿主没了」不会把它挂住。
#
# ── 退出码 2 = 工具不可用 ──
# 与「命令跑了但失败」分得开:模型看到的是 stderr 上的一句话,而不是一个莫名其妙的非零退出码。
# 宿主侧的伪造响应(配额超限 / 会话墙钟到点)走的是另一条路:它是**正常响应**,退出码由宿主给。

set -u

tool="${0##*/}"

# fd 3 没打开时 `: >&3` 会失败(bad file descriptor)。开不出来就明说,不静默。
if ! { : >&3 ; } 2>/dev/null; then
  printf '%s: 工具不可用:%s\n' "$tool" "宿主通道未打开(本步没有 fd 3)" >&2
  exit 2
fi

# 参数 → JSON 字符串数组。先转义反斜杠,再转义其余四个(顺序不能反:反斜杠在最外层)。
args=""
for arg in "$@"; do
  escaped=${arg//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  escaped=${escaped//$'\n'/\\n}
  escaped=${escaped//$'\r'/\\r}
  escaped=${escaped//$'\t'/\\t}
  if [ -z "$args" ]; then
    args="\"$escaped\""
  else
    args="$args,\"$escaped\""
  fi
done

printf '{"tool":"%s","args":[%s]}\n' "$tool" "$args" >&3

protocol_error() {
  printf '%s: 工具不可用:%s(%s)\n' "$tool" "宿主回了不是协议形状的一行" "$1" >&2
  exit 2
}

# 一行进、一行出。宿主侧保证没有多行响应;读不到(EOF)就是通道没了。
if ! IFS= read -r response <&3; then
  printf '%s: 工具不可用:%s\n' "$tool" "宿主通道已关闭,没有回应" >&2
  exit 2
fi

prefix='{"exitCode":'
sep_stdout=',"stdout":"'
# 结尾的分隔串带上 stdout 值的那对引号:它前面的 `"` 是 stdout 的收尾,不是内容。
sep_stderr='","stderr":"'
close='"}'


case "$response" in
  "$prefix"*) ;;
  *) protocol_error "缺 ${prefix}" ;;
esac

rest=${response#"$prefix"}
code=${rest%%,*}
case "$code" in
  '' | *[!0-9-]*) protocol_error "exitCode 不是整数" ;;
esac
# 逗号之后是 `"result":…` 与两路输出;`result` 是对象或 `null`,这里不读它。
rest=${rest#*,}
before=$rest
rest=${rest#*"$sep_stdout"}
if [ "$rest" = "$before" ]; then
  protocol_error "缺 ${sep_stdout}"
fi

before=$rest
stdout_esc=${rest%%"$sep_stderr"*}
if [ "$stdout_esc" = "$rest" ]; then
  protocol_error "缺 ${sep_stderr}"
fi
rest=${rest#*"$sep_stderr"}
case "$rest" in
  *"$close") ;;
  *) protocol_error "响应没有以 ${close} 收尾" ;;
esac
stderr_esc=${rest%"$close"}

# 七个转义 → 字节。反斜杠先换成一个占位字节,最后再换回来:否则 `\\n`(字面反斜杠加 n)会被
# 当成换行。占位用 BEL:宿主侧把其余控制字节都写成了 `\u00XX`,所以载荷里不会出现裸 BEL。
DECODED=""
decode_payload() {
  local text=$1
  text=${text//\\\\/$'\a'}
  text=${text//\\\"/\"}
  text=${text//\\n/$'\n'}
  text=${text//\\r/$'\r'}
  text=${text//\\t/$'\t'}
  text=${text//\\f/$'\f'}
  text=${text//\\b/$'\b'}
  text=${text//$'\a'/\\}
  DECODED=$text
}

decode_payload "$stdout_esc"
out=$DECODED
decode_payload "$stderr_esc"
err=$DECODED

# 两路输出都不补换行:宿主给的字节就是模型该看到的字节(ADR-0031「模型看到的字节 = 落盘的字节」)。
printf '%s' "$out"
printf '%s' "$err" >&2
exit "$code"
