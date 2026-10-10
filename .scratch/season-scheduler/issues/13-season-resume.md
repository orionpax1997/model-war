# 13: 赛季断点续跑——已完成的局跳过 spawn，同配置再跑即续跑

**What to build:** `scheduleSeason` 在 spawn 一局之前加跳过检查:该局目录已有"与本次物化输入逐字节一致的
`input.json`"且 `replay.jsonl` 末行是合法 `result`,则跳过 spawn，直接读名次入报告。配合 `season.yaml`
已有的 `outputDir` 字段 pin 住输出目录，同配置再跑一条命令即续跑。不新增配置项、不改 season.yaml 契约、
不加 CLI 参数。

**Blocked by:** 无(用户在 10 模型赛季语境下直接要求)

**Status:** resolved

## 动因

2520 局赛季约 55–60 分钟(`e2e-readings.md` 0.81 局/s 基线推算);当前调度器无任何续跑逻辑:
每次运行都是新 `runId` + 全量重跑(`scheduler.ts:449-451`);中止/被杀后只剩半截 `matches/`，
且没有任何现成命令能消费半截产物(报告只在赛季末尾由内存 `outcomes` 一次写出)。

## 语义(定死的判据，两条缺一即重跑)

落在 `runMatchUp`(`packages/runner/src/scheduler.ts:338-346`)的 spawn 之前:

1. `<matchDir>/input.json` 存在且与本次 `materializeInput` 序列化逐字节一致——配置
   (participants/maps/seeds/masterSeed/存档哈希)变了输入必变，旧回放永不混进新赛季。
2. `replay.jsonl` 经 `parseReplay` 读通且末行是 `result`——中断半截 / 坏回放天然不满足，
   码 2/3 两次挂掉的局的残留也不满足，照常重跑。

跳过的局走**同一条** `completedOf`(含 `observations.jsonl` 的 memory-pressure 披露)，
报告组装路径零分叉;跳过检查是纯读盘 + 纯函数比较，worker 间无共享可变状态，不新增竞态。

## 明确非目标

- 不做跨配置合并、不做"只跑某几局"的选择器。
- `report.json` 的 `runId` 仍取本次运行时刻(即赛季**完成**时刻);`inputPath` 是相对路径，
  不含 runId，其余报告内容不受影响。

## 验收

- [x] 同 fixture 跑两次:第二次 0 spawn、退 0、`matches` 仍全、`matchIssues` 口径不变。
- [x] 篡改某局 `input.json`(模拟配置变更)→ 仅该局重跑，其余跳过。
- [x] 截断某局回放(模拟中断半截)→ 仅该局重跑。
- [x] 跳过的码 0 + memory-pressure 局，披露条目仍在(走 `completedOf` 的证明)。
- [x] `scheduler.ts` 注释写清"为什么比较 input + 为什么半截天然重跑";hld §9 `run` 行加续跑半句。
- [x] `pnpm run check:quick` 与 runner 相关测试全绿。

## Comments

用户原话:10 模型赛季(2520 局)"能不能断点续跑"——"需要加"。
续跑用法(`season.yaml` 写死 `outputDir` + 同一份 config 再跑)须写进本票 Answer，供用户直接照抄。

## Answer

**改动文件:**

- `packages/runner/src/scheduler.ts:3`(头注续跑一句)、`:332-358`(`isResumable` 判据 + 「为什么比较
  input + 为什么半截天然重跑」注释)、`:362-392`(`runMatchUp`:先判续跑跳过 spawn,否则重跑前
  `rmSync` 删旧 `replay.jsonl` + `observations.jsonl` 再写 `input.json` + spawn)、`:64`(`rmSync` 进口)。
  跨配置旧回放一项是 code-review Spec 轴抓出的真 bug(旧配置跑通残留合法末行 + 崩溃子进程在
  `match/index.ts` 写回放之前返回,两条旧判据会被同时满足):修法即重跑前删旧文件,另见测试 `:593`。
- `packages/runner/src/scheduler.test.ts:459-620`(票 13 块:`countingSpawn` / `runSeasonGreen` /
  `resumeWithCounting` + 5 个用例 `:504` / `:523` / `:547` / `:565` / `:593`)。
- `docs/hld.md:800`(`run` 行加续跑半句)。

**测试证据:** `pnpm run check:quick` 全绿;runner unit 86/86、property 3/3;`apps/cli` unit 163/163
(含 fixture 赛季 e2e)。`:593` 用例在无 fix 时红(旧名次混入)、有 fix 时绿,已双向验证。

**续跑用法(照抄):**

```yaml
# season.yaml 里写死输出目录(本票不新增配置项,就用已有字段 pin 住)
outputDir: runs/m4-season
```

```sh
modelwar run --config season.yaml   # 第一次全量跑;中止/被杀后原样再跑同一条即续跑
```

同配置再跑时已完成的局 0 spawn(直接读名次,内存披露照常);配置变了 / 回放半截的局自动重跑。
`report.json` 的 `runId` 取本次(完成时刻)运行时间。
