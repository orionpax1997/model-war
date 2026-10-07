# 04: runtime bundle 成形并入库

**What to build:** 沙箱内 API 面的实现以**单文件 IIFE 产物**进版本库;它的字节 hash 成为「沙箱运行时哈希」的**唯一真源**,并由一道漂移门禁守着。今天那个用 `sha256("stub-runner/" + 版本)` 拼出来的假哈希消失。

**为什么产物必须入库**:回放 meta 里那一栏哈希是第三方凭存档复算的前提。复算的前提是「版本库里那串确切字节」——不能在 CI 或构建缓存里随环境漂移。所以产物是**提交物**,门禁比的是「现算 == 入库」,不是「现算 == 现算」。

**为什么门禁单独一条**:现有的漂移门禁管的是「名单类数据 → 生成物」那张登记表,它的产出方式与「构建脚本产出」不同;把构建产物塞进那张表会让一个门禁同时管两种东西,判定三段也会分叉。

**为什么 IIFE 而不是其它形态**:脚本与运行时同处一个全局环境,内部计数器与宿主桥引用都在闭包内;带 `import` / `export` 的产物在**载入期**就是 `SyntaxError`——这条要在门禁里钉住。

决策依据:`.scratch/sandbox-executor/spec.md`《runtime bundle 与 hash》。

**Blocked by:** 03(真 VM 的执行器:生命周期、桥与三件套)

**Status:** resolved

- [x] 构建脚本能从沙箱运行时源码产出单文件 IIFE 产物,产物入库
- [x] 产物可被 VM 载入并完成一次初始化:API 面取得到、两个桥已从全局删掉
- [x] 产物里不含模块语法(静态 `import` / `export` / 动态 `import()`);载入期不是 `SyntaxError`
- [x] 沙箱运行时哈希改由「入库产物字节的 sha256」给出;假哈希的来源被删除;桩模式下该栏仍为 `null`
- [x] 独立漂移门禁:手改产物一个字节即红;**进全量检查链、不进快速链**(有一条用例证明它真的会红,不是空跑)
- [x] **新开一条 ADR**:入库产物 + 漂移门禁,依据是「第三方凭存档复算」与「判据锚定确切字节」
- [x] 产物 hash 与运行时版本一并可被后续票写进回放 meta(本票只保证它可读、可核对)

## Answer

产物回归 `packages/engine/sandbox-runtime/runtime.iife.js`(1210 字节,esbuild `format:iife` + `bundle`,桥名经 `define` 从真源包 `HOST_BRIDGE_PREFIX` 拼出注入;`absWorkingDir` 钉到仓库根,产物随 cwd 不再漂移)。

- 常量之家:`packages/schema/src/sandbox-runtime.ts` 导出 `SANDBOX_RUNTIME_HASH` / `SANDBOX_RUNTIME_ARTIFACT_PATH` / `QUICKJS_WASI_VERSION`,经 schema 与 replay 两处再导出(engine 只见 replay)。
- 构建面:`packages/tools/src/sandbox-runtime/build-runtime.ts`(根脚本 `runtime:build`);`esbuild` 已声明进 `packages/tools` 的 `dependencies` 并更新 lockfile。
- 门禁:`packages/tools/src/sandbox-runtime/run-runtime-drift-gate.ts`(根脚本 `check:runtime`),三段判定 = 现算==入库 / 入库 sha256==常量 / 不含模块语法;挂在 `check` 末尾、不进 `check:quick`,并登记进 `CONTENT_RECHECKS`;`gates.test.ts` 两条新用例(手改一字节即红→还原即绿;位置纪律)。
- 假哈希删除:`apps/cli/src/match/sandbox-runtime.ts` 的 `stubSandboxRuntimeHash` 删除,`measureSandboxRuntimeHash()` 返回常量(逐字节核对入口 `readSandboxRuntimeBytes` / `sandboxRuntimeHashOf` 留给门禁与测试);桩模式 meta 那一栏仍为 `null`。
- VM 载入验收:`packages/engine/src/sandbox-runtime/artifact.test.ts` 用真 VM 载入库产物,探针把「API 面在不在 + 桥删没删 + 快照读得到吗」编码成一条意图。
- ADR:`docs/adr/0007-runtime-bundle-artifact-is-committed.md`。

验证:`check:quick`、`vitest --project unit packages/engine apps/cli`(347 绿)、`test:gates`(32 绿)、`check:runtime`、`check:drift`、`check:declared-deps`、`lint:types`、`check:deps` 全绿。

遗留:写进回放 meta(组装层)归后续票;`measureSandboxRuntimeHash()` 返回常量、其与产物的字节一致由门禁担保。
