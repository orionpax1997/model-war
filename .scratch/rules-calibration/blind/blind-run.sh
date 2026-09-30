#!/usr/bin/env bash
# 盲写隔离舱：为单个模型会话准备"只含 draft/ 四文件 + prompt 基座"的干净目录，
# 并用 bwrap 把 pi agent 锁进该目录（防读 repo、防跨舱串味）。
#
# 用法：
#   ./blind-run.sh setup <舱名> <策略A|B|C> [with-risks|no-risks]
#   ./blind-run.sh shell <舱名>            # 起隔离 pi（交互式）
#   ./blind-run.sh run   <舱名> <provider/id> ["任务追加语"]   # 思考层级可用 MW_THINKING 覆盖（默认 high）
#   ./blind-run.sh collect <舱名>          # 把舱内产物取回本 repo（只取白名单）
#
# 约定：
#   舱目录：/tmp/mw-blind/<舱名>/         （舱内只见 input/ + work/，见不到本 repo）
#   回填目录：.scratch/rules-calibration/blind/<舱名>/ （初版原文/调错清单/prompt 存档）
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BLIND_DIR="$REPO/.scratch/rules-calibration/blind"
JAIL_ROOT="/tmp/mw-blind"
NODE_DIR="/home/qingtian/.nvm/versions/node/v24.15.0"
DRAFT="$REPO/.scratch/rules-calibration/draft"

cmd="${1:-}"; cell="${2:-}"
case "$cmd" in setup|shell|run|collect) ;; *) echo "用法: $0 setup|shell|run|collect <舱名> ..." >&2; exit 1;; esac
[ -n "$cell" ] || { echo "缺少<舱名>，如 cell-a" >&2; exit 1; }
JAIL="$JAIL_ROOT/$cell"

if [ "$cmd" = "setup" ]; then
  strategy="${3:-}"; risks="${4:-no-risks}"
  case "$strategy" in A|B|C) ;; *) echo "策略须为 A|B|C" >&2; exit 1;; esac
  rm -rf "$JAIL"; mkdir -p "$JAIL/input" "$JAIL/work" "$JAIL/session"
  cp "$DRAFT/README.md" "$DRAFT/rules.md" "$DRAFT/api.md" "$JAIL/input/"
  if [ "$risks" = "with-risks" ]; then
    cp "$DRAFT/wording-risks.md" "$JAIL/input/"
    ALLOW_LIST="README.md rules.md api.md PROMPT.base.md STRATEGY.txt wording-risks.md"
  else
    ALLOW_LIST="README.md rules.md api.md PROMPT.base.md STRATEGY.txt"
  fi
  sha256sum "$DRAFT"/* > "$JAIL/input/SHA256SUMS.draft"
  # prompt 基座 + 本舱策略行（只换一行）
  cp "$BLIND_DIR/PROMPT.base.md" "$JAIL/input/"
  case "$strategy" in
    A) echo "本舱策略取向：A 爆兵压制：优先生产战斗单位，尽早争夺与压制。" > "$JAIL/input/STRATEGY.txt";;
    B) echo "本舱策略取向：B 扩张运营：优先占领资源点与扩张经济，再转军事。" > "$JAIL/input/STRATEGY.txt";;
    C) echo "本舱策略取向：C 农民海（可选）：以农民为主力占领/堵点，检验占领张力。" > "$JAIL/input/STRATEGY.txt";;
  esac
  cat > "$JAIL/input/TASK.txt" <<EOF
你是参赛脚本作者。只读本目录 input/ 内文档写脚本（允许的文件：$ALLOW_LIST）。
禁读本目录之外的任何文件；不知道其它舱、其它策略、其它模型的存在。
按 PROMPT.base.md 输出：单个代码块脚本全文 + 两行记录（自认候选 A/B；轮转方向假设）。
把初版写到 work/script.v1.js（未改一字即初版原文），后续每轮校验只改 work/ 内文件并记 work/FIXES.md。
EOF
  printf 'strategy=%s risks=%s\n' "$strategy" "$risks" > "$JAIL/MANIFEST.txt"
  echo "setup ok: $JAIL"; ls -la "$JAIL/input"
  exit 0
fi

# shell / run：bwrap 隔离执行 pi。舱内只能读写 /workspace（=舱目录），
# 家目录用 tmpfs 假家（只带 auth/models 认证），会话落舱内 session/，不进 ~/.pi。
if [ "$cmd" = "collect" ]; then
  dst="$BLIND_DIR/$cell"
  mkdir -p "$dst"
  for f in work/script.v1.js work/FIXES.md work/script.final.js input/STRATEGY.txt input/SHA256SUMS.draft JAIL.log MANIFEST.txt; do
    [ -e "$JAIL/$f" ] && { mkdir -p "$dst/$(dirname "$f")"; cp "$JAIL/$f" "$dst/$f"; }
  done
  [ -d "$JAIL/session" ] && cp -r "$JAIL/session" "$dst/session" 2>/dev/null || true
  echo "collect ok -> $dst"; find "$dst" -type f | sort
  exit 0
fi

# 为隔离 pi 准备舱内家目录：只给认证 + 最小 settings（不带 skills/packages/全家）
AGENT_HOME="$JAIL/agent-home"; rm -rf "$AGENT_HOME"; mkdir -p "$AGENT_HOME"
cp ~/.pi/agent/auth.json "$AGENT_HOME/" 2>/dev/null || true
cp ~/.pi/agent/models.json "$AGENT_HOME/" 2>/dev/null || true
printf '{"defaultProvider":"commandcode","defaultThinkingLevel":"high","retry":{"maxRetries":%s}}\n' "${MW_RETRIES:-3}" > "$AGENT_HOME/settings.json"

BWRAP=(bwrap --unshare-uts --unshare-ipc --unshare-pid --unshare-cgroup --die-with-parent
  --share-net --hostname "blind-$cell"
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64
  --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/hosts /etc/hosts
  --ro-bind /etc/passwd /etc/passwd
  --ro-bind "$NODE_DIR" /opt/node
  --proc /proc --dev /dev --tmpfs /tmp
  --bind "$JAIL" /workspace --chdir /workspace
  --setenv PATH "/opt/node/bin:/usr/bin:/bin"
  --setenv HOME /workspace
  --setenv PI_CODING_AGENT_DIR /workspace/agent-home
  --setenv PI_CODING_AGENT_SESSION_DIR /workspace/session)

if [ "$cmd" = "shell" ]; then
  # 交互式：舱内 pi 看不到 repo，看不到其它舱
  "${BWRAP[@]}" /opt/node/bin/node /opt/node/bin/pi --no-skills --no-context-files --no-themes 2>&1 | tee "$JAIL/JAIL.log"
elif [ "$cmd" = "run" ]; then
  # 用法：./blind-run.sh run <舱名> <provider/model> ["任务追加语"]
  # prompt = TASK.txt + 追加语（避免 -- 透传吞掉 -p flag）
  model="${3:-}"; extra="${4:-}"
  [ -n "$model" ] || { echo "用法: $0 run <舱名> <provider/model> [追加语]" >&2; exit 1; }
  prompt="$(cat "$JAIL/input/TASK.txt")"
  [ -n "$extra" ] && prompt="$prompt"$'\n'"$extra"
  "${BWRAP[@]}" /opt/node/bin/node /opt/node/bin/pi --model "$model" --thinking "${MW_THINKING:-high}" \
    --no-skills --no-context-files --no-themes -p "$prompt" 2>&1 | tee "$JAIL/JAIL.log"
fi
