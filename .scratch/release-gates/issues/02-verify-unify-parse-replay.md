# 02: 对局校验统一到回放唯一读入端

**What to build:** 对局校验走回放包的唯一读入端,不再自带第四份读入逻辑;其余三处读入逻辑不动,本票只收这一份分叉,并有测试盯着统一不断。

**Blocked by:** None (can start immediately).

**Status:** resolved

## 验收

- [x] 对局校验经唯一读入端取行,自家读入分叉已删除
- [x] 既有校验断言全绿,新增统一不断的测试

## Answer

**选定/理由:** `verify` 的自家 `parseLines`(裸 `JSON.parse` cast,非回放行静默放行)整段删除,读入改走 `@model-war/replay` 的 `parseReplay`——与渲染器 / 调度器 / 报告三处同端,「读一份回放」只剩一个家。`parseReplay` 收路径、自己读盘,并额外拒跑「整个文件读不出任何一行」与「某行 `type` 不在 meta/tick/result 之内」两类坏回放;后者正是本票「统一不断」的可观测差:旧行为下给回放插一行 `{"type":"bogus"}`,`verify` 会退出 0(被随后的 `filter`/`find` 静默忽略),统一后退出 1。渲染 / 调度 / 报告三处读入逻辑按 spec 未动。

**改动文件:行号**

- `apps/cli/src/verify/index.ts`
  - `:21`:删 `import { readFileSync } from "node:fs"`(改走 `parseReplay` 后未使用,留着 oxlint 会红)。
  - `:23-29`:replay 导入加 `parseReplay`。
  - 原 `:51-64` 的 `parseLines` 整段删除。
  - `:99`: `archivedLines = parseReplay(replayPath)`;外层 `try/catch` 与退出码(`EXIT_USAGE_OR_VALIDATION`)保持不变(`ReplayReadError extends Error`,被同一 catch 收走)。
- `apps/cli/src/cli.test.ts:667-679`:新增「回放里插一行非回放行即红退 1」测试,插在既有 `verify` 一节末尾,复用 `matchToReplay` + `editReplay`(`editReplay` 往 `lines[1]` 前 `splice` 一行 `{"type":"bogus"}`)。

**测试证据**

- 反例先红:`pnpm exec vitest run --project unit apps/cli/src/cli.test.ts -t "插一行非回放行"` → `expected +0 to be 1`(旧实现退 0,天然反例成立)。
- 改代码后:`pnpm exec vitest run --project unit apps/cli/src/cli.test.ts -t "verify"` → 8 passed,0 failed。
- 全文件回归:`pnpm exec vitest run --project unit apps/cli/src/cli.test.ts` → 32 passed(0 failed),既有 verify 断言及跨进程 `match → verify`(真沙箱)全绿。
- `pnpm run check:quick` → 全绿(fmt / lint / coupling / coupling:quickjs / check:no-float / check:budget 六步)。

**跑了哪条、为什么:** 快反馈按票面走 `check:quick` 与 CLI 单测;过滤 `-t "verify"` 覆盖本票相关断言(8 条)即可判定统一是否回归,再跑整个 `cli.test.ts`(32 条,含真沙箱用例,74.9s)确认其余命令的断言(尤其既有 verify 五条)不因换读入端而回归。

**遗留风险:** 空回放 / 全空行回放的 stderr 文案由「第一行不是 meta 行」变为 `parseReplay` 的「是空的:读不到任何一行回放」;仓库内无断言这句文案(已核),退出码仍为 1,不构成回归。
