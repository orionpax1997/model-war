// 分片:packages/engine —— 纯结算子系统(快测试集)。
//
// 为什么切这一刀:分片的每变异体成本由 `testFiles` 宽度决定,不由 `mutate` 范围决定。
// 同一个文件、同 73 个变异体:`testFiles` 取 11 个 processor 测试是 233ms/个,
// 取 31 个 engine 测试是 9.9s/个——42 倍。原因是 `related` 过滤会把那几个慢沙箱测试
// (`sandbox.test.ts` 65s、`api-surface` 15s、`fixtures` 12.5s、`determinism` 10.4s)
// 判成「与几乎每个 engine 模块相关」,于是每一次变异体重跑都被拖成几十秒。
//
// 本片只圈纯函数子系统,测试集全部在 0.3s 以下(实测见下),拿掉的就是那几个慢测试。
// 覆盖不到的那一半在 `stryker/engine-runtime.mjs`。
//
// 实测单文件耗时(本机,`vitest --project unit`):
//   processor/* 全部 <0.3s、world 0.03s、pathfinding 0.02s、replay-writer 0.02-0.05s、
//   snapshot 0.01-0.02s、driver 0.04s、action-effects 0.27s、replay-line 0.01s。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "engine-core",
  mutate: [
    "packages/engine/src/processor/**/*.ts",
    "packages/engine/src/world/**/*.ts",
    "packages/engine/src/pathfinding/**/*.ts",
    "packages/engine/src/replay-writer/**/*.ts",
    "packages/engine/src/snapshot/**/*.ts",
    "packages/engine/src/driver/**/*.ts",
    "packages/engine/src/ruleset-loader/**/*.ts",
    "packages/engine/src/action-effects.ts",
    "packages/engine/src/replay-line.ts",
    "!**/*.test.ts",
    "!**/*.d.ts",
  ],
  // 白名单枚举(理由见 stryker/engine.mjs:testFiles 不认 `!`)。
  testFiles: [
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
    "packages/engine/src/world/initial-state.test.ts",
    "packages/engine/src/pathfinding/find-path.test.ts",
    "packages/engine/src/replay-writer/meta-line.test.ts",
    "packages/engine/src/replay-writer/tick-line.test.ts",
    "packages/engine/src/snapshot/read-only-isolation.test.ts",
    "packages/engine/src/snapshot/traversal-independence.test.ts",
    "packages/engine/src/driver/random.test.ts",
    "packages/engine/src/action-effects.test.ts",
    "packages/engine/src/replay-line.test.ts",
    "packages/engine/src/index.test.ts",
  ],
});
