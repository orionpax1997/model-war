# 11: 冻结期试跑——惯犯拦截进冻结流水线

**What to build:** 在 `packages/gen` 冻结流水线现有校验（tsc + 确定性静态检查 + 体积）通过**之后**加一级试跑：用刚冻好的脚本跑 K=3 场，固定种子、现行上限、小地图、对手用 `benchmarks/` 三份基准脚本；任一场出现预算超限（tick 级 events/apis 任一）即判本次冻结失败，走现有失败/回喂通道，并把"第几场、第几 tick、哪项预算、读数/上限/超出"写入回喂 prompt。阈值零容忍（K 场爆 1 次就打回）。

**Status:** resolved

- [x] 调研冻结流水线下刀缝（结论见本文件 Answer）：`pipeline.ts:331-347`（`passed` 之后、`commitArchive` 之前），只能走子进程（depcruise + 符号门禁）。
- [x] 试跑执行侧：`apps/cli/src/trial/`（与 engine 同进程，复用 `runMatch` + 真沙箱执行器；只看候选座位的 `eventTickLimit`/`apiCallTickLimit` 两轨首触；其余轨与对手座位不判）。
- [x] gen 侧：`packages/gen/src/trial.ts` 子进程封装（退出码 + stdout，与 `validate.ts` 同形；源码禁对局符号，门禁兜底）+ `pipeline.ts` 接线（失败分类沿用 `contract`，回喂逐字）。
- [x] TDD + `pnpm run verify:fast` 全绿；已知惯犯桩（死循环复刻，勿用真模型调用）验证"必被拦"，健康脚本验证"放行"（含耗时读数）。

**Blocked by:** 02（冻结流水线）、04（回喂通道）。不碰 `rulesets/`、不动引擎 step0/step5、不动战报渲染；`season.yaml` 不动。

## Answer（调研结论， chal 下刀缝）

- 最自然的缝：`sendOneRound` 内冻结期校验通过之后（`pipeline.ts:237-253` 之后），收成 `contract` 分类的 `failed`，复用 `feedback` 回喂通道——不需要新回喂格式，不改 `meta` 十一键与 `generationLog` 形状（成功轮 kind 已是 `contract`，试跑拦轮同理）。
- 三道硬墙（试跑只能走子进程，不能在 gen 里 import 引擎）：`.dependency-cruiser.js` 的 `gen-must-not-depend-on-engine-runner-replay`、`no-match-result-symbols.test.ts` 的字面量禁令（含注释）、gen"只以子进程 + 退出码消费外部工具"的既有纪律（`validate.ts` 头注，`run-validate-script.ts` 为样板）。
- 执行侧不住 `packages/tools`（该包只允许 import 真源包，hld §3.2；引 engine 要破包图方向），住 `apps/cli/src/trial/`（本已依赖 engine），gen 以 `process.execPath + dist 入口` 消费（tools 的源码直跑形态不适用：`apps/cli` 源码系 `.js` 后缀 import，类型擦除直跑解析不了；`dist` 由 `tsc -b` 备齐，vitest globalSetup 保证）。
- `match` 装载路径（`assemble`）不能直接复用：它要求四份存档且 `executeMatch` 不交回 `tripped` 明细（step0 把 tripped 转成状态变更，不进观测出口）与 `finalState`。试跑单开一条不走存档的装载路径：脚本常驻内存、runner 包一层 trip 记录器（经 `setSnapshot` 取 tick，经 `drainIntents` 载荷取轨名/读数/上限），调 `runMatch`。
- 试跑常量：K=3；种子固定（同一组种子对所有候选，保证可复现与公平）；地图固定 `corridor-split`（三张地图同为 64 格、28 点位，"小"无差别，取赛季当前地图）；对手固定三份基准脚本（`BENCHMARK_NAMES` 的真源在 `packages/tools/src/benchmarks/compile.ts`，试跑侧硬编码三名 + 自带漂移断言）；候选固定座位 0（预算计数是分座位独立的，固定座位使回喂稳定）。
- 分工（与联赛三振）：试跑只看候选座位 events/apis 两轨；uncaught/memory 与对手座位超限不判（前者进联赛后靠 `exceptionTickLimit: 3` 兜着，后者属基准健康假设，stderr 留痕）；墙钟硬超时致整场作废时同一种子重跑一次，仍作废则报 infra 错误（大声失败，不回喂）。

## Answer（实现记录）

- 下刀缝与调研一致：`sendOneRound` 内冻结期校验通过之后跑试跑，拦下收成 `contract` 分类的
  `failed`（新增 `stage: "static" | "trial"` 只决定人类可读 `message`，`generationLog` 仍是票 07
  定稿的两档；`meta` 十一键、`FailureClassification` 三档一字未动）。回喂沿既有通道逐字，
  不需要新格式。
- 执行侧 `apps/cli/src/trial/`：`trial.ts`（常量 K=3/种子 101·202·303/地图 corridor-split/
  三基准对手/候选 0 号位 + 纯判定 `verdictOfTrips` + 反馈文案）→ `match-run.ts`（runner 外包
  trip 记录器，经 `setSnapshot` 取 tick、经 `drainIntents` 载荷取轨名/读数/上限，调 `runMatch`；
  记全部 tripped，判只看候选座 events/apis）→ `run-trial-script.js`（dist 入口，退出码 0 过/
  1 拦/stdout 回喂/2 infra；预算三件全复用 `assemble.ts`，首拦早停）。
- gen 侧 `packages/gen/src/trial.ts`（子进程封装，与 `validate.ts` 同形；禁用符号门禁仍绿）+
  `pipeline.ts` 接线（`GenerationRequest`/`GenerationOptions` 各添可选 `trial` 探针，缺席走真子进程）。
- 验证：死循环惯犯 exit 1（反馈"第 1 场第 0 tick、控制流事件计数、读数 50000/上限 50000/超出 0"，
  早停后 ~2s）；健康脚本 exit 0（3 场 ~6–10s，相对模型 API 的几分钟可忽略）；`gen-cli` e2e
  新增"惯犯必拦"用例（exit 1 + `failed-*.json` 分类 contract + 诊断含试跑明细），与既有"放行"
  e2e 同绿；`pnpm run verify:fast` 全绿（98 文件 / 1031 测 / 3 跳过）。
- 单测提速：既有冻结成功路径（pipeline/run/failure/gen-archive）全部注入通过桩试跑，
  真试跑只属于两条 e2e 与手工冒烟。
- 未碰：`rulesets/`、引擎 step0/step5、战报渲染、`season.yaml`、meta 形状、失败分类取值。
