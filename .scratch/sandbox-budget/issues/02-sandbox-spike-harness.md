# 沙箱行为实测 harness(task spike)

Type: task
Status: resolved

## Question

用一个最小 throwaway spike harness 实测 hld §5 的关键行为断言，为预算裁决形态定案供数。spike 不进 `packages/`,放 `.scratch/sandbox-budget/spike/` 即可。开测前先读票「quickjs-wasi 语义核查」的结论，把"文档未承诺"项并进测量清单；但本票不依赖它——能测的直接测。

1. **中断计数**:实测 `interruptHandler` 的实际触发粒度（每次回调间隔多少字节码指令）与单次回调开销 → 换算"每 tick 指令计数"的判据精度与耗时占比；
2. **内存上限**:实测 `memoryLimit` 超限的实际表现：异常类型、是否可捕获、VM 之后是否可续用；
3. **失控行为**:死循环与深递归的实际表现（interrupt? trap? trap 后 VM 状态如何）;VM 可续用还是必须重建；重建（重载脚本）的实际代价量级；
4. **异步排空**:实测 `executePendingJobs` 排空行为；不排空时 Promise 回调跨 tick 残留的实际后果；
5. **确定性冻结**:实测 WASI 覆盖效果——冻钟后 `Date.now()` / `new Date()` / `Math.random()` 是否在逐 tick、逐 VM、逐次重跑三个维度全部一致；
6. **跨边界开销**:实测单次跨宿主边界调用（`__setSnapshot` / `__drainIntents` 型）与逐函数注入型调用的开销量级，按不同快照粒度 × 不同 API 调用密度给数——供票「跨边界调用形态对比」。

产出:测量数据表 + 每条 §5 断言"成立与否"的判定输入,链为资产。

## Answer

spike 落在 `.scratch/sandbox-budget/spike/`(`run-all.sh` 一键复现,原始输出 `results/`),测量数据表 + §5 断言判定表在 **[spike/FINDINGS.md](spike/FINDINGS.md)**。要点:

1. **中断计数**:`interruptHandler` 每 5000 次**控制流事件**(循环回边/调用/返回)触发一次,**不是**按字节码指令(包文档说法不成立;树形递归 2×调用数/5000 精确命中)。回调开销 1–4µs/次,总拖慢 ≤3%;回调内放墙钟型工作更贵。中断异常 guest **不可捕获** → intent 逃逸不存在;VM 续用。盲区:直线代码不计量、大循环体放大每格工作量 → "指令计数主判据"须配脚本体积上限。
2. **内存上限**:`InternalError: out of memory`,**guest 可捕获可吞掉**(host 无感知)→ §5.2 披露条款需 host 侧 `getMemoryUsage()` 阈值兜底;VM 续用、反复触顶无损伤。
3. **失控行为**:深递归 = host `RangeError`(**非 WASM trap**),VM **可续用、无需重建** → §5.2 trap 行降级为可选;`maxStackSize` 选项存在(hld §5.0 断言不成立);重建代价 2–10ms(字节码缓存后 2ms)。死循环无 interrupt 只能硬超时杀。
4. **异步排空**:`executePendingJobs` 排空到不动点;eval/call 不隐式推进 job;不排空 → intent 跨 tick 时序错位实证 → 每 tick 排空是必要设计。
5. **确定性冻结**:冻钟+tz 0+固定 random 后,tick/VM/重跑三维度全部一致(含 PRNG 同种子同序列,重跑 digest `648fc882a638db3a`);`performance.now()` 同被冻结但 `performance`/`eval`/`queueMicrotask` 在场 → 进 validator 污染源名单。
6. **跨边界开销**:载荷型桥 ≈5µs+2.6µs/KB(1KB≈12–25µs / 16KB≈54–67µs / 64KB≈173–186µs 每 tick);逐函数注入 ≈0.85µs/次(密度无关);~60 次调用/tick 是两形态交叉点;空 tick 蹦床 0.7–0.9µs。供票「跨边界调用形态对比」。

§5 断言 11 条判定(✅7 / ❌4 / ⚠️1)见 FINDINGS §7;M7 顺带补测了票「quickjs-wasi 语义核查」的第 6 项(无 loader 时 import 行为、默认全局面盘点),可直接并入该票。

## Comments

- [quickjs-wasi 语义核查](01-quickjs-wasi-semantics.md) 已 resolved:「必须实测」12 项清单见 [findings §8](../findings/01-quickjs-wasi-semantics.md#8),开测前并进测量清单。另注意两点:interrupt 粒度为每 10000 opcode 一次(测 #1 时按此换算);v3.3.0 的 memoryLimit 不约束留存内存(测 #2 时需分辨版本)。
