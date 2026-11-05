// StrykerJS 变异测试：全仓分片配置的共享底座。
//
// 归属:hld §2.2.7 门禁表的「按需 → 夜间」层;ADR-0010(ADR-0002「不装 Stryker」条款已 supersede)。
// 从仓库根跑(`pnpm run mutate:<package>`):Stryker 只在 cwd 找配置,mutate 的 glob 与插件解析
// 也都相对 cwd。分片配置文件在 `stryker/*.mjs`,一个文件 = 一次 `stryker run`。
//
// 为什么分片而不是一份 config 堆满 glob:
//   1. Stryker 一次进程只有一份 `mutate` scope 与一份 `testFiles`;
//   2. `testFiles` 是 dry-run 的测试集,必须按「能看见这批变异体」的最小闭包封闭起来——
//      否则 `related` 会把 `gates.test.ts` 捞进沙箱,而它内部 spawn `pnpm run check`,
//      会再起一整棵进程树(叉炸弹)。
//
// 分片不改变一个结构性事实:**跨包 import 在沙箱里指向仓库外**。
//   证据:`packages/engine/node_modules/@model-war/replay -> ../../../replay`(pnpm 相对软链),
//   而 Stryker 的 `symlinkNodeModules` 把每个 `node_modules` junction 到原仓库绝对路径
//   → 相对软链按原仓库解析 → 落在沙箱外;再经 `exports.default = ./dist/index.js` 读到
//   **未被变异的构建产物**。
//   所以每个分片的分数含义被钉死成「本包自身、用相对路径 import 的测试」测出来的分数。
//   跨包覆盖会静默记成 Survived / NoCoverage —— 这是系统性低估,不能横向比较,
//   也不能当成「测试不足」的证据。要看跨包覆盖,得先给 vitest 加 resolve.alias
//   把 `@model-war/*` 指到 `packages/*/src/index.ts`(packages/tools 已是源码形态,
//   exports 直指 ./src/index.ts),那是另一件事,另开 ADR。
//
// ── 实测基线(2026-11-04,本机 8 核)────────────────────────────────
//| 分片 | 变异体 | 干跑 | 实测总时长 | 每变异体 |
//| replay | 338 | 8.5s | 38s | 87ms |
//| schema | 231 | 9s | 117s | 467ms |
//| tools | 2072 | 13s | 241s | 110ms |
//| runner | 5433 | 18s | 1660s = 27.7min | 302ms |
//| engine-core | 1782 | 16s | 430s = 7.2min | 232ms |
//| engine-runtime | 803 | 100s | 3245s = 54.1min † | 3.9s † |
//| gen-core | 2811 | 15s | 379s = 6.3min | 130ms |
//| gen-io | 1150 | 24s | 616s = 10.3min † | 515ms † |
//| gen-pipeline | 530 | 111s | 1467s = 24.4min † | 2.6s † |
//† 这三条是 `--concurrency 100%` 跑的(一次性提速,不是配置默认值 50%)。
//  其余分片都在 50%,所以每变异体一列不可跨 † 行直接比,×~2 才是同口径。
//
// 全仓合计:15150 个变异体、原始分 62.7%、覆盖内分 72.9%
//(不含 apps/cli,理由见下)。在 50% concurrency 下墙钟约 3 小时。
//
// **这两个合计数不要引用。** 它们把语义不相容的分片平均到一起:
// schema 的 231 个是名单/标签字符串(结构性噪声)、tools 有 886 个 NoCoverage(43%)、
// engine-runtime 的 181 个 Timeout 比它的真杀(164)还多。分片之间只能比趋势,不能比分数。
//
// **跨包覆盖结构性看不见(已实测确认,不再只是推理)。**
// 做过的实验:mutate 只看 `packages/schema/src/script-surface.ts`,testFiles 只给
// `packages/engine/src/runner/stub.test.ts`(它断言 `HOST_BRIDGE_PREFIX` 为 `"__"`),并关掉 `related`。
// 结果:97 个变异体**全部 NoCoverage**,零个被执行。
// 因为 stub.test.ts 经 `@model-war/replay` 取值 → pnpm 相对软链在 node_modules junction 后
// 解读到原仓库的 `packages/replay/dist`,不在沙箱里 → perTest 覆盖拿不到属主。
// 结论:每个分片的分数只含**本包自身相对 import 的测试**的贡献;
// 真正的消费者(engine / cli / runner 的跨界路径)一律丢了,而且是丢成 NoCoverage,
// 不是丢成 Survived——所以它不会伪装成「测试弱」,它会伪装成「没测」。
//
// **超时要单看。** Stryker 把 Timeout 计入「已检测」,但超时占比一旦高,分数就不再是测试质量。
// engine-runtime:181/803 超时 vs 164 真杀;array-search-shim.ts 58/58、runner/index.ts 2/2。
// 引用任何分片的分数时,先看该分片的 Timeout 列。
//
// 没做的事:变异体等价性判审(survived 里含无法杀死的等价变异体,所以「存活」高估了测试缺口)。
//
// **决定每变异体成本的不是 mutate 范围,是 testFiles 的宽度。**
// 同一个文件、同 73 个变异体:
//   testFiles = 11 个 processor 测试(engine-processor 分片)→ 233ms/个
//   testFiles = 31 个 engine 测试(engine 分片)→ 9.9s/个    (42 倍)
// 原因是 `related` 过滤:QuickJS / probe-harness 那几个慢测试 import 了几乎每个 engine 模块,
// 于是它们对所有变异体都算「相关」,把每一次变异体重跑拖成几十秒。
// 所以 engine / gen 各按「快测试集 / 慢测试集」切两片,效果是把全仓从外推的 ~17 小时压到 ~3 小时:
//   engine-core 干跑 223s→16s、1782 个变异体 7.2 分钟(原 engine 整包外推 7~9.5 小时)
//   gen-core    干跑 138s→15s、2811 个变异体 6.3 分钟(原 gen 整包外推 6.4~10.6 小时)
// 真正的钱只花在两处躲不掉的慢测试上:engine-runtime(65s 的 sandbox.test.ts)与
// gen-pipeline(112s 的 pipeline.test.ts)。
//
// @ts-check
/** @type {import('@stryker-mutator/core/schema/stryker-schema').PartialStrykerOptions} */
const shared = {
  // pnpm 的非扁平 node_modules 会让 Stryker 自动探测插件失败,必须显式列(官方 troubleshooting)。
  // 插件版本与 core 精确锁成同一个版本:vitest-runner 对 core 是 exact peer。
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],

  testRunner: "vitest",
  vitest: {
    // 不指定时 vitest-runner 会向上找;显式写出来是因为它必须与根配置同一份。
    configFile: "vitest.config.ts",
    dir: ".",
    // 测试直接 import 被变异文件时 related 过滤是对的(默认 true);
    // 关掉会让每个 mutant 跑全量测试,耗时涨一个量级。
    related: true,
  },

  // 不设阈值:`break: null` 决定退出码(恒 0),high/low 只影响 reporter 配色。
  // 三个值一起给是为了让「这条门禁不设红线」在配置里可 grep、可 review(ADR-0010)。
  thresholds: { high: 0, low: 0, break: null },

  // 夜间 runner 是共享的,留一半核给同机的其它 job。
  concurrency: "50%",

  // TS 变异体类型不过关时不判「存活/等价」,直接当被杀掉——省掉一类假信号。
  disableTypeChecks: true,

  // 沙箱复制规则里唯一必需的一条:`runs/` 是本机跑批产物(实测 6.8 GB / 46394 个文件),
  // 不在 Stryker 的 ALWAYS_IGNORE 里,复制一份到每个并发 worker 会让 dry-run 卡在 I/O 上。
  // `archive/` 是 21 MB 的历史快照,测试只把 `archive/...` 当字符串引用、不读盘,可安全排除。
  // NOT ignored 且必须保留:`dist/`(测试要它)、`rulesets/`、`maps/`、`benchmarks/`、`docs/`。
  ignorePatterns: ["runs", "archive", ".scratch"],

  // ── 与 TypeScript 7 的接口错位,及其绕法 ──────────────────────────────
  // Stryker 10.0.0 的 `TSConfigPreprocessor` 调 `ts.parseConfigFileTextToJson` /
  // `ts.resolveProjectReferencePath`,这两个入口在 TypeScript 7 里已被删除,于是沙箱起手就
  // `TypeError: ts.parseConfigFileTextToJson is not a function`。该预处理器做的是把逃出沙箱的
  // `extends` / `references` 路径改写成沙箱内相对路径;本仓库沙箱根 = 仓库根,根 tsconfig 的
  // references(`./packages/*`)全在仓内,无需这步重写。把 `tsconfigFile` 指到一个不会被复制进沙箱的
  // 文件名,预处理器按 `project.files.get(该路径)` 判存在性,拿不到就整段跳过;沙箱里那份真
  // `tsconfig.json` 照常给 `tsc -b` 用。上游修好这个 TS7 错位后删掉这一行。
  tsconfigFile: "__stryker_skip_tsconfig_rewrite__.json",

  // 夜间每晚全量跑,基线才可比;本地想只跑改动部分时用 `--incremental`。
  incremental: false,
};

/**
 * 造一个分片配置。
 *
 * @param {object} spec
 * @param {string} spec.name        分片名,同时决定报告路径 `reports/mutation/<name>.{html,json}`。
 * @param {string[]} spec.mutate   变异范围。只放生产代码,排除测试与被测试直接 import 的 fixture 构造器。
 * @param {string[]} spec.testFiles dry-run 的测试集。必须是「能看见这批变异体」的最小闭包。
 * @returns {import('@stryker-mutator/core/schema/stryker-schema').PartialStrykerOptions}
 */
export function fragment({ name, mutate, testFiles }) {
  return {
    ...shared,
    mutate,
    testFiles,
    // 每条 reporter 的默认路径不一致(html 默认在仓库根,json 默认在 reports/mutation/ 下),
    // 所以都显式写死,免得上层 CI 的 artifact 路径抄错一个;分片各写各的,互不覆盖。
    reporters: ["clear-text", "html", "json"],
    htmlReporter: { fileName: `reports/mutation/${name}.html` },
    jsonReporter: { fileName: `reports/mutation/${name}.json` },
    incrementalFile: `reports/mutation/${name}-incremental.json`,
  };
}
