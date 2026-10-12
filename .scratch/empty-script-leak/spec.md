# 空脚本一路绿灯冻进赛季:补上「顶层 loop 入口」这道闸

Status: ready-for-agent

## Problem Statement

`docs/hld.md` §6.2「编译」那一行的通过判据写的是「`tsc` 编译通过 **+** 顶层声明 `loop` 入口」,
`tsconfig.scripts.json` 的注释也写着「它在生成管线的编译步骤里查产物」——但**这半句从未实现**。
后果是一条四道闸门全部放行的漏检:

1. `packages/gen/src/extract.ts` 对空代码围栏返回空串;
2. 空 TS 编译得过,产物是 `"use strict";`;
3. `run-validate-script.ts` 只查 API 误用与体积上限,空产物无条目可查 → `passed`;
4. 冻结期试跑按票 11 的裁定只看候选座位的 events/apis 两条预算轨,空脚本不 trip → 冻结入库。

证据(赛季 S2,`archive/mimo-v2.6-flash/2026-10-11T12-43-20-061Z/`):`script.ts` 0 字节、
`script.js` 14 字节、`meta.json` 的 `validation = { passed: true, errors: [] }`、`protocolRounds = 1`。
该产物进赛季后每 tick 调 `loop()` 抛异常,靠 `rulesets/v2.json` 的 `exceptionTickLimit = 3` 出局
(回放核实:`runs/2026-10-11T20-22-19-949Z/matches/c3-corridor-split-s0/replay.jsonl`)。

## Solution

补上 hld 已写明、代码里缺失的那道判据:产物顶层必须有一个引擎取得到的 `loop` 函数。
落点是**静态校验器**的一条新规则 `script-entry`(不是 gen 的编译步骤,裁定与理由见
[ADR-0014](../../docs/adr/0014-script-entry-checked-by-validator.md)):

- 放行:顶层 `function loop(...) {}`,或顶层 `var loop = function ... / () => ...`;
- 拒绝:没有 `loop`、顶层 `let` / `const loop`(落在全局词法环境、`vm.global.getProp` 取不到)、
  `var loop = 非函数`、块里的 `function loop`;
- 一律 blocking(两相都拦),无源码位置;命中即走既有 `contract` 失败 + 校验器 stdout 回喂。

## 验收

- 空产物(空围栏 / `"use strict";`)/ 无入口产物在冻结前被拦,`archive/` 里不留任何东西;
- 回喂文本点名脚本入口并给出该改成什么;回喂后第 2 轮补上入口 → 正常冻结;
- 三份入库基准产物过判定链仍零违规(不误伤);
- `docs/hld.md` §6.2、`tsconfig.scripts.json` 注释与 ADR-0014 与实现一致。

## Out of Scope

- 经济健康度探针、脚本运行期死锁(moveTo 失败不重试等)——属另一件事;
- 入口**签名**的形态(返回类型可省略)——归契约面与脚本编译配置,本 feature 不动。
