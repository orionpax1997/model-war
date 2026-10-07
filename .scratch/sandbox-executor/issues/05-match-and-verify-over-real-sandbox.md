# 05: `match` 走真沙箱、`verify` 打通

**What to build:** `modelwar match` 用真沙箱跑完一个对局(本票用夹具脚本),回放 meta 记下真实的运行时哈希、运行时版本与三件套常量(其中时区一栏是**新增的栏位**);`modelwar verify` 逐 tick 复算一致;执行失败有可区分的退出码。

这是第二条 tracer bullet,也是「CI 重放一致性」第一次真的有入口——在那之前 `verify` 只是一行路由表登记。

**`match` 就是那个「每对局一个子进程」的子进程本身**:它已经是「读一份物化输入 → 写产物」的形状,本票把它做成**纯函数式入口**,不做 spawn、不做进程池(那是调度节点的账)。桩路径保留,但只作测试入口,不进公开面。

**执行方式不写进物化输入**:它是执行方式,不是对局输入;回放 meta 里已经如实记录它。给输入加一个字段就要动真源包与生成物,收益为零。

**为什么新增时区一栏**:hld 明文要求三件套取值都进 meta 可审计,而 schema 里只有两栏。时区是 VM 构造的选项、不在产物里,所以产物哈希也覆盖不到它——少这一栏,审计承诺就是空话。

决策依据:`.scratch/sandbox-executor/spec.md`《WASI 三件套与回放 meta》《`match` 与 `verify` 的职责》。

**Blocked by:** 04(runtime bundle 成形并入库)

**Status:** resolved

- [x] `match` 默认走真沙箱;桩路径只作测试入口,不进 CLI 公开面;物化输入**不加**执行方式字段
- [x] 回放 meta 的沙箱栏位在真沙箱模式下全部为真值(运行时哈希、运行时版本、三件套),桩模式下全部为 `null`
- [x] 时区栏位落地:形状进真源包(类型 + required + JSON Schema 三处)、经回放包再导出、校验器加一条行校验;填充法固定(十进制毫秒 / 十六进制字节不带前缀 / 十进制分钟)
- [x] 四条存档的运行时哈希与当前产物不一致时**拒跑**,不静默降级
- [x] `verify` 在 CLI 落 handler,引擎的对外导出面仍恰好一个符号;不起子进程;退出码 0/1
- [x] `verify` 逐 tick 比对状态 hash 与末行结果:改回放里一个数字即红
- [x] `verify` 核执行方式、运行时版本、运行时哈希与本次执行是否一致,不一致即报错,不静默换
- [x] 退出码表落地并写进 hld 的 CLI 章节:正常 / 用法或校验错 / 引擎崩溃 / 不确定超时 / 其它内部错;细节另在 stderr 给一行 JSON
- [x] 端到端:`match` → `verify` 在真沙箱上全绿(本票用夹具脚本,真模型脚本归收口那张票)

## Answer

`match` 走真沙箱、`verify` 打通,退出码表落地。改动分几层:

- **组装层** `apps/cli/src/match/assemble.ts`(新):`assemble(inputPath, root)` 读物化输入 → 逐份校验 → 读 runtime bundle 与 wasm 字节(都当**安装根下的资源**,路径真源在 `@model-war/schema`:`SANDBOX_RUNTIME_ARTIFACT_PATH` / `QUICKJS_WASI_WASM_PATH`)→ 交出 `LoadedRun`;`executeMatch` 编译 wasm 一次、`createQuickJsRunner` 造四座位、`runMatch`、`finally` 里四 `dispose`。预算轨按 `RULESET_KEY_CATALOG[key].calibration.state` 解析(未定值即字段缺席),引擎不认识「未定值」。
- **`match`** `apps/cli/src/match/index.ts`:纯函数式入口(读 input → 写 `replay.jsonl`),不做 spawn;假哈希来源 `stubSandboxRuntimeHash` 删除,`measureSandboxRuntimeHash()` 返回入库产物常量(真源 `SANDBOX_RUNTIME_HASH`)。桩路径退出公开面。
- **`verify`** `apps/cli/src/verify/index.ts`(新)+ `commands.ts` 改 `provider:@model-war/cli` / `handler:runVerifyCommand` / `load:()=>import("./verify/index.js")`:按 `dirname(replay)/input.json` 复用同一套 `assemble` + `executeMatch` 重新执行,核 `runner` / `quickjsWasiVersion` / `sandboxRuntimeHash` / 三件套(不一致即拒,不静默换),逐 tick 既核「每行 `stateHash` == 自己载荷的摘要」也核「与本次重算逐项相同」,再比末行 `result`;不起子进程;0/1(引擎崩溃才 2)。engine 导出面仍恰好 `runMatch`(`Object.keys(engine)` 那条断言绿)。
- **退出码表** `apps/cli/src/exit-codes.ts`(新):`0` 正常 / `1` 用法或校验错 / `2` 引擎崩溃 / `3` 不确定超时 / `4` 内部错,`reportFailure` 在 stderr 末行给一行 JSON;表写进 `docs/hld.md` §9。`match` 的 `EXIT_LOAD_REJECTED` 2→1、`EXIT_ENGINE_FAULT` 1→2;`packages/replay/src/render.ts` 的 `refuse` 2→1。
- **参数解析** `apps/cli/src/args.ts`(新):`splitArgs` 摘 `--root <值>` 时就地跳过它的值,于是 `--root` 写在位置参数前面也解析对。

**WASI 时区栏 `wasiTimezoneOffset`**(D2):与已有 `timezoneOffset`(装载时区)是两栏。四处同步——`ReplayMetaLine` 类型、`META_REQUIRED_KEYS`(12→13)、`REPLAY_META_LINE_JSON_SCHEMA` 的 properties 与 `if/then` 两支;回放包经 `ReplayMetaLine` 再导出;`apps/cli/src/validator.ts` 新增 `validateReplayMetaLine`(第一条 meta 行的 ajv 编译点)。填充法定死:钟十进制毫秒、随机十六进制不带前缀(`WASI_RANDOM_FILL`,由单字节值推出)、时区十进制分钟(`WASI_TIMEZONE_OFFSET_MINUTES`)。桩下全 `null`。

**顺带修一处潜在形状 bug**:`REPLAY_META_LINE_JSON_SCHEMA.properties.sandboxRuntimeHash` 原为 `type:"string"`,而 `if/then` 的 stub 支又要求 `type:"null"`——两者取交,stub meta 的 `sandboxRuntimeHash:null` 会被 ajv 拒。本票把顶层放宽成 `["string","null"]`,真沙箱那一支仍由 `then` 收紧到 `SHA256`。这是 `verify` 的 meta 行校验第一次把这条 bug 逼出来的。

**引擎侧**:`packages/engine/src/runner/quickjs.ts` 新增 `random_get` 覆盖(固定字节填充)与 `WASI_RANDOM_FILL` 常量;`packages/engine/package.json` 加 `quickjs-wasi` 运行时依赖与 `./runner` 子路径导出(给组装层取工厂与三件套常量),engine 仍只允许 `node:crypto`、不读盘(`dependency-boundary.test.ts` 绿)。

**测试**:`apps/cli/src/cli.test.ts` 的 match 用例改走真沙箱(物化 wasm 与 bundle 进临时 root);新增 verify 组(逐 tick 一致退 0、缺参/读不到退 1、改 tick hash 退 1、改末行 result 退 1、meta runtime hash 不符退 1、meta 执行方式 stub≠quickjs 退 1);装载期拒跑 tamper 加一条 `sandboxHash`(存档 meta 记的 runtime hash 与入库产物不符)。

跑过的:`pnpm run check:quick`、`pnpm run typecheck`、`pnpm run check:deps`、`pnpm run check:runtime`、`pnpm run check:drift`、`pnpm exec vitest run --project unit apps/cli packages/engine packages/replay packages/schema`(39 文件 / 403 用例全绿)。`check:drift` 无漂移,故无需重跑 `pnpm run generate`。

遗留:观测文件 `observations.jsonl` 的落盘与墙钟/内存两类观测的转发归票 09(`executeMatch` 已把观测 sink 接好,只是还没写盘);真模型脚本的端到端归收口那张票。
