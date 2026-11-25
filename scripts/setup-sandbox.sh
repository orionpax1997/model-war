#!/usr/bin/env bash
#
# model-war · 沙箱前置:装 bubblewrap 并让它真的能用(CI 用,可重复执行)
#
# 谁该跑它:`verify:kernel` 那条腿(以及任何要真跑 bwrap 的环境)。命名脚本是
# `pnpm run setup:sandbox`,于是 CI 的 workflow 里只出现一个 `pnpm run <script>`——
# **不写裸 apt-get / sysctl**(ADR-0010「CI 只调命名脚本」、ADR-0033「CI 里只调命名脚本」)。
#
# ── 为什么要这些步骤,而不是「装个包就完了」 ──
# Ubuntu 24.04 起默认打开 `kernel.apparmor_restrict_unprivileged_userns=1`:用户命名空间对所有
# 应用可用,但**命名空间内不再给额外权限**,于是 bwrap 起沙箱时会拿到一个裸 `EPERM`。
# 26.04 起 `bwrap-userns-restrict` profile 默认已加载,光改 sysctl 不够,还要卸载该 profile。
# 这两件事都不是本仓库能控制的政策,所以本脚本**条件执行、失败即红**:环境变化要失败在
# **这一行**,而不是变成 `verify:kernel` 里一串看不出因果的失败。
#
# 版本下限的判据不在这里(真源在 `packages/gen/src/agent/sandbox/preflight.ts`):本脚本只保证
# 「装得上、跑得起来」,下限由执行器的 preflight 判——一处判据,一个家。
#
# 退出码:0 = bwrap 可用;1 = 修不好(会打印三种已知成因与各自的处置)。

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

if [[ -t 1 ]]; then
  BOLD=$(tput bold 2>/dev/null || true); RESET=$(tput sgr0 2>/dev/null || true)
  RED=$(tput setaf 1 2>/dev/null || true); GREEN=$(tput setaf 2 2>/dev/null || true)
  YELLOW=$(tput setaf 3 2>/dev/null || true)
else
  BOLD=""; RESET=""; RED=""; GREEN=""; YELLOW=""
fi

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s▸%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

SYSCtl_KEY="kernel.apparmor_restrict_unprivileged_userns"
BWRAP_PROFILE="/etc/apparmor.d/bwrap-userns-restrict"

printf '\n%s沙箱前置:装 bubblewrap 并让它真的能用%s\n' "$BOLD" "$RESET"
say "环境:$(uname -srm),uid $(id -u),sudo=${SUDO:-无}"

# ── 1. bubblewrap 本体 ────────────────────────────────────────────────────────
if command -v bwrap >/dev/null 2>&1; then
  ok "已装:$(bwrap --version 2>&1)"
else
  step "安装 bubblewrap($SUDO apt-get install -y bubblewrap)"
  if ! { $SUDO apt-get update -qq && $SUDO apt-get install -y --no-install-recommends bubblewrap; }; then
    warn "apt-get 装不上 bubblewrap。"
    say "本仓库不做「装不上就跳过」的降级:沙箱不可用时任务必须失败(ADR-0033)。"
    exit 1
  fi
  ok "已装:$(bwrap --version 2>&1)"
fi

# ── 2. 非特权 user namespace 的 AppArmor 限制(24.04 起) ──────────────────────
restrict="$(sysctl -n "$SYSCtl_KEY" 2>/dev/null || echo 0)"
if [[ "$restrict" == "1" ]]; then
  step "放开 $SYSCtl_KEY(当前为 1:命名空间内不再给额外权限,bwrap 会拿到裸 EPERM)"
  $SUDO sysctl -w "$SYSCtl_KEY=0" >/dev/null 2>&1 || true
  now="$(sysctl -n "$SYSCtl_KEY" 2>/dev/null || echo 读不到)"
  if [[ "$now" == "0" ]]; then
    ok "$SYSCtl_KEY=0"
  else
    warn "改不动:$SYSCtl_KEY 还是 $now(无 sudo 或内核不认)。先继续——冒烟才是真正的判据。"
  fi
else
  ok "$SYSCtl_KEY=$(sysctl -n "$SYSCtl_KEY" 2>/dev/null || echo 该内核没有这个开关)"
fi

# ── 3. 冒烟:真的建一次沙箱 ────────────────────────────────────────────────────
# 用宿主 /usr 做最小挂载(这一行只验「命名空间建得起来」,与入库 rootfs 无关;rootfs 的判据在
# `pnpm run verify:kernel`)。三条 `--symlink` 是 Ubuntu 的 toldja:宿主的 /bin、/lib、/lib64
# 都是指向 usr/ 下同名目录的符号链接,只 bind /usr 而不补这三条链接时 bwrap 会报
# 「execvp /bin/true: No such file or directory」——那个报错看起来像「binary 丢了」,实际是
# 「根里少了一个符号链接」。(入库 rootfs 那一侧不需要它:那里 /bin 与 /contract 是直接 bind 的。)
smoke() {
  bwrap --tmpfs / \
        --ro-bind /usr /usr \
        --symlink usr/bin /bin \
        --symlink usr/lib /lib \
        --symlink usr/lib64 /lib64 \
        --dev /dev \
        --unshare-all \
        --die-with-parent \
        /bin/true >/dev/null 2>&1
}

if smoke; then
  ok "冒烟通过:最小沙箱建得起来"
else
  # ── 4. 26.04 的 profile:光改 sysctl 不够 ────────────────────────────────────
  if [[ -f "$BWRAP_PROFILE" ]]; then
    step "卸载 $BWRAP_PROFILE(26.04 起默认加载:它会让 bwrap 的子进程跑在拒掉全部 capability 的 profile 下)"
    $SUDO apparmor_parser -R "$BWRAP_PROFILE" >/dev/null 2>&1 || true
  fi
  if smoke; then
    ok "冒烟通过:卸载 profile 之后最小沙箱建得起来"
  else
    warn "bwrap 装了,但最小沙箱建不起来(错误信息通常只有一个 EPERM)。"
    say "bwrap 从内核只拿到 EPERM 是上游明说的限制,不是 bug。已知成因三种:"
    say "  1. Ubuntu 24.04 的 $SYSCtl_KEY=1 → sudo sysctl -w $SYSCtl_KEY=0"
    say "  2. Ubuntu 26.04 起还要卸 profile → sudo apparmor_parser -R $BWRAP_PROFILE"
    say "  3. 在容器里跑(devcontainer / 容器化 CI)需要四个 override:"
    say "     --security-opt seccomp=unconfined --security-opt apparmor=unconfined"
    say "     --security-opt systempaths=unconfined --cap-add SYS_ADMIN"
    say "本仓库不提供兼容层,也不降级到宿主进程执行(ADR-0033)。"
    exit 1
  fi
fi

ok "沙箱前置完成:下一步可以跑 pnpm run verify:kernel"
