# 03: 真 VM 的执行器:生命周期、桥与三件套

**What to build:** 一个座位可以被**真的** QuickJS VM 服务。一个只返回空意图的夹具脚本在 VM 里被执行,引擎把它当作某个座位的执行器收下:快照以只读载荷进、意图出;VM 的 `Date` / `Math.random()` / 时区由固定常量决定;两个宿主桥在脚本执行**之前**被从全局删掉。

这是本 feature 的第一枚 tracer bullet:它第一次把「一份脚本 → 一个真正被隔离的执行器 → 引擎的意图列表」这条最窄但完整的路走通。

**三件套为什么是工程常量而不是对局参数**:判罚与读数都锚定宿主可直接测量的量,墙钟与随机源必须在对局内失去推进能力,否则重放不可复算。三件套的取值要能被审计,所以由后续票写进回放 meta。

**删桥为什么必须是第二层防线**:删桥后脚本引用它只是普通 `ReferenceError`,被 `try/catch` 吞掉时宿主零痕迹。真正的红线是静态校验期的 `__*` 禁令;删桥是纵深防御,不是判罚手段。

**不实现防御性重建**:实测脚本路径上的深递归是 host 侧 `RangeError`,不是 WASM trap,且溢出后 VM 可续用。trap 若真发生属引擎故障,走「重跑一次」那条轨,重建会把引擎缺陷掩盖成「这一方运气不好」。

决策依据:`.scratch/sandbox-executor/spec.md`《四类裁决》《双重计数与墙钟》。

**Blocked by:** 02(缝的载荷加栏与执行器泛化)

**Status:** resolved

- [x] 引擎新增对 `quickjs-wasi` 的**运行时**依赖,且仍然不做磁盘 I/O(wasm 字节与运行时代码字节都由组装层传入);边界门禁仍绿
- [x] 每方一个独立 VM,四个 VM 同进程、按座位串行,线性内存互不可见
- [x] 三件套生效:同一份脚本在对局内、跨 VM、跨重跑三个维度得到同一序列(一条用例同时钉三个维度)
- [x] 桥在脚本执行前被删:脚本按前缀枚举为空、`typeof` 为未定义;闭包内引用照常工作;脚本引用已删桥得到普通 `ReferenceError`
- [x] 每 tick 结束时待处理 job 排空到不动点——有一条**能弄红的反例**:不排空则意图跨 tick 残留
- [x] 同一夹具脚本重跑十次得到逐 tick 相同的状态 hash(与桩路径的十次重跑同口径)
- [x] 脚本产出的意图经既有校验与结算路径进入状态,不绕过任何一格

## Answer

真沙箱执行器落地,缝仍是那两个方法。

- **工厂** `packages/engine/src/runner/quickjs.ts`:`createQuickJsRunner({wasm,runtimeCode,scriptCode,seat,…})` → `{runner, dispose}`;`SeatRunner` 恰好两方法,建 VM / 释放归调用方。内部 `openSandbox` 交回 `setSnapshot / runLoop / pumpJobs / drainIntents / dispose`,给「不排空则意图跨 tick 残留」这条反例留了能弄红的入口。
- **运行时源码** `packages/engine/src/sandbox-runtime/index.ts`(TS,guest 侧):两个桥 + `getTick` / `getObjectsByType` / `move` 的最小骨架(铺全归票 06)。桥名由构建脚本经 esbuild `define` 注入,源码不手写字面量;bridge 闭包状态住在 IIFE 里,不落 guest 全局。座位 `getMyIndex` 由宿主按座位注入常量函数(runtime 是同一串字节)。
- **三件套**由 `createSandboxVm` 的构造选项钉住:`wasi.clock_time_get` 覆盖为固定纳秒值(同时定 `Math.random` 的种子)、`timezoneOffset: 0`。
- **测试**:`runner/quickjs.test.ts`(删桥 / 排空到不动点 + 反例 / 四 VM 内存隔离 / 三件套三维度 / 缝两方法);`sandbox.test.ts` 照 `determinism.test.ts` 四条结构跑真 VM(十次重跑、非常量、回放可复算、换冻钟反向自证)并加一条端到端(单位真的动了)。夹具 `fixtures/guest/{march,random-march}.js` 入库。
- **依赖**:`packages/engine/package.json` 的 `dependencies` 加 `quickjs-wasi@3.6.2`,`pnpm-lock.yaml` 已更新;`dependency-boundary.test.ts` 两条与 `check:deps` 全绿。
- **一处工程补充**:类型基座 `lib: ["es2023"]` 没有 `WebAssembly` 全局(它只在 DOM/WebWorker 那两份 lib 里),故新增最小面声明 `packages/engine/src/webassembly.d.ts`,不把 DOM 拉进内核。
- **口径提示**:`sandbox.test.ts` 的 `head` 用了 `runner: "quickjs"` 与四个占位读数(真值归票 04);它们不进 `stateHash`。

跑过的:`pnpm run check:quick`、`pnpm run check:deps`、`pnpm run check:declared-deps`、`pnpm exec vitest run --project unit packages/engine`(26 文件 / 207 用例全绿)。
