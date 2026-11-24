/**
 * **改动 → 该跑什么**。`verify:scoped` 的唯一真源。
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

import { buildOutputsOf, type Workspace } from "./build-outputs.ts";

/** 任何改动都要跑的两步:格式化/静态检查(输入在编辑面上)、入库事实漂移(1s 级)。 */
export const ALWAYS: readonly string[] = ["quick", "gate:static"];

/** 全部测试族。除 `quick` / `gate:static` 之外的每个测试入口都要在这里登记一次。 */
export const SUITES: readonly string[] = ["test", "test:vm", "test:e2e", "test:gates", "test:all"];

export interface Radius {
  /** 相对仓库根的路径前缀;`p === area || p.startsWith(area + "/")` 命中。 */
  readonly area: string;
  /** 除 `ALWAYS` 之外还要跑的命名脚本(必须是 `package.json` 里真实存在的名字)。 */
  readonly suites: readonly string[];
  /** 为什么是这几条,或者为什么一条都不需要。 */
  readonly why: string;
}

export const RADIUS: readonly Radius[] = [
  {
    area: "rulesets",
    suites: ["test:vm"],
    why: "参数取值改一条就是换了一套规则,整场行为与结算都要在真 VM 上重算",
  },
  {
    area: "maps",
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
    area: "packages/gen/sandbox-rootfs",
    suites: [],
    why: "生成期沙箱的入库 rootfs;漂移由 gate:static 里的 gate:rootfs 盯,不牵扯对局",
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
export const decide = (input: DecisionInput): Decision => {
  const hits: Radius[] = [];
  const chosen = new Set<string>();
  const graphFiles = new Set<string>();
  const notBuilt = new Set<string>();

  for (const path of input.paths) {
    const outputs = buildOutputsOf(path, input.workspaces);
    const rule = RADIUS.find(
      (candidate) => path === candidate.area || path.startsWith(`${candidate.area}/`),
    );
    if (outputs.length === 0 && rule === undefined) {
      throw new UnregisteredPathError(path);
    }
    if (rule !== undefined && !hits.includes(rule)) hits.push(rule);
    for (const script of rule?.suites ?? []) chosen.add(script);
    if (outputs.length === 0) continue;

    // 源码与产物**都**交给图:源码问出包内的测试,产物问出跨包依赖它的测试,两者并集才完整。
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
