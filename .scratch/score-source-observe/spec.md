# 试跑「无得分来源」观测（只观测、不拦）

来源：`/tmp/model-war-handoff-economy-probe-impl.md`。

> 经济健康度探针的原型（`README.md` 与 `prototype/*.mjs` / `e2e-trial.sh`）**不在 main**，
> 按 prototype skill 的 capture 步骤放在 throwaway 分支 **`throwaway/economy-probe`** 上：
> `git log throwaway/economy-probe -- .scratch/economy-probe`。下文引用它时一律指该分支。
> 下面两处复跑命令也在那个分支上：
>
> ```
> git checkout throwaway/economy-probe
> node .scratch/economy-probe/prototype/probe.mjs runs/2026-10-11T20-22-19-949Z
> pnpm run build && node .scratch/economy-probe/prototype/cross-check.mjs
> bash .scratch/economy-probe/prototype/e2e-trial.sh
> ```

## 问题

冻结期试跑只看两条预算轨（`WATCHED_TRACKS`）。「脚本活着但经济已死、全场没有得分来源」的脚本不触限，会带着它冻进赛季。

## 判据（C1）

候选座位（`CANDIDATE_SEAT`）在**整局**内既无交付也无占点即命中（`noScoreSource`）。

- 交付：本座位存活工人相邻两帧的 `carrying` 下降之和（不用资源净变化）。
- 占点：某点位 `owner` 从非本座位变为本座位的次数。开局归属不计。
- 工人死亡时载量消失，不计交付。
- 合法反例必须不命中：`benchmarks/cell-c-claim-no-harvest`（占点 5）。

## 决定（已裁，不再讨论）

- 只观测（方案 a）：命中时向 stderr 写一行留痕，**不改 verdict、不改退出码、不改 gen 回喂**。
- 不设阈值、不进 `rulesets/`。场数与种子常量不变。
- 不追溯已冻结存档，不动 `archive/`、`benchmarks/`、`runs/`。
- 升级为 verdict 或回喂，留待观测数据之后另票。

## 验收

- `createScoreSourceTracker`：不进引擎、不起 VM，跨帧有状态的追踪器，判定口径是纯的。
  交付 / 占点 / 死亡 / 开局归属 / 他座位忽略，单测覆盖。
- `runTrialMatch` 的结果带 `scoreSource`。**接线**用例把产出按座位分开：候选占下中立点位 →
  读数记 1 次占点；换成他座位占点 → 候选读数不变。空转用例证明不了接线（所有座位都没产出时，
  「只观测候选」与「一个都不观测」读数一样）。
- 座位过滤的真源是 tracker 内部的 `owner` 比较，不是 `runTrialMatch` 里那处挂载点：四个 runner
  拿到的是同一份全世界的只读快照（步 0 只建一次），挂载在哪一侧都不改变读数。挂候选那一侧只为省。
- 命中文案 `renderScoreSourceObservation`：命中给文案，未命中给 `null`。
- 入口 `run-trial-script.ts`：命中时 stderr 有一行；stdout 与退出码不变。
- `CONTEXT.md` 补「无得分来源」词条，与「经济死亡」分开。
- 与 `.scratch/economy-probe/prototype/probe.mjs` 在同一回放上结果一致（交叉核对，不入门禁）。
- `pnpm run check:quick` 与相关 vitest 通过；收口 `pnpm run verify:fast`。

## 已执行的验证（读数留档）

- **交叉核对**（`throwaway/economy-probe` 分支上的 `prototype/cross-check.mjs`）：把
  `apps/cli/dist/trial/score-source.js` 的 tracker 与 `probe.mjs` 的 `seatSeries` 放在
  `/tmp/economy-probe/*.jsonl` 的同一批回放上，逐座位逐种子比对 `delivered` / `captures`
  —— **132 行，0 处不一致**。座位 0 的 C1 判定与同分支 `prototype/README.md` 的记录逐条吻合：
  命中 `glm` / `muse` / `mimo-pro` / `luna` / `empty`，不命中 `cell-a`（交付 40）、
  `cell-b`（占点 1）、`cell-c`（占点 5）、`deepseek`（占点 1）、`opus`（交付 40）、`haiku`。
  三个种子的 C1 判定完全一致。
- **e2e**（`throwaway/economy-probe` 分支上的 `prototype/e2e-trial.sh`）：改动前后各构建一次、
  同一入口脚本逐个跑 8 份产物。**stdout 与退出码 8/8 逐字相同**；留痕行在改动前 0/8，改动后
  4 份命中脚本各 3 行（一场一行）、4 份不命中脚本 0 行，与预期清单一致。
- **接线变异检查**：把 `runTrialMatch` 里的挂载条件改成「不挂观测」或「读数换成另一个新
  tracker」，新增的接线用例会变红；改成「挂到座位 1」则**不变红**——四个 runner 拿到的是同一份
  全世界快照，座位过滤的真源在 tracker 内部（见上）。
- `pnpm run check:quick` 通过；`pnpm run verify:fast` 通过（101 个测试文件 / 1067 通过 / 3 跳过）。

## 已知缺口（本票不做，留档）

- **留痕进不了 gen 的记录。** `packages/gen/src/trial.ts` 只消费 stdout 与退出码，stderr 被
  `spawnSync` 收下后丢弃。要让 gen 留存观测数据需另票（让 `TrialResult` 携带 stderr，
  或由 pipeline 落盘）。
- **入口层的 stderr 行不在常跑门禁里。** 仓库既有约定是「真入口的行为由手工冒烟与 `gen-cli`
  e2e 覆盖」（见 `packages/gen/src/trial.test.ts` 头注），本票沿用：那 4 份产物的留痕由上面
  那个 throwaway e2e 证明，常跑门禁覆盖到 `runTrialMatch` 为止。
- **异常轨淘汰那条边没追。** 常规淘汰（无单位无基地）之后不可能再有产出，故「观测到淘汰为止」
  等于「观测了整局」；但 `exceptionTickLimit` 打满而淘汰时名下单位还留着（只是收不到 intent
  而采不了），那条路径上的读数完整性本票未验证。
