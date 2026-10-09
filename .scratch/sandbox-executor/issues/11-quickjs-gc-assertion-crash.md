# 11: quickjs-ng GC 断言崩溃(真实脚本组合,确定性复现)

**What to build:** 诊断并修掉一处**确定性**的引擎 / 沙箱崩溃:`I 真实赛季`(season 票 11)整轮 60 局里有 1 局
(`c3-corridor-split-s2`)在 quickjs-wasi 里触发 GC 断言、子进程 `exitCode 2`(`engine-crash`),重跑一次仍触发,
被调度器按 §8.4 排除出排名。它是真实冻结脚本组合触发,不是偶发网络 / 宿主抖动。

**Blocked by:** 无

**Status:** ready-for-agent

## 复现

1. 用 season 票 11 的 5 条真实存档(`archive/<slug>/2026-10-09T01-09-09-599Z/`,已入库)与
   `.scratch/season-scheduler/e2e-readings.md` §2 的 `season.yaml`(`masterSeed: "2026-m4"`、`seeds: 4`、
   `maps: [corridor-split, fortress-core, open-clash]`)跑 `modelwar run --config season.yaml`;
   赛季**确定性**(种子 = `H(masterSeed, combo, mapIndex, seedIndex)`),会稳定复现 `c3-corridor-split-s2`。
2. 或直接对那一局的 `input.json`(该局 map `corridor-split`、seed `2936867027`、
   `archives = [mimo-v2.6-flash, muse-spark-1.3-contributor, deepseek-v4-flash, gpt-6-luna]` 的该 runId 存档)跑
   `modelwar match <input.json> --root .`——实测连跑两次同一处断言、同一 `exitCode 2`。

崩溃输出:

```
Assertion failed: JS_REF_COUNT(p) > 0 (quickjs-ng/quickjs.c: gc_decref_child: 7365)
Assertion failed: JS_REF_COUNT(sh) == 0 (quickjs-ng/quickjs.c: js_free_shape0: 5816)
modelwar match: 引擎故障:RuntimeError: unreachable
```

## 方向(待诊断,不预设)

- 先判归属:是引擎侧(`packages/engine`)违反了 quickjs 的引用 / 形状不变量(如 guest 对象跨 tick 泄漏、proto /
  shape 误用),还是 quickjs-wasi 绑定 / harness 的问题。用最小化:逐步替换四席脚本,定位是哪一席 / 哪一席组合触发。
- 触发点可能在 GC 时机(断言在 `gc_decref_child` / `js_free_shape0`),注意是否与 `memoryTickCeiling` 的强制回收扫描相关。

## 验收

- [ ] 有确定性复现脚本(存进本票或 `probes/`),不依赖真实凭证 / 网络。
- [ ] 定位到根因(引擎 / 沙箱 / quickjs 绑定 三选一),给出最小化输入。
- [ ] 修复后上述 `input.json` 跑满 600 tick、退出码 0;`pnpm run verify:fast` 全绿。
- [ ] 若根因在 quickjs-ng 上游、短期修不掉:在本票写明、给出规避(引擎侧约束),不静默忽略。

## Comments

发现于 season 票 11 的真实赛季收口;证据与读数见 `.scratch/season-scheduler/e2e-readings.md` §4 / §7。
调度器侧的「重跑一次 → 仍触发 → 记入问题清单并排除出排名」按设计正常工作,本票只处理崩溃本身。
