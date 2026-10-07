# 04: B / C 两舱盲写,凑齐三策略 × 三模型并整体替换 `benchmarks/`

**What to build:** 三舱齐 —— 策略沿用上一轮的 A 爆兵压制 / B 扩张运营 / C 占点不采集,模型各换一个。三舱全部 0 轮通过静态校验后,**一次性整体替换** `benchmarks/` 三份(契约换版本时基准脚本一律重跑、不保留,见 `benchmarks/README.md` 第 3 节)。这样 M1 一次买下两条验收:srs §4 第 2 条要的「≥2 个模型」与「不同策略」。

已知阻塞与退路:第三模型走 `/messages` 端点(端点归属逐模型不同),舱内 pi provider 侧当前没配 Claude;按 J 的口径这件事归 `wizard`,不在本节点手搓。**顺序上先跑 B 舱(pi 侧已配),C 舱的 provider 配置排在其后**;若那条路线不通,C 舱降级为 deepseek —— 只降一轴不降验收,并在判读里把降级事实写明。避开 `xiaomi/mimo-v2.6-pro`(上一轮 7 次尝试零产出的死档)。

**Blocked by:** 03(03 验的是管线;未验证的管线跑长任务会白烧一次十几分钟的外包调用)

**Status:** resolved

- [x] B 舱「扩张运营」由 `MiniMaxAI/MiniMax-M3` 写(上一轮唯一写出完整经济链条的那份)
- [ ] C 舱「占点不采集」由第三模型写;端点归属按模型各自的那一栏走,不套用别的模型的形状
- [x] 若 `/messages` 路线不通:C 舱降级为 deepseek 并在 Answer 里写明降级事实与原因(只降模型一轴,策略与「≥2 模型」不受影响)
- [x] 每舱独立跑静态校验 `--phase freeze` 退出码 0,`--max-bytes` 现算
- [x] 三舱的回喂轮次逐舱记录(0 轮通过数 / 总舱数是主指标,回喂进附记)
- [x] 三舱齐后**一次性整体替换** `benchmarks/` 三份:源码 + 编译产物同落,目录名沿用既有三个
- [x] 替换后 `check:bench` 绿(重编译必须与入库产物逐字节一致);`pnpm run check:quick` 与默认 `test` 全绿
- [x] Answer 段记录:三舱的 0 轮通过数 / 总舱数、每舱回喂轮次、C 舱策略在真规则下的自述(它上一轮按「站相邻」写,这一轮应当自己读出「必须站上去」)、三份脚本的静态校验读数
## Answer

**交付:** B 舱「扩张运营」由 `minimax-cn/MiniMax-M3` 写出;C 舱「占点不采集」**降级**为 `commandcode/deepseek/deepseek-v4.1-flash`(原定 `claude-sonnet-5` 走 `/messages` 端点,本机 pi 侧未配 Claude provider,按 J 的口径归 wizard 不在本节点手搓;**只降模型一轴,不降验收**——M1 要的「≥2 模型 + 不同策略」已满足)。三舱齐后**一次性整体替换** `benchmarks/` 三份(源码 + 编译产物同落):`cell-a-melee-pressure/`、`cell-b-expansion-economy/`、`cell-c-claim-no-harvest/`。

**实测/证据:** 三舱 **0 轮契约静态校验通过率 3/3**;C 舱另有 1 轮**编译面回喂**(严格 `tsc` 的 `TS2345`×3,同一会话 `pi --continue` 补非空断言,纯类型层零行为改动,**非**契约静态校验回喂)。`check:bench` 绿(重编译与入库产物逐字节一致);`--max-bytes` 取三份产物的最大值(现算);`pnpm run check:quick` 与默认 `pnpm run test` 全绿。三舱读数与 C 舱策略自述(已读对「必须站上去」)见 `.scratch/contract-closure/verdict-2026-10-07.md` §1–§3。

**保留未勾项:** 「C 舱由第三模型写」一条按字面未达成(该舱走的是降级路线),故保留 `- [ ]`;降级事实与原因计入下一条。
