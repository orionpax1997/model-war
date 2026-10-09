// StrykerJS 变异测试配置 —— 观测项,只落盘,不设红线。
//
// 归属:hld §2.2.7 门禁表的「按需 → 夜间」层;ADR-0010(ADR-0002「不装 Stryker」条款已 supersede)。
// 从仓库根跑(`pnpm run mutate`):Stryker 只在 cwd 找配置,mutate 的 glob 与插件解析也都相对 cwd。
//
// @ts-check
/** @type {import('@stryker-mutator/core/schema/stryker-schema').PartialStrykerOptions} */
const config = {
  // pnpm 的非扁平 node_modules 会让 Stryker 自动探测插件失败,必须显式列(官方 troubleshooting)。
  // 插件版本与 core 精确锁成同一个版本:vitest-runner 对 core 是 exact peer。
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],

  // 范围铁律:只跑 engine 结算管线。范围扩大的那天另开 ADR(spec §7)。
  // 相对 cwd 的 glob;同目录同层级的测试文件不进变异范围——只变异结算代码本身。
  mutate: [
    "packages/engine/src/processor/**/*.ts",
    "!packages/engine/src/processor/**/*.test.ts",
  ],

  testRunner: "vitest",

  // dry-run 只跑这批测试——它们是本次 mutate 范围(engine 结算管线)的专属测试。
  // 不限定的话,dry-run 会把 vitest 全部 project(含会 spawn `check` 的 gates.test)拉进来,
  // 既慢又会把「与结算管线无关的测试在沙箱里的行为」当成 dry-run 的成败判据。
  testFiles: ["packages/engine/src/processor/**/*.test.ts"],
  vitest: {
    // 不指定时 vitest-runner 会向上找;显式写出来是因为它必须与根配置同一份。
    configFile: "vitest.config.ts",
    dir: ".",
    // processor 测试直接 import 被变异文件,所以 related 过滤是对的(默认 true);
    // 关掉会让每个 mutant 跑全量 unit,耗时涨一个量级。
    related: true,
  },

  // 产物只落盘。两条 reporter 的默认路径不一致(html 默认在仓库根,json 默认在 reports/mutation/ 下),
  // 所以两个都显式写死,免得上层 CI 的 artifact 路径抄错一个。
  reporters: ["clear-text", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },

  // 不设阈值:`break: null` 决定退出码(恒 0),high/low 只影响 reporter 配色。
  // 三个值一起给是为了让「这条门禁不设红线」在配置里可 grep、可 review(ADR-0010)。
  thresholds: { high: 0, low: 0, break: null },

  // 夜间 runner 是共享的,留一半核给同机的其它 job。
  concurrency: "50%",

  // TS 变异体类型不过关时不判「存活/等价」,直接当被杀掉——省掉一类假信号。
  disableTypeChecks: true,

  // 不把用不上的东西复制进沙箱(node_modules/.git/*.tsbuildinfo 是 Stryker 内置忽略项)。
  ignorePatterns: [".git", ".scratch", "archive", "docs", "**/*.md"],

  // ── 与 TypeScript 7 的接口错位,及其绕法 ──────────────────────────────
  // Stryker 10.0.0 的 `TSConfigPreprocessor` 调 `ts.parseConfigFileTextToJson` /
  // `ts.resolveProjectReferencePath`,这两个入口在 TypeScript 7 里已被删除,于是沙箱起手就
  // `TypeError: ts.parseConfigFileTextToJson is not a function`。该预处理器做的是把逃出沙箱的
  // `extends` / `references` 路径改写成沙箱内相对路径;本仓库沙箱根 = 仓库根,根 tsconfig 的
  // references(`./packages/*`)全在仓内,无需这步重写。把 `tsconfigFile` 指到一个不会被复制进沙箱的
  // 文件名,预处理器按 `project.files.get(该路径)` 判存在性,拿不到就整段跳过;沙箱里那份真
  // `tsconfig.json` 照常给 `tsc -b` 用。上游修好这个 TS7 错位后删掉这一行。
  tsconfigFile: "__stryker_skip_tsconfig_rewrite__.json",

  // 夜间每晚全量跑,基线才可比;本地想只跑改动部分时用 `--incremental --force`。
  incremental: false,
};

export default config;
