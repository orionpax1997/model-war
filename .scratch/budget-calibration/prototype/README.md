# PROTOTYPE:预算键标定读数量测(一次性)

> **这是 throwaway,不是交付物。** 它回答一个问题,回答完就该被忘掉;落盘的只有结论与证据。
> 由 K(预算参数终值标定)开工前的 grilling 触发,产物是「让 8 个键的取值有事实依据」。

## 1. 它回答的问题

K 要标定 `exceptionTickLimit` / `eventTickLimit` / `apiCallTickLimit` / `memoryLimit` /
`memoryTickCeiling` / `wallClockSoftLimit` / `wallClockHardTimeout` / `scriptSizeLimit` 八个键。
标定需要「真实脚本在真沙箱里的每 tick 读数」,而仓库里**没有**任何逐 tick 测量探针——
`observations.jsonl` 只在观测轨启用时才生成,而八个键全是未定值、四轨全不启用(见
`.scratch/contract-closure/replay-matrix.md`「观测文件」一节:10 局一个字节都没生成)。

问题:**诚实脚本的事件计数 / API 调用 / 存活堆 / 单 tick 墙钟落在哪个量级?对抗脚本的
增长速率是多少?两者差几个数量级?**

## 2. 它怎么量

`readings-probe.mjs`:一个一次性的**仪表化执行器**,逐条镜像 `createQuickJsRunner` 的每 tick
次序(`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),
只在中间多记一笔;不改任何判定、不装任何观测轨。`eventTickLimit: MAX_SAFE_INTEGER` 只为
**让计数回调被装上**(否则闭包计数器根本不建,`eventCount` 恒 0)。

- 诚实局:4 席同一份 `benchmarks/*/script.js`、种子 `20260101`、跑满 `tickLimit=600`。
- 对抗局:一次性内联脚本 + 硬超时 1000ms 封顶(不用事件轨截停,以便量出**原始速率**)。

```
node .scratch/budget-calibration/prototype/readings-probe.mjs [--only=<id>]
```

读数表见 `readings.md`,原始数据 `readings.json`。

## 3. 结论一(阻塞项):每 tick 泄漏一份快照

第一次跑 `adversarial-empty`(空脚本)时,存活堆从 18.2 MB **单调**涨到 36.7 MB。
`leak-check.mjs` 把它隔离开:**空脚本、零插桩、真实 runner 次序**,存活堆精确 **+360 B / +5 个对象每 tick**,600 tick 线性到 337 KB。

根因在 `openSandbox.setSnapshot`(`packages/engine/src/runner/quickjs.ts`):

```ts
vm.callFunction(setSnapshotHandle, vm.undefined, vm.hostToHandle(snapshot)).dispose();
```

`hostToHandle(snapshot)` 返回的是**调用方拥有、必须释放**的 handle(`quickjs-wasi` 的
`JSValueHandle` 文档),这里只 `dispose()` 了**返回值**的 handle,参数 handle 每 tick 丢一份——
连同它引用的整棵 guest 快照(含 `players`/`units`/`sites`)一起留在 VM 里。

**一次性验证**:给 dist 打一行补丁(补 `argHandle.dispose()`),同一探针下存活堆 600 tick
**完全平**(121168 B 不变);`adversarial-empty` 的 600 tick 墙钟从 **27812 ms 掉到 2737 ms**。

**这对 K 的意义**:泄漏不修,`memoryTickCeiling` / `memoryLimit` 无论标成多少都是在标一份
「会自己涨的读数」——600 tick 就涨 18 MB,任何有限的判罚线都会在对局后段被自己的引擎踩到。
**修泄漏是标定内存两个键的前置**,不是并列项。

## 4. 结论二:诚实脚本的读数分布(修泄漏后,本地 patch 的 dist)

| 量 | 诚实脚本(3 舱 × 3 图 + 混编,10 局) | 对抗脚本(硬超时 1000 ms) |
|---|---|---|
| 控制流事件/ tick | 观测上界 5000 格 → 真实值 **< 10,000**(粒度 5000,读数封顶;p95=5000、p50=0) | spin:**12.8 M / 1003 ms ≈ 12,760 事件/ms** |
| API 调用/ tick | **p95 ≤ 135,峰值 179**(cell-b 最重) | api-bomb:**5.6 M / 1007 ms ≈ 5,560 调用/ms** |
| tick 末存活堆 | **p50 195–201 KB,峰值 206.5 KB**;空局基线 182.9 KB | 与空局同量级(纯计算不增长堆) |
| 单 tick `loop()` | **峰值 ≤ 2 ms**,p50 = 0(亚毫秒) | 被硬超时截停于 ~1003 ms |
| 单局墙钟(600 tick) | **2.5–3.6 s** | 1 tick 即被硬超时作废 |

由此得到的量级关系:

- 诚实与对抗在**事件计数**上差 **≳ 1000 倍**(<1 万 vs 1276 万/ms),在**API 调用**上差
  **≳ 10^4 倍**(≤179 vs 556 万/ms)。两条计数轨的阈值有极大的选择空间,不必贴边。
- 事件轨的截停时延:阈值 L 对应约 `L / 12760` 毫秒。L = 100 000 → ~8 ms;L = 1 000 000 → ~78 ms。
  API 轨:阈值 L 对应约 `L / 5560` 毫秒,L = 50 000 → ~9 ms。
- 内存在**修掉泄漏后**是稳态的,诚实脚本峰值 ~207 KB,离空局基线只差 ~24 KB;分配上限与
  判罚线可以贴着几百 KB 选,而不必为「泄漏的成长」留余量。
- 单 tick 墙钟诚实 ≤2 ms,软限选几十 ms 已足够宽;硬超时是防宿主卡死的兜底,当前 1 s 量级
  能截住任何不含计数轨的死循环,但会连带作废整场(所以它是最后防线,不是主判据)。

## 5. 它不回答什么

- **不裁任何取值**。上面只给分布与量级,阈值取多少是 grilling 的事。
- **对抗探针是一次性的**。K 要的正式对抗探针(纯计算死循环 / API 轰炸)仍需按流程另造;
  本 prototype 的版本只为量速率,不含 K 验收要的「命题②」形态。
- **`scriptSizeLimit` 没量**:它是编译期的事,输入是产物字节数,已由
  `benchmarks/README.md` 记下当前三份产物的最大值 7579 B(cell-b)。
- **`exceptionTickLimit` 没有直接读数**:诚实局 10 局 40 席零异常,只知它不该被诚实脚本踩到。
- **单 tick 墙钟的 `runGC()` 开销**没单列:它在内存轨启用时才发生,是 K 标定 `memoryTickCeiling`
  时要一并考虑的代价(hld §5.3 已记 0.5–3.3 ms/tick)。

## 6. 复现注意

第 4 节的读数来自**本地打过泄漏补丁**的 `packages/engine/dist/runner/quickjs.js`(补丁未入库,
验证完已撤回)。泄漏未修时,诚实局的墙钟与存活堆数字都不成立(见第 3 节)。
