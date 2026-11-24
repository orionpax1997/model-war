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
export const SUITES: readonly string[] = ["test", "test:vm", "test:e2e", "test:gates", "test:all"];

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
    area: "packages/tools",
    suites: ["test:gates"],
    why: "门禁自测住在独立的 `gates` project 里,不在 `all` 的池子里——图选不到它,只能由表补",
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
}

export interface DecisionInput {
  readonly paths: readonly string[];
  readonly workspaces: readonly Workspace[];
  /** 产物是否已在磁盘上。注入是为了能测"没 build 就退回全量"这条分支。 */
  readonly exists: (path: string) => boolean;
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

export const decide = (input: DecisionInput): Decision => {
  const hits: Radius[] = [];
  const chosen = new Set<string>();
  const graphFiles = new Set<string>();
  const notBuilt = new Set<string>();

  for (const path of input.paths) {
    const rule = RADIUS.find(
      (candidate) => path === candidate.area || path.startsWith(`${candidate.area}/`),
    );
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
    for (const script of rule?.suites ?? []) chosen.add(script);
    if (outputs.length === 0 || source === undefined) continue;

    // 源码与产物**都**交给图:源码问出包内的测试,产物问出跨包依赖它的测试,两者并集才完整。
    graphFiles.add(source);
    graphFiles.add(path);
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
 */
export const mustObserve = (input: {
  readonly path: string;
  readonly workspaces: readonly Workspace[];
}): boolean => {
  const rule = RADIUS.find(
    (candidate) => input.path === candidate.area || input.path.startsWith(`${candidate.area}/`),
  );
  if (rule?.mustObserve === true) return true;
  return isSourceFile(input.path, input.workspaces);
};

/**
 * **Input Root**:观测快照的盲区边界(票 T5)。
 *
 * 观测 map 是历史快照——它只认识**录制那天存在**的输入文件。往 `rulesets/` 里新加一个文件,
 * map 里没有它,`invert()` 自然查不到任何测试,于是选择器对它的判断是"没人读它",一分钱不花
 * 就绿了。这是 map 唯一的失效方向:**少记 = 少跑 = 绿**。
 *
 * 所以一个区域一旦被声明为"它的内容必须被观测到"(`mustObserve`),它同时就声明了另一半:
 * **这个区域里新出现的输入文件,退回该区域的 `suites`**——还没被观测到的东西按多跑处理。
 *
 * ── 与 `mustObserve` 不是同一件事 ──
 *
 * - `mustObserve`(输入侧,即"已有的关键输入有没有人看"):关键输入必须有观测记录,没有就红。
 *   它回答「**这条路**改了会不会没人看」。
 * - `INPUT_ROOTS`(覆盖侧,即"这个区域的新文件往哪退"):该区域的新输入文件必须有保守回退,
 *   没有回退就报错。它回答「**这类新文件**进来时先跑什么」。
 *
 * 一条规则同时给出两者,是因为它们是同一句话的两面("这个区域的内容必须有人看着");
 * 但判据各用各的:前者在 `check.ts` 的未观测红线上,后者在快照过期与 Input Root 回退上。
 *
 * 由 `RADIUS` 推导而不是另写一张表:两份手写清单必然腐烂成不一样的边界(ADR-0038)。
 */
export interface InputRoot {
  /** 区域前缀,语义同 `Radius.area`。 */
  readonly area: string;
  /** 该区域新输入文件的保守回退(非空:空集合等于"回退到什么都不跑",那是静默少选)。 */
  readonly suites: readonly string[];
}

export const INPUT_ROOTS: readonly InputRoot[] = RADIUS.filter(
  (rule) => rule.mustObserve === true,
).map((rule) => ({ area: rule.area, suites: rule.suites }));
