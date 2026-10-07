#!/usr/bin/env bash
# 盲写隔离舱（**契约补齐版**）：为单个模型会话准备"只含终稿契约两份文档 + prompt 基座"的干净目录，
# 并用 bwrap 把 pi agent 锁进该目录（防读 repo、防跨舱串味）。
#
# 本文件是 `.scratch/rules-landing/blind/blind-run.sh` 的**副本**，原件一个字都没动。
# 复制而不改动的原因：原件是终稿契约那一轮的证据源（它自己被那轮的 3 舱引用，改动会让
# 「旧三舱跑在什么隔离条件下」这件事失去唯一凭据）；而本轮的隔离条件与本机环境不同，
# 改在副本上，两轮的隔离条件各自完整可读、各自可复现。
#
# 相对原件适配之处：
#   1. `BLIND_DIR`：`.scratch/rules-landing/blind` → `.scratch/contract-closure/blind`
#      （本轮交付物落 `.scratch/contract-closure/blind/<舱名>/`）。
#   2. `NODE_DIR`：原件写死 `/home/qingtian/.nvm/versions/node/v24.15.0` → 由 `command -v node`
#      动态解析（本机 node 装在 nvm 下，路径随版本变）。
#   3. pi 的挂载：原件的 `/opt/node/bin/pi` 在本机不存在（本机 pi 是 **managed install**，
#      入口在 `~/.pi/agent/bin/pi`，实体在 `~/.pi/agent/install/releases/<ver>/`）。所以多挂两条
#      ro-bind（`~/.pi/agent/bin` → `/opt/pi/bin`、`~/.pi/agent/install` → `/opt/pi/install`），
#      执行 `/opt/pi/bin/pi`（其启动器靠 `pi_bin_dir` 的父目录定位 `install/`，所以两条挂载必须成对）。
#   4. `CONTRACT` 仍指向 `$REPO/docs/rules-v1`（两份逐字全文照旧投放），此条与原件同口径。
#   5. `collect` 白名单：`input/*` 收全（不再只收 `STRATEGY.txt` / `SHA256SUMS.final`），
#      `work/` 那三份交付名（`script.v1.ts` / `FIXES.md` / `script.final.ts`）与 `JAIL.log` /
#      `MANIFEST.txt` 照旧一轮口径。
#   6. `static-check.ts` 的导入路径（`../../../packages/...`）在本目录下与原件同深度，无需改。
#
# 用法：
#   ./blind-run.sh setup <舱名> <策略A|B|C>
#   ./blind-run.sh shell <舱名>            # 起隔离 pi（交互式）
#   ./blind-run.sh run   <舱名> <provider/id> ["任务追加语"]   # 思考层级可用 MW_THINKING 覆盖（默认 high）
#   ./blind-run.sh collect <舱名>          # 把舱内产物取回本 repo（只取白名单）
#
# 约定：
#   舱目录：/tmp/mw-blind/<舱名>/         （舱内只见 input/ + work/ + session/，见不到本 repo）
#   回填目录：.scratch/contract-closure/blind/<舱名>/ （原始产出/调错清单/会话存档）
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BLIND_DIR="$REPO/.scratch/contract-closure/blind"
JAIL_ROOT="/tmp/mw-blind"
# node 与 pi 都从本机动态解析（原件把 node 路径写死；本机 pi 是 managed install，不在 node bin 里）。
NODE_DIR="$(cd "$(dirname "$(command -v node)")/.." && pwd)"
PI_AGENT_DIR="${PI_MANAGED_INSTALL_ROOT_HOME:-$HOME/.pi/agent}"
CONTRACT="$REPO/docs/rules-v1"

cmd="${1:-}"; cell="${2:-}"
case "$cmd" in setup|shell|run|collect) ;; *) echo "用法: $0 setup|shell|run|collect <舱名> ..." >&2; exit 1;; esac
[ -n "$cell" ] || { echo "缺少<舱名>，如 cell-a" >&2; exit 1; }
JAIL="$JAIL_ROOT/$cell"

if [ "$cmd" = "setup" ]; then
  strategy="${3:-}"
  case "$strategy" in A|B|C) ;; *) echo "策略须为 A|B|C" >&2; exit 1;; esac
  rm -rf "$JAIL"; mkdir -p "$JAIL/input" "$JAIL/work" "$JAIL/session"
  cp "$CONTRACT/rules.md" "$CONTRACT/api.md" "$JAIL/input/"
  # 终稿没有 wording-risks.md，所以白名单是固定的一份（没有 with-risks 分支）。
  ALLOW_LIST="rules.md api.md PROMPT.base.md STRATEGY.txt"
  sha256sum "$CONTRACT/rules.md" "$CONTRACT/api.md" > "$JAIL/input/SHA256SUMS.final"
  # prompt 基座 + 本舱策略行（只换一行）
  cp "$BLIND_DIR/PROMPT.base.md" "$JAIL/input/"
  case "$strategy" in
    A) echo "本舱策略取向：A 爆兵压制：优先把资源投进战斗单位，尽早争夺与压制点位。" > "$JAIL/input/STRATEGY.txt";;
    B) echo "本舱策略取向：B 扩张运营：优先占领资源点与扩张经济，攒够家底再转军事。" > "$JAIL/input/STRATEGY.txt";;
    C) echo "本舱策略取向：C 占点不采集：优先用占点扩张局面，不把产能放在采集这一侧。" > "$JAIL/input/STRATEGY.txt";;
  esac
  cat > "$JAIL/input/TASK.txt" <<EOF
你是参赛脚本作者。只读本目录 input/ 内文档写脚本（允许的文件：$ALLOW_LIST）。
禁读本目录之外的任何文件；不知道其它舱、其它策略、其它模型的存在。
按 PROMPT.base.md 输出：单个代码块，放 \`script.ts\` 的脚本全文（完整可运行，不给片段、不给省略号）。
把初版原文（未改一字）写到 work/script.v1.ts，把同一份全文也贴进你的回复里。
后续每轮校验只改 work/ 内文件并记 work/FIXES.md。
EOF
  printf 'strategy=%s risks=none contract=final\n' "$strategy" > "$JAIL/MANIFEST.txt"
  echo "setup ok: $JAIL"; ls -la "$JAIL/input"
  exit 0
fi

# shell / run：bwrap 隔离执行 pi。舱内只能读写 /workspace（=舱目录），
# 家目录用 tmpfs 假家（只带 auth/models 认证），会话落舱内 session/，不进 ~/.pi。
if [ "$cmd" = "collect" ]; then
  dst="$BLIND_DIR/$cell"
  mkdir -p "$dst"
  for f in work/script.v1.ts work/FIXES.md work/script.final.ts JAIL.log MANIFEST.txt; do
    [ -e "$JAIL/$f" ] && { mkdir -p "$dst/$(dirname "$f")"; cp "$JAIL/$f" "$dst/$f"; }
  done
  # input/* 收全（投放物与任务书一并留档）。
  mkdir -p "$dst/input"
  for f in "$JAIL"/input/*; do
    [ -e "$f" ] || continue
    cp "$f" "$dst/input/"
  done
  [ -d "$JAIL/session" ] && cp -r "$JAIL/session" "$dst/session" 2>/dev/null || true
  echo "collect ok -> $dst"; find "$dst" -type f | sort
  exit 0
fi

# 为隔离 pi 准备舱内家目录：只给认证 + 最小 settings（不带 skills/packages/全家）
AGENT_HOME="$JAIL/agent-home"; rm -rf "$AGENT_HOME"; mkdir -p "$AGENT_HOME"
cp "$PI_AGENT_DIR/auth.json" "$AGENT_HOME/" 2>/dev/null || true
cp "$PI_AGENT_DIR/models.json" "$AGENT_HOME/" 2>/dev/null || true
printf '{"defaultProvider":"commandcode","defaultThinkingLevel":"high","retry":{"maxRetries":%s}}\n' "${MW_RETRIES:-3}" > "$AGENT_HOME/settings.json"

BWRAP=(bwrap --unshare-uts --unshare-ipc --unshare-pid --unshare-cgroup --die-with-parent
  --share-net --hostname "blind-$cell"
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64
  --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/hosts /etc/hosts
  --ro-bind /etc/passwd /etc/passwd
  --ro-bind "$NODE_DIR" /opt/node
  --ro-bind "$PI_AGENT_DIR/bin" /opt/pi/bin
  --ro-bind "$PI_AGENT_DIR/install" /opt/pi/install
  --proc /proc --dev /dev --tmpfs /tmp
  --bind "$JAIL" /workspace --chdir /workspace
  --setenv PATH "/opt/node/bin:/usr/bin:/bin"
  --setenv HOME /workspace
  --setenv PI_CODING_AGENT_DIR /workspace/agent-home
  --setenv PI_CODING_AGENT_SESSION_DIR /workspace/session)

if [ "$cmd" = "shell" ]; then
  # 交互式：舱内 pi 看不到 repo，看不到其它舱
  "${BWRAP[@]}" /opt/pi/bin/pi --no-skills --no-context-files --no-themes 2>&1 | tee "$JAIL/JAIL.log"
elif [ "$cmd" = "run" ]; then
  # 用法：./blind-run.sh run <舱名> <provider/model> ["任务追加语"]
  # prompt = TASK.txt + 追加语（避免 -- 透传吞掉 -p flag）
  model="${3:-}"; extra="${4:-}"
  [ -n "$model" ] || { echo "用法: $0 run <舱名> <provider/model> [追加语]" >&2; exit 1; }
  prompt="$(cat "$JAIL/input/TASK.txt")"
  [ -n "$extra" ] && prompt="$prompt"$'\n'"$extra"
  "${BWRAP[@]}" /opt/pi/bin/pi --model "$model" --thinking "${MW_THINKING:-high}" \
    --no-skills --no-context-files --no-themes -p "$prompt" 2>&1 | tee "$JAIL/JAIL.log"
fi
