#!/usr/bin/env bash
#
# model-war · 节点 J:模型 API 凭证与端点开通(人工前置)
#
# 只有人能过这堵墙:浏览器登录、生成 key、看额度。本脚本不替你拿凭证,
# 它只负责把每一步该点哪里写清楚,并把抄回来的值落到该落的地方:
#   - 密钥            → .env(已 gitignore;CI 不落,见 hld.md:212)
#   - 端点/模型标识/上下文 → .modelwar-providers.md(已 gitignore;填 models.yaml 后即弃)
#
# 一次性产物:办完即可删;保留它只是为了让下一个人跑脚本而不是问 AI。

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: node J. One stage() per step the human takes.
# ──────────────────────────────────────────────────────────────────────────

# 一切相对路径都相对仓库根,免得在别处跑把 .env 写到别的地方。
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# 厂商事实(2026-10 核实自 commandcode.ai/docs/provider、/docs/studio、/docs/resources/pricing-limits):
#   base_url        https://api.commandcode.ai/provider/v1
#   OpenAI 格式端点  /chat/completions(OpenAI 与开源模型)、/responses(OpenAI 与多数开源模型)
#   Anthropic 端点  /messages —— 仅 Claude 模型;发错端点服务端返 400
#   目录            /models,每条带 supported_endpoints,发请求前先看它
#   key             Studio → API Keys → Generate API key,形如 user_...
#   套餐门槛        Go($1)调 /provider/v1 返 403 upgrade_required;须 GOAT/Pro/Max/Team/Provider
#   额度窗口        GOAT/Pro/Max 有 5 小时 + 每周 + 每月三道窗口(M4 批量生成会撞)
#   官方环境变量名  COMMAND_CODE_API_KEY(取它,别自己另起一个名)
CC_BASE="https://api.commandcode.ai/provider/v1"
CC_STUDIO="https://commandcode.ai/studio"
CC_MODELS_PAGE="https://commandcode.ai/zh/models"
# 探活用的便宜模型:任何走 /chat/completions 的模型都行,只为验 key/额度/端点通不通。
# 报 400 model_not_found 就换一个(Stage 6 的表里挑个标 ✅ 的)。
PROBE_MODEL="deepseek/deepseek-v4-flash"
NOTES_FILE=".modelwar-providers.md"   # 非密钥事实;已 gitignore
CATALOG_FILE=".modelwar-models.json" # 实时目录原始响应;已 gitignore
API_KEY=""

TOTAL_STAGES=7

banner "model-war · J:模型 API 凭证与端点开通(Command Code)"

# ── Stage 1 · 前置:明文不许进仓库 ─────────────────────────────────────────
stage "前置校验:.env 会不会被提交"
say "脚本要往 .env 写明文 key。先证明它进不了 git,再动任何浏览器。"
# 路径先绝对化:git check-ignore 对仓库外的路径会直接 fatal,不能拿它当守卫。
if [[ "$ENV_FILE" == /* ]]; then ENV_ABS="$ENV_FILE"; else ENV_ABS="$REPO_ROOT/$ENV_FILE"; fi
if [[ "$ENV_ABS" == "$REPO_ROOT"/* ]]; then
  if git check-ignore -q -- "$ENV_FILE"; then
    note "✓ .gitignore 命中:$ENV_FILE 已忽略($(git check-ignore -v -- "$ENV_FILE" | cut -f1))"
  else
    warn ".env 当前未被 gitignore —— 此刻不要粘贴任何 key。"
    say  "先在 .gitignore 加这四行再回来(本仓库已加,若你看到这条说明被改过):"
    note "  .env / .env.local / .env.*.local / !.env.example"
    confirm "已经加好了,继续?" || { warn "中止。先修 .gitignore。"; exit 1; }
  fi
else
  warn "ENV_FILE=$ENV_FILE 在仓库外($ENV_ABS):git 管不到它,明文不泄露,但请自己确认没放错地方。"
fi
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  dirty="$(git status --porcelain | wc -l | tr -d ' ')"
  note "工作区当前有 $dirty 处改动(不影响本脚本,只是让你知道基线)"
fi
note "本活不写 GitHub secrets:docs/hld.md:212 规定 CI 无网络、无模型 API、无凭证。"
pause "继续"

# ── Stage 2 · 套餐与额度窗口 ───────────────────────────────────────────────
stage "套餐与额度:先确认你的档位够用 Provider API"
warn "Go 套餐(\$1)调用 /provider/v1 会返回 403 upgrade_required —— 那条路走不通。"
say  "可用档位:GOAT \$10 / Pro \$20 / Max \$100·\$200 / Team / Provider \$15(按量)。"
open_url "$CC_STUDIO"
step "左侧边栏进 Billing,记下你当前档位与本月剩余额度。"
step "同时记下三道窗口(5 小时 / 每周 / 每月)——M4 要批量生成,窗口是硬约束。"
ask CC_PLAN "你的档位(Go / GOAT / Pro / Max / Team / Provider):"
ask CC_CREDITS "本月给生成管线留的额度(USD,数字即可):"
ask CC_WINDOWS "窗口形态(如 5h+\$X/周+\$Y/月,或\"无窗口\"):"
if [[ "${CC_PLAN,,}" == go ]]; then
  warn "你选的是 Go 档:Provider API 会 403,后面 Stage 5/7 大概率失败。"
  SKIPPED+=("升级到 GOAT 及以上再重跑本脚本(Stage 5 会验证)")
fi
pause "继续"

# ── Stage 3 · 契约体量:上下文够不够得有尺子 ───────────────────────────────
stage "契约体量:读两份契约到底要多少 token"
CONTRACT_FILES=()
for f in docs/rules-v1/rules.md docs/rules-v1/api.md; do
  [[ -f "$f" ]] && CONTRACT_FILES+=("$f")
done
CONTRACT_SOURCE="终稿(docs/rules-v1)"
if (( ${#CONTRACT_FILES[@]} == 0 )); then
  CONTRACT_SOURCE="草案回落(.scratch/rules-calibration/draft)"
  for f in .scratch/rules-calibration/draft/rules.md .scratch/rules-calibration/draft/api.md; do
    [[ -f "$f" ]] && CONTRACT_FILES+=("$f")
  done
fi
CONTRACT_BYTES=0
for f in "${CONTRACT_FILES[@]}"; do
  sz=$(wc -c <"$f" | tr -d ' ')
  CONTRACT_BYTES=$((CONTRACT_BYTES + sz))
  note "$(printf '%-56s %7d B' "$f" "$sz")"
done
if (( ${#CONTRACT_FILES[@]} == 0 )); then
  warn "两份契约一份都没找到 —— Stage 6 的上下文判定没有尺子,结论不成立。"
  SKIPPED+=("契约体量:docs/rules-v1/rules.md 与 api.md 都不存在(节点 E 未落库)")
fi
# 粗估:中文 UTF-8 约 2.5~3 B/token,英文约 4 B/token;取 2.5 保守侧。
CONTRACT_TOKENS=$((CONTRACT_BYTES / 5 * 2 + 1))   # 中英混排按 ~2.5 B/token
say  "合计 $CONTRACT_BYTES B,粗估 ≈ $CONTRACT_TOKENS tokens(按 2.5 B/token,故意往高估)。"
note "来源:$CONTRACT_SOURCE"
warn "这两份文档归节点 E。E 落库后重跑 Stage 3/6,拿终稿数字再看一次。"
pause "继续"

# ── Stage 4 · 建 key 并落 .env ─────────────────────────────────────────────
stage "创建 API key(唯一需要你动手的一步)"
say  "同一把 key 同时用于 CLI 与 Provider API;官方环境变量名是 COMMAND_CODE_API_KEY。"
open_url "$CC_STUDIO"
step "左侧边栏 → API Keys。"
step "点 Generate API key,生成后立刻复制(形如 user_...;只显示一次)。"
ask_secret COMMAND_CODE_API_KEY "粘贴 key(输入不回显):"
if [[ -z "$COMMAND_CODE_API_KEY" ]]; then
  SKIPPED+=("没拿到 key:重跑到本 Stage 补上")
  warn "没拿到 key,Stage 5/7 会跳过。"
elif [[ "$COMMAND_CODE_API_KEY" != user_* ]]; then
  warn "这不像 Studio 生成的 key(不以 user_ 开头)。若它来自 OAuth 登录态,Provider API 可能不认。"
fi
if [[ -n "$COMMAND_CODE_API_KEY" ]]; then
  write_env COMMAND_CODE_API_KEY "$COMMAND_CODE_API_KEY"
  API_KEY="$COMMAND_CODE_API_KEY"
  note "文件权限 $(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')(mktemp 生成,默认 600)"
fi
pause "继续"

# ── Stage 5 · 拉实时模型目录 ───────────────────────────────────────────────
stage "拉实时模型目录(含 supported_endpoints)"
say  "端点归属是厂商事实:H 的适配层要按它分家 —— Claude 只走 /messages,"
note "OpenAI 与开源模型走 /chat/completions;发错端点服务端直接 400。"
warn "实测:目录端点无需鉴权(空 key / 假 key 也返 200)。**这里的 200 不证明 key 有效**,"
note  "唯一能证明 key 有效的是 Stage 7 的真实请求。"
CATALOG_OK=0
if [[ -z "$API_KEY" ]]; then
  SKIPPED+=("拉实时目录:缺 key")
  note "没有 key,跳过。目录公开页:$CC_MODELS_PAGE"
elif ! command -v curl >/dev/null 2>&1; then
  SKIPPED+=("拉实时目录:本机没有 curl")
  note "没有 curl,手工打开 $CC_BASE/models(带 Bearer)或 $CC_MODELS_PAGE"
else
  tmp_body=$(mktemp)
  http_code=$(curl -sS -m 30 -o "$tmp_body" -w '%{http_code}' \
    -H "Authorization: Bearer $API_KEY" -H "Accept: application/json" \
    "$CC_BASE/models" 2>/dev/null || echo 000)
  if [[ "$http_code" == 200 ]]; then
    mv "$tmp_body" "$CATALOG_FILE"; chmod 600 "$CATALOG_FILE"
    CATALOG_OK=1
    note "✓ 目录已存 $CATALOG_FILE(HTTP $http_code;公开端点,不构成鉴权证明)"
  else
    rm -f "$tmp_body"
    warn "HTTP $http_code —— 没拿到目录。"
    case "$http_code" in
      401|403) SKIPPED+=("鉴权被拒($http_code):key 无效,或档位不够 Provider API") ;;
      402)     SKIPPED+=("余额不足($http_code):去 Billing 充值") ;;
      *)       SKIPPED+=("拉目录返回 $http_code:手工试 $CC_BASE/models") ;;
    esac
    note "公开目录页(人读,含上下文与定价):$CC_MODELS_PAGE"
  fi
fi
pause "继续"

# ── Stage 6 · 上下文够不够:逐模型判定 ──────────────────────────────────────
stage "上下文判定:每个候选模型够不够读完两份契约"
# 判定尺:契约 tokens 要留 10 倍余量(生成时还有模板、≤5 轮回喂的校验错误、
# 以及模型自己的输出),10 倍是随手取的保守线,不是量出来的常数。
NEEDED=$((CONTRACT_TOKENS * 10))
say "判定尺:契约 ≈ $CONTRACT_TOKENS tokens × 10 余量 = 需要 ≥ $NEEDED tokens 上下文。"
note "选型不在本活范围内(归节点 I 的 research)——这里只出事实:谁够、谁走哪个端点。"
# 截断重写而不是追加:Stage 6/7 合起来就是整个文件,重跑一次不留上一轮的残骸。
{
  printf '# 模型开通事实 · 暂存\n\n'
  printf '节点 J 的产出。**这一份不进 git**(.gitignore),事实的最终家是节点 H 的 `models.yaml`;\n'
  printf '照下面填完 models.yaml 就删掉本文件。密钥不在这里,在 .env 的 `COMMAND_CODE_API_KEY`。\n\n'
  printf '## 契约体量\n\n'
  printf -- '- 来源:%s\n' "$CONTRACT_SOURCE"
  if (( ${#CONTRACT_FILES[@]} > 0 )); then
    for f in "${CONTRACT_FILES[@]}"; do
      printf -- '- `%s`:%s B\n' "$f" "$(wc -c <"$f" | tr -d ' ')"
    done
  else
    printf -- '- (两份契约都不在盘上;节点 E 未落库)\n'
  fi
  printf -- '- 合计:%s B ≈ %s tokens(按 2.5 B/token 往高估)\n' "$CONTRACT_BYTES" "$CONTRACT_TOKENS"
  printf -- '- 判尺:× 10 余量 = ≥ %s tokens(余量留给模板、≤5 轮回喂的校验错误与模型自身输出)\n\n' "$NEEDED"
  printf '## 模型上下文判定表\n\n'
  printf '判据来自 /provider/v1/models 的实时响应,每条还带 supported_endpoints ——\n'
  printf 'Claude 只走 /messages,其余走 /chat/completions,发错端点服务端 400。\n\n'
} > "$NOTES_FILE"
if (( CATALOG_OK == 1 )) && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const [file, needed] = process.argv.slice(1);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw
      : (Array.isArray(raw.data) ? raw.data : (Array.isArray(raw.models) ? raw.models : []));
    if (!list.length) { console.log("  (目录结构不是常见的 {data:[…]}/{models:[…]},字段需人工核对)"); process.exit(0); }
    const pick = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return null; };
    const rows = list.map(m => {
      const id = pick(m, ["id","model","name"]) ?? "?";
      const ctx = pick(m, ["context_window","context_length","contextWindow","max_context_tokens","context"]);
      const eps = pick(m, ["supported_endpoints","endpoints","supported_endpoints"]);
      return { id, ctx, eps: Array.isArray(eps) ? eps.join(",") : (eps ?? "(未给)") };
    }).sort((a,b) => (b.ctx ?? 0) - (a.ctx ?? 0));
    let pass = 0, fail = 0, unknown = 0;
    for (const r of rows) {
      let verdict;
      if (r.ctx == null) { verdict = "? 未给上下文"; unknown++; }
      else if (r.ctx >= needed) { verdict = "✅"; pass++; }
      else { verdict = "❌ 不够"; fail++; }
      const ctx = r.ctx == null ? "?" : String(r.ctx);
      console.log("  " + verdict.padEnd(3) + " " + ctx.padStart(9) + "  " + r.id.padEnd(42) + "  " + r.eps);
    }
    console.log("");
    console.log(`  合计 ${rows.length} 个:够 ${pass} · 不够 ${fail} · 未知 ${unknown}`);
  ' "$CATALOG_FILE" "$NEEDED" | tee -a "$NOTES_FILE" 2>/dev/null || warn "node 解析目录失败,目录原文仍在 $CATALOG_FILE"
else
  note "没有目录可判。人工对照 $CC_MODELS_PAGE 的「上下文」列与上面这条尺子。"
fi
note "把本屏输出原样抄进 $NOTES_FILE 的模型一节,连同端点归属 —— 那是 H 填 models.yaml 的输入。"
pause "继续"

# ── Stage 7 · 收尾:非密钥事实落盘 + 可选探活 ──────────────────────────────
stage "收尾:落盘事实,并(可选)真打一次请求"
{
  printf '\n## 开通结论(节点 J,%s)\n\n' "$(date -u '+%Y-%m-%d')"
  printf -- '- 服务商:Command Code(聚合;本次只接这一家)\n'
  printf -- '- base_url: %s\n' "$CC_BASE"
  printf -- '- 端点归属:Claude → /messages(仅此);OpenAI 与开源模型 → /chat/completions(多数亦可 /responses)\n'
  printf -- '- 模型 id 规则:必须带 provider 前缀(如 deepseek/deepseek-v4-flash),发错端点 400\n'
  printf -- '- 套餐档位:%s\n' "${CC_PLAN:-未记}"
  printf -- '- 额度:留 %s USD;窗口形态 %s\n' "${CC_CREDITS:-未记}" "${CC_WINDOWS:-未记}"
  printf -- '- 套餐门槛:Go 档调 /provider/v1 返 403 upgrade_required\n'
  printf -- '- 契约体量:%s B ≈ %s tokens,判尺 ×10 = ≥ %s\n' "$CONTRACT_BYTES" "$CONTRACT_TOKENS" "$NEEDED"
  printf -- '- 上下文判定表:见本文件上一节(自 /provider/v1/models 实时拉取,时间 %s)\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
  printf -- '- 目录端点**无需鉴权**(实测):拿到目录不证明 key 有效;鉴权以 Stage 7 的真实请求为准\n'
  printf -- '- key 落点:.env 的 COMMAND_CODE_API_KEY(明文,gitignore);**不落 GitHub secrets**\n'
  printf -- '- 消费者:节点 H 照此填 models.yaml;填完本文件即可删\n'
} >> "$NOTES_FILE"
note "✓ 事实写入 $NOTES_FILE(已 gitignore)"

if [[ -n "$API_KEY" ]] && command -v curl >/dev/null 2>&1; then
  say "真打一次最小请求才算数(约 1~2 千 token,几分钱)。"
  warn "这是全程唯一的鉴权与端到端证明 —— Stage 5 的目录是公开端点,过了不算数。"
  if confirm "现在发一次(POST $CC_BASE/chat/completions,$PROBE_MODEL,max_tokens=16)?"; then
    tmp_body=$(mktemp)
    http_code=$(curl -sS -m 120 -o "$tmp_body" -w '%{http_code}' \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "{\"model\":\"$PROBE_MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}" \
      "$CC_BASE/chat/completions" 2>/dev/null || echo 000)
    if [[ "$http_code" == 200 ]]; then
      note "✓ HTTP 200 —— key、额度、档位、端点全通。"
      printf -- '- 探活结论:**已发真实请求,HTTP 200** —— key 有效、套餐足够、端点正确(%s)\n' "$PROBE_MODEL" >> "$NOTES_FILE"
      command -v node >/dev/null 2>&1 && node -e '
        const b = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
        console.log("  服务返回 model:", b.model ?? "(未给)", "| 消耗:", JSON.stringify(b.usage ?? {}));
      ' "$tmp_body" 2>/dev/null || true
    else
      warn "HTTP $http_code —— 端到端没通。响应体前 300 字:"
      head -c 300 "$tmp_body" 2>/dev/null | sed 's/^/    /' || true
      note ""
      printf -- '- 探活结论:**HTTP %s,端到端未通** —— key 尚未被证明可用\n' "$http_code" >> "$NOTES_FILE"
      case "$http_code" in
        401|403) SKIPPED+=("探活 401/403:key 无效或档位不够(Go 档 403 是已知情形)") ;;
        402)     SKIPPED+=("探活 402:余额不足,去 Studio > Billing 充值") ;;
        429)     SKIPPED+=("探活 429:撞上 5 小时/每周窗口,等窗口重置") ;;
        400)     SKIPPED+=("探活 400:多半是模型 id 不存在($PROBE_MODEL)或该模型不走此端点(Claude 只能走 /messages)") ;;
        *)       SKIPPED+=("探活返回 $http_code:读上面的响应体定位") ;;
      esac
    fi
    rm -f "$tmp_body"
  else
    note "跳过探活。**结论:key 到底能不能用,目前未知** —— 目录端点是公开的,过了不算数。"
    SKIPPED+=("探活未做:key 有效性未经验证,Stage 7 重跑一次")
    printf -- '- 探活结论:**未做** —— key 有效性未经验证(目录端点公开,拉到目录不算证明)\n' >> "$NOTES_FILE"
  fi
else
  SKIPPED+=("探活:缺 key 或 curl")
  printf -- '- 探活结论:**未做**(缺 key 或 curl)\n' >> "$NOTES_FILE"
fi

note ""
note "下一步(不属于本活):"
note "  · 节点 I 用 research 做模型选型(可用性/定价/上下文),结论进 models.yaml"
note "  · 节点 E 落终稿契约后,重跑本脚本 Stage 3/6 复核上下文判定"
note "  · 本活的事实家:$NOTES_FILE 与 .env;报告里只留一行 gist 加指针"

finish
