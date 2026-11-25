/**
 * **改动 → 该跑什么**。`check` 的表那一半(另两半是依赖图与观测 map)。
 *
 * ── 两个半边,分工明确 ──
 *
 * **代码改动交给依赖图。** 源码文件先经 `build-outputs.ts` 展开成产物路径(跨包边指向
 * `dist/`,而 `git diff` 给的是 `src/`),再连同源码一起交给 `vitest related`。选哪些测试
 * 不是这里算的,是图算的——它能看见 `import`、能看见跨包解析,人工表看不见这些。
 *
 * **图看不见的交给表。** 两类:数据文件(`rulesets/`、`maps/`、`prompts/`)与仓库事实
 * (`package.json`、锁文件、`vitest.config.ts`)。它们被读、被解析,不被 import,所以图对它们
 * 一无所知,只能由表说「改这里要跑哪几族」。第三条是 `packages/tools`:门禁自测住在独立
 * project 里(`gates`),不在 `all` 的池子里,图选不到它。
 *
 * `packages/tools` 那一条**不再按目录一律触发**。整个目录一次扫进门禁自测(89 条 / 166s)是
 * 拿时间换省心,而其中绝大多数改动跟门禁自测无关:选择器自身的判据住在 `unit` 池子里(图能
 * 选中它),`vitest/` 那批接线的判据也在 `unit` 里。于是这一层拆三档——`src/scope`(一条都不
 * 补,交图)、`src/vitest`(`test`)、其余(`test:gates`,但具体到文件时再用 `-t` 缩到那一批
 * 用例,映射见 `GATES_CASES`)。**边界在文件上,不在目录上**:目录是人的组织方式。
 *
 * 表**只在这个范围内是判据**。给 `apps/cli`、`packages/engine` 这类代码目录写规则是多余且
 * 有害的——图的结论永远比人写的更准,两份并存时人写的那份只会腐烂(ADR-0038 的落选条目)。
 *
 * ── 三条不能让步的性质 ──
 *
 * 1. **说不清就不许跑少。** 既映射不到产物、也没有表规则的路径 → 红。
 * 2. **产物不存在同样要红。** 源码改了但 `dist/` 没跟上(没跑过 `tsc -b`),静态映射就失效,
 *    此时退回全量而不是照旧少选——那正是"静默少选"的形状。
 * 3. **顺序稳定。** `ALWAYS` 先跑(便宜、失败快),其余按 `SUITES` 的固定顺序,于是同样的
 *    改动每次得到同样的序列,日志可比。
 */

import { buildOutputsOf, isSourceFile, sourceOf, type Workspace } from "./build-outputs.ts";

/** 任何改动都要跑的两步:格式化/静态检查(输入在编辑面上)、入库事实漂移(1s 级)。 */
export const ALWAYS: readonly string[] = ["quick", "gate:static"];

/** 全部测试族。除 `quick` / `gate:static` 之外的每个测试入口都要在这里登记一次。 */
export const SUITES: readonly string[] = [
  "test",
  "test:vm",
  "test:e2e",
  "test:gates",
  "test:slow",
  "test:all",
  // 真 bwrap 那一族(`sandbox` project)。它**不在**常跑链上,也不在 `all` 的池子里——但它是
  // 一条真实存在的验证族:改它自己的用例文件时,只有它能证明「改完还跑得起来」。
  "test:kernel",
];

export interface Radius {
  /** 相对仓库根的路径前缀;`p === area || p.startsWith(area + "/")` 命中。 */
  readonly area: string;
  /** 除 `ALWAYS` 之外还要跑的命名脚本(必须是 `package.json` 里真实存在的名字)。 */
  readonly suites: readonly string[];
  /**
   * 这条规则下的改动**必须**被观测到(有测试读过它),否则红。
   *
   * 只给"行为输入"开:参数取值、地图、runtime 字节、guest 契约。散文与仓库事实不开——它们由
   * 静态门禁读,`RADIUS` 里 `suites: []` 的声明本身就是覆盖。
   */
  readonly mustObserve?: boolean;
  /** 为什么是这几条,或者为什么一条都不需要。 */
  readonly why: string;
  /**
   * 这条规则是**兜底**:它收的是"表里没有专门规则的工具包文件"。
   *
   * 兜底不对**测试文件本身**负责——测试文件的判据就是它自己,依赖图把它选得出来;例外是
   * `GRAPH_BLIND_TESTS`(图看不见的那几个,仍由兜底补)。没有这条豁免,改一行 `ci.test.ts`
   * (选择器自己的 CI 判据)就要重跑 89 条 / 166s 的门禁自测。
   */
  readonly fallback?: boolean;
}

export const RADIUS: readonly Radius[] = [
  {
    area: "rulesets",
    mustObserve: true,
    suites: ["test:vm"],
    why: "参数取值改一条就是换了一套规则,整场行为与结算都要在真 VM 上重算",
  },
  {
    area: "maps",
    mustObserve: true,
    suites: ["test:vm"],
    why: "地图是引擎的输入,地形判据与整场行为都在 VM 侧",
  },
  {
    area: "packages/tools/src/scope",
    suites: [],
    why: "选择器自身的判据(`test-layers` / `plan` / `change-set` / 探针)住在 `unit` 池子里,依赖图能选中它;门禁自测与它无关,补上是白付 166s",
  },
  {
    area: "packages/tools/src/vitest",
    suites: ["test"],
    why: "vitest 侧接线(报告汇总、内核探针)的判据是同目录的 `.test.ts`,在 `unit` 池子里——这一档只补 `test`,不牵扯门禁自测",
  },
  {
    area: "packages/tools/src/gates-slow.test.ts",
    suites: ["test:slow"],
    why: "它属于 `slow` project(nightly 的那一半),兜底会把改它的人送去 `test:gates`:既多跑了不该跑的族,又**没跑它自己**——跑错族比多跑更贵",
  },
  {
    area: "apps/cli/src/agent-real-session.test.ts",
    suites: ["test:kernel"],
    why: "它在 `sandbox` project 里(真 bwrap、非特权 user namespace),`all` 的池子不收它——依赖图对「自己就是测试文件」的改动于是答不出候选,只能由表指名它自己那一族",
  },
  {
    area: "apps/cli/src/gen-cli.test.ts",
    suites: ["test:kernel"],
    why: "同上:这条 CLI 冒烟要真 bwrap + 真网格,归 `sandbox`、被 `all` 排除;不指名这一族,改它就只剩一条债可走",
  },
  {
    area: "packages/tools",
    suites: ["test:gates"],
    fallback: true,
    why: "门禁自测住在独立的 `gates` project 里,不在 `all` 的池子里——图选不到它,只能由表补;命中具体门禁文件时由 `GATES_CASES` 缩成 `-t` 子集;测试文件本身另有豁免(见 `GRAPH_BLIND_TESTS`)",
  },
  {
    area: "benchmarks",
    suites: ["test:vm", "test:e2e"],
    why: "基准脚本同时被 VM 组当执行体、被 e2e 组当 CLI 夹具",
  },
  {
    area: "packages/runner/src/fixtures",
    suites: ["test"],
    why: "单测的夹具(黄金档等),被读成文本而不是 import——图对它没有边",
  },
  {
    area: "apps/cli/src/fixtures",
    suites: ["test:e2e"],
    why: "陪练档 fixture(四份 `script.js` 的逐字节副本):由子进程经 `--root` 读成字节,不是 import——图对它没有边;读它的两条 `--plan` / `--expected-plan` 用例在 e2e 族(`gen-cli` 冒烟也读它,但那是 `sandbox` project,按仓库纪律不由选择器拉进来)",
  },
  {
    area: "packages/engine/src/fixtures/guest",
    mustObserve: true,
    suites: ["test:vm"],
    why: "guest 侧夹具脚本:被 `readFileSync` 读成文本塞进 VM,不是 import——图对它没有边;读它的两条用例(`sandbox` / `quickjs`)都在 vm 族。模块加载期读盘(票 T6 修好了归属)才让它被观测到,而没规则的输入会让选择器抛错",
  },
  {
    area: "packages/schema/script-api",
    mustObserve: true,
    suites: ["test:vm"],
    why: "入库的 guest 侧声明:被读进 wasm VM 当契约,不是模块 import",
  },
  {
    area: "packages/engine/sandbox-runtime",
    mustObserve: true,
    suites: ["test:vm"],
    why: "入库的 runtime IIFE 产物:被读成字节塞进 wasm VM,不是 import——图对它没有边",
  },
  {
    area: "packages/gen/sandbox-rootfs",
    suites: [],
    why: "生成期沙箱的入库 rootfs;漂移由 gate:static 里的 gate:rootfs 盯,不牵扯对局",
  },
  {
    area: "coverage-debt.txt",
    suites: [],
    why: "未覆盖改动登记表;`check` 的红线指向它,所以它必须存在——改它不需要跑测试",
  },
  {
    area: "test-inputs",
    suites: [],
    why: "观测 map 本身(由 `observe:inputs:accept` 生成);改它不需要跑任何测试,但改动要被看见",
  },
  {
    area: "docs",
    suites: [],
    why: "散文;取值由 gate:prose 盯、契约由 gate:contract 盯,都在 gate:static 里",
  },
  {
    area: "prompts",
    suites: [],
    why: "提示词清单与命令由 gate:prompt:* 盯,都在 gate:static 里",
  },
  {
    area: "scripts",
    suites: [],
    why: "一次性脚本,不在任何运行时路径上",
  },
  {
    area: "stryker",
    suites: [],
    why: "变异测试配置,只在 mutate:* 里生效",
  },
  {
    area: "probes",
    suites: [],
    why: "门禁自证的探针素材,由 gate:selfproof 用",
  },
  {
    area: "archive",
    suites: [],
    why: "冻档不入库;它的缺席由 test:kernel 的 skipIf 显式表达",
  },
  {
    area: "reports",
    suites: [],
    why: "报告产物(observe:test / observe:lint 的落点,不入库)",
  },
  {
    area: "runs",
    suites: [],
    why: "本地对局产物(match/run 的落点,不入库、不参与判据)",
  },
  {
    area: ".github",
    suites: ["test"],
    why: "CI 接线由 packages/tools/src/ci.test.ts 盯(快链成员、缓存键),它不 import CI 文件",
  },
  {
    area: ".githooks",
    suites: [],
    why: "提交信息钩子,它的判据是 shell 脚本而不是测试",
  },
  {
    area: ".pi",
    suites: [],
    why: "agent 的技能与配置,按路径读、不参与运行时",
  },
  {
    area: "package.json",
    suites: ["test:all"],
    why: "脚本与依赖一变,任何一族都可能受影响:收窄就是假绿",
  },
  {
    area: "pnpm-lock.yaml",
    suites: ["test:all"],
    why: "依赖树变了等于换了一套运行时",
  },
  {
    area: "pnpm-workspace.yaml",
    suites: ["test:all"],
    why: "工作区拓扑变了,包解析与打包都会动",
  },
  {
    area: "tsconfig.base.json",
    suites: ["test:all"],
    why: "编译选项影响所有包的产物形态,而选择器正是按产物问图",
  },
  {
    area: "tsconfig.json",
    suites: ["test:all"],
    why: "根 tsconfig 的引用集合,决定 `tsc -b` 的编译面",
  },
  {
    area: "tsconfig.scripts.json",
    suites: [],
    why: "只作用于 tools 的脚本工程,由 gate:types 覆盖",
  },
  {
    area: "vitest.config.ts",
    suites: ["test:all", "test:gates"],
    why: "project 划分一变,「哪一族跑哪些文件」就变了——这是判据本身的定义",
  },
  {
    area: "vitest.global-setup.ts",
    suites: ["test:all"],
    why: "它在任何模块加载前跑 `tsc -b`,而选择器依赖产物存在",
  },
  {
    area: "vitest.record-inputs.setup.ts",
    suites: ["test"],
    why: "观测器的装载位置;它一错,输入 map 会静默变空,而空 map 只表现为少跑",
  },
  {
    area: "vitest.kernel-guard.setup.ts",
    suites: ["test"],
    why: "内核探针的接线由 packages/tools/src/vitest/kernel-guard.test.ts 盯",
  },
  {
    area: ".oxlintrc.json",
    suites: [],
    why: "lint 配置,由 quick 的 lint 步骤自己证明",
  },
  {
    area: ".oxfmtrc.json",
    suites: [],
    why: "格式化配置,由 quick 的 fmt 步骤自己证明",
  },
  {
    area: ".dependency-cruiser.js",
    suites: [],
    why: "包边界规则,由 verify:wide 的 gate:deps 覆盖",
  },
  {
    area: "models.yaml",
    suites: ["test"],
    why: "模型名册被生成链路按需读取;形状由 gen 的单测盯",
  },
  {
    area: "season.yaml",
    suites: [],
    why: "本地赛季配置(样例在 season.example.yaml)",
  },
  {
    area: "season.example.yaml",
    suites: ["test"],
    why: "赛季配置样例,被解析侧的单测当夹具读",
  },
  {
    area: "skills-lock.json",
    suites: [],
    why: "技能锁(提交时间与内容快照),按路径读",
  },
  {
    area: "stryker.config.mjs",
    suites: [],
    why: "变异测试总配置,只在 mutate:* 里生效",
  },
  {
    area: "AGENTS.md",
    suites: [],
    why: "agent 指令,按路径读,没有判据依赖它",
  },
  {
    area: "CONTEXT.md",
    suites: [],
    why: "领域词汇,按路径读,没有判据依赖它",
  },
  {
    area: "README.md",
    suites: [],
    why: "仓库入口说明,按路径读",
  },
];

/**
 * 一条路径归属的规则。`RADIUS` 的**顺序即优先级**:`packages/tools/src/scope` 在兜底的
 * `packages/tools` 前面,于是选择器自身的改动不会被兜底规则吞掉。
 *
 * 三个调用方(选择、`mustObserve`、`check --print` 的依据行)共用这一份——各写一份 `startsWith`
 * 的时候,依据行就曾拿命中集合里的第一条来比,把 `src/scope` 的改动显示成兜底规则。
 */
export const ruleFor = (path: string): Radius | undefined =>
  RADIUS.find((candidate) => path === candidate.area || path.startsWith(`${candidate.area}/`));

/** 测试文件(用例本身):`*.test.ts` / `*.prop.ts`。 */
const isTestCaseFile = (path: string): boolean => /\.(?:test|prop)\.ts$/u.test(path);

/**
 * **依赖图看不见的测试文件。**
 *
 * "改测试文件就交给依赖图"这句话有个前提:图看得见它。改一个测试文件时,`vitest related` 会
 * 把它自己选出来(实测:`ci.test.ts` → 1 个文件 / 17 条 / 1.06s);但这几个文件被 `all` 显式
 * 排除(`gates` / `slow` project),或者压根不在 `all` 的 include 里(`.prop.ts` 归 `property`)
 * ——改它们的时候图会一条都不选,所以仍由兜底规则补整族。
 *
 * 这份清单是**输入**,不是判据:`test-layers.test.ts` 从 `vitest.config.ts` 的 `all` 块重新
 * 推导一遍再对账——谁单方面改了都会红。
 *
 * 清单只说"图看不见它",**不说"该跑哪一族"**。后者由各文件自己的规则决定(`RADIUS` 顺序即
 * 优先级):`gates-slow.test.ts` 住在 `slow` project,于是它有自己的那条(`test:slow`),
 * 而不是被兜底送去门禁自测——跑错族与少跑一样是错的,只是它多跑的那一半不报错。
 */
export const GRAPH_BLIND_TESTS: readonly string[] = [
  "packages/tools/src/gates.test.ts",
  "packages/tools/src/gates-slow.test.ts",
  "packages/tools/src/rules/no-float.prop.ts",
];

/** 一条路径该补哪些族。选择与 `--print` 的依据行共用这一份,两处不各算一次。 */
export const suitesFor = (path: string): readonly string[] => {
  const rule = ruleFor(path);
  if (rule === undefined) return [];
  // 兜底不对测试文件本身负责:它的判据是它自己(依赖图选得出来),而门禁自测是另一件事。
  if (rule.fallback === true && isTestCaseFile(path) && !GRAPH_BLIND_TESTS.includes(path))
    return [];
  return rule.suites;
};

/**
 * **逐文件探针答得出这个路径吗?**
 *
 * 探针问的是 `vitest related --project all`(见 `check.ts`),它只对**在 `all` 的池子里**的
 * 文件答得出候选。表把某个**池子外**的族指给这个文件时(改一个 `sandbox` / `gates` / `slow`
 * 的测试文件),那条命令结构上只能答「0 条」——而 0 条在这里会被读成「确知为零,没人看着
 * 它」,那是一句假话:问错了池子,不是没人看。
 *
 * 这类文件的判据是它自己那一族,而那一族**就是 `check` 会真的执行的那一条**(`decide` 已经
 * 把名字算进计划)。所以探针在这里不适用,红线仍由族本身承担:跑不起来就红。
 *
 * 别的路径一视同仁地问图——源码,以及没有族可指的测试文件。
 */
export const probeApplies = (path: string): boolean =>
  !(isTestCaseFile(path) && suitesFor(path).some((suite) => !SUPERSEDED_BY_ALL.includes(suite)));

/** 顶层里**允许不登记**的条目:仓库元数据与产物,改了不影响任何判据。 */
export const IGNORED_AREAS: readonly string[] = [
  ".git",
  ".codegraph",
  ".scratch",
  ".stryker-tmp",
  ".vitest",
  ".workspaces",
  ".env",
  ".env.example",
  ".gitignore",
  "node_modules",
];

/**
 * **门禁实现文件 → `gates.test.ts` 里那批用例的 `-t` 模式**(正则串)。
 *
 * `gates` project 只含一个文件(89 条 / 实测 166s),所以 project 层面的"相关选择"是 0/1;
 * 真正的粒度只能来自**用例名过滤**。用例名以门禁名开头(`禁浮点门禁:…`),两者是同一条事实
 * 的两种写法,于是这张表就是那条对应关系。
 *
 * 三条纪律:
 *
 * 1. **只收能映射到具体一批用例的文件**。公共基础设施(`gates-harness.ts`、`gate/source-tree.ts`、
 *    `gate/vacuous.ts`、`ci-workflows.ts`)一动就是整族的语义,不映射 → 整族。
 * 2. **空了就整族。** 表里查不到 = 不知道影响哪几条 = 全跑。多跑几秒比"少跑了没人管"便宜。
 * 3. **模式必须真的命中。** 模式是名字过滤,改了用例名的措辞它就会静默失效——`test-layers.test.ts`
 *    拿每个模式去 `gates.test.ts` 的 `it("…")` 上数一遍,0 命中即红。
 *
 * 另外这张表只能收**会被兜底选中**的文件:测试文件本身另有豁免(见 `GRAPH_BLIND_TESTS`),
 * 给它们写映射就是死条目——`test-layers.test.ts` 一并盯这条(每条都要真的选中 `test:gates`)。
 */
export const GATES_CASES: Readonly<Record<string, readonly string[]>> = {
  "packages/tools/src/gate/budget-gate.ts": ["预算结构门禁"],
  "packages/tools/src/gate/run-budget-gate.ts": ["预算结构门禁"],
  "packages/tools/src/gate/declared-deps-gate.ts": ["声明即依赖门禁"],
  "packages/tools/src/gate/run-declared-deps-gate.ts": ["声明即依赖门禁"],
  "packages/tools/src/gate/no-float-gate.ts": ["禁浮点门禁"],
  "packages/tools/src/gate/run-no-float-gate.ts": ["禁浮点门禁"],
  "packages/tools/src/gate/run-contract-gate.ts": ["契约挂载门禁"],
  "packages/tools/src/gate/run-prompt-commands-gate.ts": ["命令清单门禁"],
  "packages/tools/src/gate/run-prompt-tools-gate.ts": ["工具清单门禁"],
  "packages/tools/src/gate/run-quickjs-coupling-gate.ts": ["quickjs-wasi 版本耦合断言"],
  // `gate/*.test.ts` 不在表里:测试文件本身由豁免交给依赖图(改它就是跑它),
  // 只有它们的**被测试物**上面那几行才需要 `-t`。
  // `scan` 不是门禁而是一条观测(ADR-0010):用例名也写成了观测的样子,两处都得跟上。
  "packages/tools/src/gate/scan-gate.ts": ["变异 / 扫描只在夜间", "scan 观测可调通"],
  "packages/tools/src/gate/run-scan-gate.ts": ["变异 / 扫描只在夜间", "scan 观测可调通"],
};

/** 被 `test:all` 覆盖的子集：它们在 `all` 的池子里，选中全量后不必再单独跑一遍。 */
const SUPERSEDED_BY_ALL: readonly string[] = ["test", "test:vm", "test:e2e"];

export interface Decision {
  /** 按固定顺序排好的待跑命名脚本(去重)。 */
  readonly scripts: readonly string[];
  /** 交给依赖图选择器的文件(源码 + 展开出的产物)。 */
  readonly graphFiles: readonly string[];
  /** 源码改了但产物不存在——静态映射失效,已退回全量。 */
  readonly notBuilt: readonly string[];
  /** 命中的表规则(给人看"为什么是这些")。 */
  readonly hits: readonly Radius[];
  /**
   * 门禁自测要跑的 `-t` 模式(正则串)。**空数组 = 整族**。
   *
   * 空有两个来源,都不需要区分:根本没选 `test:gates`,或者选了但映射不到具体用例
   * (公共基础设施、表外的文件、多个来源里有任何一个说不清)。
   */
  readonly gatesPatterns: readonly string[];
}

export interface DecisionInput {
  readonly paths: readonly string[];
  readonly workspaces: readonly Workspace[];
  /** 产物是否已在磁盘上。注入是为了能测"没 build 就退回全量"这条分支。 */
  readonly exists: (path: string) => boolean;
  /**
   * 这些路径**已经不在仓库里了**(本次改动删除的)。
   *
   * 判据只看**还在的文件**有没有产物:删除的文件本来就没有产物,那不是"没构建",是"不存在了"。
   * 两者混在一起的话,删一个源码文件就会让整个计划退回全量(`test:all`),而退回的理由是一句
   * 错话——“静态映射失效”不成立,映射好着呢,只是目标没了。
   *
   * 口径与 `check.ts` 的 `probeTargets` 同源:同一路径若另有一条非删除的条目(删了又建),它
   * 不算删除,产物照旧必须存在。调用方直接递 `probeTargets(...).deleted`,不要另算一份。
   */
  readonly deleted?: readonly string[];
}

/**
 * 把一组改动路径翻成一份执行计划。
 *
 * 抛 `UnregisteredPathError` 的条件**只有一个**:既映射不到产物、也没有表规则。
 */
/**
 * 任何层级的 `package.json` 与锁文件都是**仓库事实**:改它可能换掉一整棵依赖树。
 *
 * 顶层那两条在表里(带 why);嵌套包的那份由这里兜——`apps/cli/package.json` 会被测试读到,
 * 而它既不在 `src/` 下(映射不出产物),也不该被当成"无法解释"。
 */
const isManifest = (path: string): boolean =>
  path === "package.json" ||
  path.endsWith("/package.json") ||
  path === "pnpm-lock.yaml" ||
  path.endsWith("/pnpm-lock.yaml") ||
  // 嵌套包的 `tsconfig.json` 同属仓库事实:`rootDir` / `outDir` 是选择器映射的**唯一真源**
  // (`build-outputs.ts` 靠读它算产物路径),改了它等于换了所有包的产物位置。根那份在表里。
  path.endsWith("/tsconfig.json");

/**
 * 门禁自测的子集:`test:gates` 被选中时,把命中的门禁实现文件翻成 `-t` 模式。
 *
 * 空数组 = **整族**。方向只有一边:宁可多跑,不许少跑——
 *
 * - 没选 `test:gates` → 空(不跑,与"整族"在调用方看来是一回事:两者都不带 `-t`);
 * - 选了,但没有任何"要求门禁自测的规则"命中(`gatesFiles` 空)→ 整族(没有文件可映射);
 * - 命中多个文件时取**并集**:并集 ⊇ 每一条,不会比单文件映射少跑;
 * - 其中**任何一条**文件映射不出模式(公共基础设施、表外的文件)→ 整族。
 */
const gatesPatternsOf = (input: {
  readonly needsGates: boolean;
  readonly files: ReadonlySet<string>;
}): readonly string[] => {
  if (!input.needsGates || input.files.size === 0) return [];
  const patterns = new Set<string>();
  for (const file of input.files) {
    const cases = GATES_CASES[file];
    // 映射不出 = 不知道它影响哪批用例。"不知道"在这里不能当"没影响"。
    if (cases === undefined) return [];
    for (const pattern of cases) patterns.add(pattern);
  }
  // 排序只为两件事:日志可比、同一改动每次得到同一个计划。
  return [...patterns].sort();
};

export const decide = (input: DecisionInput): Decision => {
  const hits: Radius[] = [];
  const chosen = new Set<string>();
  const graphFiles = new Set<string>();
  const notBuilt = new Set<string>();
  /** 命中的、且规则要求跑门禁自测的改动文件(`-t` 模式只能逐个文件查)。 */
  const gatesFiles = new Set<string>();
  const deleted = new Set(input.deleted ?? []);

  for (const path of input.paths) {
    const rule = ruleFor(path);
    // 产物路径先反查源码:测试会读 `dist/`,那不是第四类输入,是源码的下一跳。
    const source =
      buildOutputsOf(path, input.workspaces).length > 0 ? path : sourceOf(path, input.workspaces);
    const outputs = source === undefined ? [] : buildOutputsOf(source, input.workspaces);
    // 手写的 `.d.ts` 产出为空(`buildOutputsOf` 给它空),但它是代码,不是"无法解释"。
    const inSource = isSourceFile(path, input.workspaces);
    const explainable = outputs.length > 0 || inSource || source !== undefined;
    if (isManifest(path) && rule === undefined && !explainable) {
      // 嵌套包的 `package.json` 不在表里,但它换掉的是整棵依赖树。
      chosen.add("test:all");
    } else if (!explainable && rule === undefined) {
      throw new UnregisteredPathError(path);
    }
    if (rule !== undefined && !hits.includes(rule)) hits.push(rule);
    const suites = suitesFor(path);
    if (suites.includes("test:gates")) gatesFiles.add(path);
    for (const script of suites) chosen.add(script);
    if (outputs.length === 0 || source === undefined) continue;

    // 源码与产物**都**交给图:源码问出包内的测试,产物问出跨包依赖它的测试,两者并集才完整。
    graphFiles.add(source);
    graphFiles.add(path);
    // 删除的文件**没有产物可言**:"产物不在盘上"这句判据问的是"还在的文件有没有跟上构建",
    // 而删除的文件的产物永远不会出现。拿它去触发退回全量,得到的是一个没有事实支撑的 `test:all`。
    if (deleted.has(path) || deleted.has(source)) continue;
    for (const output of outputs) {
      graphFiles.add(output);
      if (!input.exists(output)) notBuilt.add(output);
    }
  }

  const scripts = new Set(ALWAYS);
  if (notBuilt.size > 0) {
    // 产物不在盘上时,静态映射给出的边是空的——照旧少选就是"静默少选"。退回全量。
    scripts.add("test:all");
  } else {
    for (const suite of SUITES) if (chosen.has(suite)) scripts.add(suite);
  }
  // `test:all` 一旦被选中，就把它的子集收掉：`test` / `test:vm` / `test:e2e` 都在它的池子里，
  // 再跑一遍是把同一批文件跑第二遍。`test:gates` **不**收——它住在独立 project，不在池子里。
  // （一条 `package.json` 的改动会把半径撑到全量，此时不收敛就是 70s + 25s + 21s + 34s。）
  const effective = scripts.has("test:all")
    ? new Set([...scripts].filter((script) => !SUPERSEDED_BY_ALL.includes(script)))
    : scripts;
  const ordered = [
    ...ALWAYS,
    ...SUITES.filter((suite) => effective.has(suite) && !ALWAYS.includes(suite)),
  ];
  return {
    scripts: ordered,
    graphFiles: [...graphFiles].sort(),
    notBuilt: [...notBuilt].sort(),
    hits,
    gatesPatterns: gatesPatternsOf({ needsGates: effective.has("test:gates"), files: gatesFiles }),
  };
};

/** 改了没登记的地方。**必须红**:静默跳过等于机器给人一个假的绿。 */
export class UnregisteredPathError extends Error {
  constructor(path: string) {
    super(
      `路径没有归属:${path}\n` +
        "它既不在任何工作区包的 `src/` 下(映射不到构建产物,图无从判断),也没有表规则。\n" +
        "请在 packages/tools/src/scope/change-radius.ts 的 RADIUS 里给它一条规则" +
        "(拿不准就往多的写:多跑几秒比假绿便宜)。",
    );
    this.name = "UnregisteredPathError";
  }
}

/**
 * 这次改动**必须**有人看着吗?
 *
 * 两类:代码(能映射出产物的源码),以及表里开了 `mustObserve` 的行为输入。判据是"改了行为却
 * 没有判据"这件事必须有声音——散文、`package.json`、`docs/` 不在其中,它们有静态门禁读。
 *
 * ── 新输入文件的保守回退靠的就是这一条 ──
 *
 * 观测 map 是历史快照——它只认识**录制那天存在**的输入文件。往 `rulesets/` 里新加一个文件,
 * map 里没有它,`invert()` 自然查不到任何测试,于是选择器对它的判断是"没人读它",一分钱不花
 * 就绿了。这是 map 唯一的失效方向:**少记 = 少跑 = 绿**。
 *
 * 挡住它的不是第二张清单,而是两个已有机制合起来:`RADIUS` 的区域前缀规则给出"这个区域该跑
 * 哪几族"(`suites`),`mustObserve` 给出"没人读它就必须有声音"。新文件(map 里没有)照样被
 * 前缀规则选中保守的那一族;而若那条规则的 `suites` 是空的,它会在 `check` 里直接红——
 * "空回退"因此不是一个可以静默存在的状态。
 *
 * 这条性质过去由一个导出 `INPUT_ROOTS`(把 `mustObserve` 规则投影一遍)承担,而它**没有任何
 * 生产消费者**:唯一用处是拿它对着 `RADIUS` 自证一遍——看起来接好了,其实没接线。那种形状比
 * 没有更坏,所以删掉了。现在由 `test-inputs.test.ts` 对**行为**断言:未观测的新文件仍选中
 * 该区域的 suites,已删除的文件(仍在 ChangeSet 里)也仍选中。
 */
export const mustObserve = (input: {
  readonly path: string;
  readonly workspaces: readonly Workspace[];
}): boolean => {
  const rule = ruleFor(input.path);
  if (rule?.mustObserve === true) return true;
  return isSourceFile(input.path, input.workspaces);
};
