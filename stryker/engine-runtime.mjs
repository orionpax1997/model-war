// 分片:packages/engine —— QuickJS 沙箱执行与整局编排(慢测试集)。
//
// 与 `engine-core` 互补:本片拿的是 `packages/engine/src` 里被排除在 core 之外的全部生产代码
// (index / budget / run-match / observation-channel / sandbox-runtime / runner / 其余顶层模块)。
// 用取反表达互补关系,避免两份配置的 scope 漂移出一个缝。
//
// 本片的测试集是那几个慢的:它们是这些模块的唯一覆盖源,躲不掉。
// 实测单文件耗时(本机):sandbox.test 65.0s、api-surface 15.1s、fixtures 12.5s、
// determinism 10.4s、budget-mismatch 9.3s、probe-harness 7.0s、run-match 3.3s、
// observation-channel 1.4s。合起来干跑约 2 分钟。
//
// 排除 `runner/quickjs.test.ts` 与 `sandbox-runtime/artifact.test.ts`,理由见 stryker/engine.mjs:
// 前者的「宿主栈溢出仅计一次异常」与后者的产物 sha256 常量都会被插桩本身改变。
// 排除 `dependency-boundary.test.ts`:它 spawn depcruise 巡航全仓 dist 图。
//
// ── 实测发现:sandbox-runtime 这个目录永远跑不出分数 ──────────────────
// 本片跑下来 803 个变异体里,`sandbox-runtime/` 的 241 个**全部是 NoCoverage**。
// 不是配置错:`sandbox-runtime/index.ts` 是被测试用 esbuild 现打成 IIFE 字符串再丢进 QuickJS 跑的
// (见 api-surface.test.ts 的 buildRuntimeCode),它从不进 ES 模块图,
// 所以 vitest 的 per-test 覆盖拿不到属主 → Stryker 不会为它启动任何一次变异体重跑。
// 也就是说它的行为确实被覆盖了,但覆盖归因不了。
// 想让它可变异,只能改成真 import(会改变被测对象);保持现状就得接受
// `run: pnpm run mutate:engine:runtime` 报的那个 43% 里有一部分是结构性零元。
// 去掉这 241 个之后,本片的覆盖内分是 73.6%。
//
// 同理 `runner` 那 91 个 NoCoverage 是真实的弱覆盖(不是归因问题),值得补测试。
//
// ── 但本片的分数有一个更严重的污染:超时 ────────────────────────────
// 实测 803 个变异体里 **181 个是 Timeout,Killed 只有 164 个**——超时比真杀还多。
// Stryker 把 Timeout 计入「已检测」,所以 43.0% 里超过一半是「跑不动」而不是「测试拓住了」。
// 不计超时的话真杀率是 164/803 = 20.4%。分布也印证了这一点:
//   runner/array-search-shim.ts  58/58 = 100%(已从 mutate 范围剔除)
//   runner/index.ts               2/2  = 100%
//   runner/quickjs.ts           107/270 = 40%
// `array-search-shim.ts` 是一段被 `vm.evalCode` 丢进 QuickJS 的 JS 源字符串,
// 它的 58 个变异体全是字符串里的字面量——任何一处改坏都让 guest 挂死,
// 于是全部记成 Timeout。那一片学到的是「VM 会挂」而不是「测试好不好」。
// `quickjs.ts` 的 40% 同理(打断机制一改,guest 永不让出)。这是真实的行为差异,
// 但它不是测试质量的信号，也不能与其它分片的分数相提并论。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "engine-runtime",
  mutate: [
    "packages/engine/src/**/*.ts",
    "!packages/engine/src/**/*.test.ts",
    "!packages/engine/src/**/*.d.ts",
    "!packages/engine/src/fixtures/**",
    // ── 以下与 engine-core 互补,两边不要同时改 ──
    "!packages/engine/src/processor/**",
    "!packages/engine/src/world/**",
    "!packages/engine/src/pathfinding/**",
    "!packages/engine/src/replay-writer/**",
    "!packages/engine/src/snapshot/**",
    "!packages/engine/src/driver/**",
    "!packages/engine/src/ruleset-loader/**",
    "!packages/engine/src/action-effects.ts",
    "!packages/engine/src/replay-line.ts",
    // 58 个变异体 100% 超时,零信息量(理由见下文):不当它是测量结果。
    "!packages/engine/src/runner/array-search-shim.ts",
  ],
  testFiles: [
    "packages/engine/src/sandbox.test.ts",
    "packages/engine/src/determinism.test.ts",
    "packages/engine/src/budget-mismatch.test.ts",
    "packages/engine/src/fixtures/fixtures.test.ts",
    "packages/engine/src/run-match.test.ts",
    "packages/engine/src/observation-channel.test.ts",
    "packages/engine/src/runner/probe-harness.test.ts",
    "packages/engine/src/runner/stub.test.ts",
    "packages/engine/src/sandbox-runtime/api-surface.test.ts",
  ],
});
