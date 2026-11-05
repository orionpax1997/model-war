// 分片:packages/engine —— 结算管线 + 纯函数子系统。
//
// 这是唯一一个已经验证过「分数说得清」的包:包内测试用相对路径 import 被变异文件,
// Vite 解析到 TS 源码,变异可见。
//
// 排除项与理由:
//   - `fixtures/**`(865 行)是测试自己 import 的构造器,不是生产代码。
//   - `dependency-boundary.test.ts` spawn `depcruise` 巡航全仓 dist 图;
//     沙箱里 dist 是原始构建,它既看不见变异也会因为 `packages/gen/dist` 探针与自身并行互踩
//     (见 packages/gen/src/dependency-boundary.test.ts 头注),不进 dry-run 集。
//   - `runner/quickjs.test.ts`、`sandbox-runtime/**` 保留:它们是真跑 QuickJS,
//     慢但覆盖 `sandbox-runtime` 的变异,属于本分片最有价值的信号来源之一。
//
// 已知的分数盲区:`runner/**` 与 `sandbox-runtime` 内部若要读跨包 dist,那部分变异依然看不见(见 base.mjs 头注)。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "engine",
  mutate: [
    "packages/engine/src/**/*.ts",
    "!packages/engine/src/**/*.test.ts",
    "!packages/engine/src/**/*.d.ts",
    "!packages/engine/src/fixtures/**",
  ],
  // 白名单枚举,不用 `!` 取反:`testFiles` 每个 pattern 独立过 FileMatcher
  // (ProjectReader.resolveTestFiles),不认 `!` 前缀;取反只有 `mutate` 支持。
  //
  // 三条排除,全部是「插桩改变了被测对象本身」而非测试不够:
  //   1. `dependency-boundary.test.ts` — spawn `depcruise` 巡航全仓 dist 图,与 gen 那份并行互踩。
  //   2. `sandbox-runtime/artifact.test.ts` — 钉的是入库产物的 sha256 常量。
  //      `disableTypeChecks` 给沙箱里每个文件插 `@ts-nocheck`,沙箱的 `tsc -b` 因此产出不同字节,
  //      哈希必然不同。牺牲的是同文件里那一条「真 VM 载入入库产物」的断言。
  //   3. `runner/quickjs.test.ts` — 其中「真实宿主栈溢出…仅计一次异常」断言异常记录条数,
  //      而插桩多出的栈帧改变了 QuickJS 撞栈的时机。牺牲可接受:`runner/quickjs.ts`
  //      另有 budget-mismatch / action-effects / sandbox / api-surface / artifact 五个测试文件覆盖。
  //
  // 两条「guest 全局名集合必须纯净」的测试(`api-surface.test.ts` + quickjs 里的探针脚本)
  // 会看到 `__stryker__` 泄漏,已在两处显式白名单掉这一个 harness 名字,剩下的判据不变。
  testFiles: [
    "packages/engine/src/action-effects.test.ts",
    "packages/engine/src/budget-mismatch.test.ts",
    "packages/engine/src/determinism.test.ts",
    "packages/engine/src/driver/random.test.ts",
    "packages/engine/src/fixtures/fixtures.test.ts",
    "packages/engine/src/index.test.ts",
    "packages/engine/src/observation-channel.test.ts",
    "packages/engine/src/pathfinding/find-path.test.ts",
    "packages/engine/src/processor/capture.test.ts",
    "packages/engine/src/processor/combat.test.ts",
    "packages/engine/src/processor/economy.test.ts",
    "packages/engine/src/processor/intents.test.ts",
    "packages/engine/src/processor/intent-verdicts.test.ts",
    "packages/engine/src/processor/movement.test.ts",
    "packages/engine/src/processor/observations.test.ts",
    "packages/engine/src/processor/outcome.test.ts",
    "packages/engine/src/processor/production.test.ts",
    "packages/engine/src/processor/state-invariants.test.ts",
    "packages/engine/src/processor/step-order.test.ts",
    "packages/engine/src/processor/steps/step5-exception-event.test.ts",
    "packages/engine/src/replay-line.test.ts",
    "packages/engine/src/replay-writer/meta-line.test.ts",
    "packages/engine/src/replay-writer/tick-line.test.ts",
    "packages/engine/src/run-match.test.ts",
    "packages/engine/src/runner/probe-harness.test.ts",
    "packages/engine/src/runner/stub.test.ts",
    "packages/engine/src/sandbox-runtime/api-surface.test.ts",
    "packages/engine/src/sandbox.test.ts",
    "packages/engine/src/snapshot/read-only-isolation.test.ts",
    "packages/engine/src/snapshot/traversal-independence.test.ts",
    "packages/engine/src/world/initial-state.test.ts",
  ],
});
