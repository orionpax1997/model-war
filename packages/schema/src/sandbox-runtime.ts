/**
 * 沙箱 runtime bundle 的**工程常量**:产物路径、产物字节的 sha256、`quickjs-wasi` 版本。
 *
 * ── 为什么这三件住真源包 ──
 * 它们要被**两侧同时读到**:`apps/cli`(装载期比对存档 meta 的 `sandboxRuntimeHash`)与
 * `packages/tools`(漂移门禁比「现算 == 入库」)。本包是唯一两边都已能 import 的共享常量之家
 * (`tooling-build-probes.md` §2.4:能否 afford 构建是分界线,常量表这种低频事实放真源包)。
 * 引擎侧**不**从这里取:engine 的对外导出面必须仍恰好一个符号 `runMatch`(见 `index.test.ts`),
 * 本模块的名字经 `packages/schema/src/index.ts` 只对 CLI 与工具可见。
 *
 * ── 产物为什么必须入库、hash 为什么是常量而不是「现算」 ──
 * 回放 meta 里那一栏 `sandboxRuntimeHash` 是第三方凭存档复算的前提,复算的前提是
 * **版本库里那串确切字节**。所以产物是提交物,下面的常量是它的字节 sha256;门禁
 * (`packages/tools/src/sandbox-runtime/run-runtime-drift-gate.ts`)钉住
 * 「入库产物字节 == 本常量」与「现打一次 == 入库产物」。判据锚定确切字节,不随环境漂移。
 * 依据见 `docs/adr/0007-runtime-bundle-artifact-is-committed.md`。
 */

/** `quickjs-wasi` 的锁定版本。与根 `package.json` 的精确钉版同源,随升级一并改写。 */
export const QUICKJS_WASI_VERSION = "3.6.2";

/**
 * runtime bundle 产物**相对仓库根**的路径(供 CLI 与门禁读盘)。
 *
 * 落点刻意避开任何 `dist/`:`.gitignore` 里那条 `dist/` 是无锚点规则(命中任意层级),
 * 产物必须能被 git 跟踪(`version-control-boundary.test.ts` 双向钉住)。同名 `sandbox-runtime/`
 * 与源码同族但不同层——源码在 `src/`,产物在包根下。
 */
export const SANDBOX_RUNTIME_ARTIFACT_PATH = "packages/engine/sandbox-runtime/runtime.iife.js";

/**
 * runtime bundle 产物的字节 sha256。**本常量的书写真源是产物本身**:
 * 改产物后跑 `pnpm run runtime:build` 重算并手写回这里,门禁负责证明两者一致。
 */
export const SANDBOX_RUNTIME_HASH =
  "4f1cfcaa53d03ab20de5987d5d232ce7cdad02e8110d18beb9c810c143d73fc5";
