# 定案:沙箱选型与预算裁决形态(grilling)

Type: grilling
Status: resolved
Blocked by: 02, 03, 04

## Question

汇总裁决(本图终点,答案 = 可直接落进 hld §5 / §12 #1 #8 的决策清单;#4 已决):

1. **双计数预算是否成立**:指令计数 + API 调用计数为主判据(hld §5.3)在实测数据下站不站得住(粒度、开销、可复现性)?内存上限与墙钟观测的配套形态一并定稿。
2. **沙箱选型定案**:quickjs-wasi 留任;若不成立,给出重选路径的**明确方向**(候选与筛选维度,细节可留给雾)。
3. **注入形态定案**:已决于票「跨边界调用形态对比」——保留 bundle,不回退逐函数注入;本节只汇入总裁决清单确认,不重开。
4. **trap 约束定案**:采纳票「WASM trap 滥用的约束设计」的结论,hld §5.2 裁决表按需改写;WASI 冻结三件套的取值与审计写法、`exceptionTicks` 续算机制一并确认。

## Answer

**汇总裁决落定,8 项决策可直接对表 hld §5 / §12;文档已同步执行。** 每项一行 gist,细节各归其家:

1. **双计数预算成立,口径定案**:主判据 = **控制流事件计数**(每 5000 次控制流事件一格,`interruptHandler` 回调自乘计数;不称"指令计数"——直线代码不计量)+ API 调用计数;盲区由 §6.2 **脚本体积上限**封堵(取值随预算参数标定)。实测支撑见 [沙箱行为实测 harness](02-sandbox-spike-harness.md)(回调拖慢 ≤3%、纯计数可复现)。
2. **沙箱留任 quickjs-wasi**:锁版 **3.6.2**(基线 ≥3.5.0);升级须重跑重放一致性测试 + 沙箱行为复测。11 条断言判定(6 成立 / 4 不成立均有封堵 / 1 已补机制)见 [沙箱行为实测 harness](02-sandbox-spike-harness.md)。
3. **注入形态 = runtime bundle**:维持 hld §4.5,不回退逐函数注入——[跨边界调用形态对比](03-runtime-bundle-vs-injection.md)已决,汇入确认。
4. **trap 约束整包采纳**:[WASM trap 滥用的约束设计](04-trap-abuse-countermeasures.md)的 A–D 全部执行(§5.2 裁决表重写、§5.0 两处措辞、gdd 补两行、`exceptionTickLimit` 判"足"不加新机制);`exceptionTicks` 随 JSONL 续算不清零,维持现状。
5. **内存判据 = 读数判据制**:每 tick 末 `runGC()` 后取 `getMemoryUsage().mallocSize` 与 `memoryTickCeiling`(ruleset 参数)比较,超线视同 §5.2 第一行异常;软阈值 0.8×硬仅披露 `memory-pressure`;判据锚定读数——guest 吞 OOM 同罪、不因"吞"加刑;残余"瞬时借满即还"型不判罚、不 patch 宿主,留升级条款——整包采纳 [OOM 异常被 guest 吞掉的 host 检测兜底](06-oom-swallow-detection.md)的 A–E。
6. **墙钟配套定稿**:软限只观测;硬超时该场作废不判负(`nondeterministic-timeout` 按 §8.4 同轨)。§5.3 判罚面不动。
7. **WASI 冻结三件套定为工程常量**:冻钟 `1700000000000`、`timezoneOffset: 0`、`random_get` 固定字节填充(`Math.random` = 冻钟播种 xorshift64*,同值同序列);审计写法维持:三件套取值 + 包版本号写回放 meta 行(§7.5)。
8. **不变量入 §5.3 设计理由**:预算判据必须锚定 host 可直接测量的量,不依赖 guest 异常可见性。

**文档落点(已执行)**:hld §4.6 预算裁决行、§5.0(锁版 3.6.2 + 两处措辞修正)、§5.1(WASI 取值常量)、§5.2(裁决表五行 + 注脚四句)、§5.3(形态句 / 事件计数行改名 / 内存三层 / 不变量 / 参数枚举与标定注脚、升级条款)、§6.2(脚本体积上限行、禁动态 `import()`、污染源补 `performance`/`queueMicrotask`)、§12(#1/#8 关闭删行、#2 参数枚举同步);gdd《异常与出局》补三行([WASM trap 滥用的约束设计](04-trap-abuse-countermeasures.md) C 两行 + [OOM 异常被 guest 吞掉的 host 检测兜底](06-oom-swallow-detection.md) D 一行)。

**待建库时补**(`rulesets/` 与 `docs/rules-v1/` 尚未建):`rulesets/v1.json` 参数表须含 `memoryTickCeiling` 与脚本体积上限(取值归预算参数终值标定图);`docs/rules-v1/rules.md` 散文须披露内存判据条(tick 内瞬时触顶后自行释放的分配不判罚,见 [OOM 异常被 guest 吞掉的 host 检测兜底](06-oom-swallow-detection.md) D)。
