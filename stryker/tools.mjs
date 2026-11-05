// 分片:packages/tools —— 只圈「有单元测试能看见」的那部分。
//
// 这个包 9300 行里,大部分是**一次性门禁脚本**(selfproof 1470、limits 540、cross-process 369、
// budget-recheck 126、benchmarks 525、sandbox-probes 720、sandbox-runtime 198),
// 它们的唯一消费者是 `gates.test.ts` / `gates-slow.test.ts` —— 靠 spawn 子进程观察行为。
// 那类测试不能进 dry-run 集(后者的「check 退出 0」会 spawn 全量 `check`,check 里又有 vitest,
// 是叉炸弹),所以那批脚本变异后必然 100% NoCoverage。**把它们排进 mutate 只会浪费一次夜间预算。**
// 同理 `generate/**`(1328 行)只被漂移门禁 `check:drift` 覆盖,没有单元测试,也排除;
// `generated/**` 是生成物,不动。
//
// 能看见的部分:rules / validate / gate + 几个顶层纯模块。
// `packages/tools` 的 `exports` 直指 `./src/index.ts`(hld §3.2 的源码形态执行),
// 所以 tools 自己的测试读的就是源码,是本仓库里除 engine 之外第二个变异完全可见的包。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "tools",
  mutate: [
    "packages/tools/src/rules/**/*.ts",
    "packages/tools/src/validate/**/*.ts",
    "packages/tools/src/gate/**/*.ts",
    "packages/tools/src/parse-source.ts",
    "packages/tools/src/rules-doc-prose.ts",
    "packages/tools/src/script-surface.ts",
    "packages/tools/src/toolchain-coupling.ts",
    "packages/tools/src/allowlist.ts",
    "packages/tools/src/ast.ts",
    "packages/tools/src/ci-workflows.ts",
    "!**/*.test.ts",
    // 一次性门禁入口不进 mutate(与头注同一条理由):它们的唯一消费者是 spawn 子进程的门禁自测,
    // 那类测试进不了 dry-run 集,于是这些文件必然 100% NoCoverage —— 白占夜间预算,还把入库基线压偏。
    // 用 glob 而不是逐个点名:新加一条 `run-*-gate.ts` 不该需要同时改这里。本批新增的
    // `rules/run-prose-gate.ts` / `gate/run-landing-gate.ts` 原先就是这么被收进范围的。
    // 已知代价:`gate/run-quickjs-coupling-gate.ts` 导出的纯函数 `findQuickjsMisalignments`
    // 有单测(见 `gate/quickjs-coupling.test.ts`),这条 glob 把它连带拿走。
    "!packages/tools/src/**/run-*-gate.ts",
    "!**/*.d.ts",
  ],
  // 刻意不包含:gates / gates-slow / api-example-compile / script-compile-config /
  // script-api-type-surface / version-control-boundary / validate/run-validate-script /
  // validate/module-system-in-chain — 六条 spawn 子进程,两条跑全量 check。
  testFiles: [
    "packages/tools/src/rules/**/*.test.ts",
    "packages/tools/src/rules/**/*.prop.ts",
    "packages/tools/src/validate/pipeline.test.ts",
    "packages/tools/src/validate/render-violations.test.ts",
    "packages/tools/src/gate/**/*.test.ts",
    "packages/tools/src/parse-source.test.ts",
    "packages/tools/src/rules-doc-prose.test.ts",
    "packages/tools/src/script-surface.test.ts",
    "packages/tools/src/ci.test.ts",
  ],
});
