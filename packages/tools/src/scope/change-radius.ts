/**
 * **改动半径 → 该跑哪些命名脚本**。`verify:scoped` 的唯一真源。
 *
 * ── 这张表要解的是什么 ──
 *
 * `verify` 是收口:`quick` + `gate:static` + 全量测试。它一次要对,所以该跑全。但"每次改动都付
 * 同样的账"是另一回事——改一段散文(`docs/`)与改一个 VM 的 tick 循环,后果完全不在一个量级上,
 * 而后者才是那 70s 的账主。这张表把「改到哪儿 → 至少跑什么」变成可执行的东西,而不是靠人记。
 *
 * ── 为什么不能用 `vitest --changed` 自动推 ──
 *
 * 它按 import 图找相关测试。而本仓最贵的那些用例是**进程级**的:它们 spawn 打好的 CLI 产物,
 * 与被测代码在依赖图上**没有边**。改 `packages/engine/src/runner/quickjs.ts`,`--changed` 不会
 * 选中 `cli-match.test.ts`——它会静默跳过,绿得刚好把问题盖住。那正是「机器背书的假确定性」。
 * 所以这里用的是**人工列的、默认保守的**前缀表,并且:
 *
 * - 表里的占位比表外的漏项安全:拿不准就往多的写(多跑几秒 vs 假绿);
 * - 未登记的路径**直接红**,不是跳过;
 * - `packages/tools/src/scope/test-layers.test.ts` 盯着三件事:每条规则指向的脚本真实存在、
 *   仓库顶层每个条目都被覆盖、每个 vitest project 都有入口。
 *
 * 新增一个包 / 一个顶层目录时,那条测试会红——这是有意的:漏登记的后果是"那部分代码改了却没人
 * 跑它的测试",而它不会以报错的形式自己显形。
 */

/** 任何改动都要跑的两步:格式化/静态检查(输入在编辑面上)、入库事实漂移(1s 级)。 */
export const ALWAYS: readonly string[] = ["quick", "gate:static"];

export interface Radius {
  /** 相对仓库根的路径前缀;`p === area || p.startsWith(area + "/")` 命中。 */
  readonly area: string;
  /** 除 `ALWAYS` 之外还要跑的命名脚本(必须是 `package.json` 里真实存在的名字)。 */
  readonly suites: readonly string[];
  /** 为什么是这几条。读的人要能不查代码就判断这条规则该不该改。 */
  readonly why: string;
}

/**
 * 全部测试族。`quick` / `gate:static` 之外的每一个测试入口都要在这里登记一次,
 * 否则 `test-layers.test.ts` 会指着"这个 project 没人会跑它"。
 */
export const SUITES: readonly string[] = [
  "test",
  "test:vm",
  "test:e2e",
  "test:gates",
  "test:kernel",
];

export const RADIUS: readonly Radius[] = [
  {
    area: "apps/cli",
    suites: ["test", "test:e2e"],
    why: "argv 解析、退出码、整条链路都在这一层;e2e 是唯一能证「一条命令行串起全部」的地方",
  },
  {
    area: "packages/engine",
    suites: ["test", "test:vm"],
    why: "引擎改动要在真 quickjs-wasi VM 上复验(确定性、预算轨、注入面),桩跑不出这些",
  },
  {
    area: "packages/schema",
    suites: ["test", "test:vm"],
    why: "契约与内置常量是 VM 侧的输入,改了就要在真 VM 上复验一遍落地形态",
  },
  {
    area: "packages/replay",
    suites: ["test", "test:vm"],
    why: "回放格式与 stateHash 是复算链的锚点,VM 侧有独立一份",
  },
  {
    area: "packages/runner",
    suites: ["test"],
    why: "赛季调度、排名、报告是纯逻辑;真链路由 apps/cli 的 e2e 覆盖",
  },
  {
    area: "packages/gen",
    suites: ["test"],
    why: "生成链路用替身执行器验;真沙箱那一份在 test:kernel(要 bwrap)",
  },
  {
    area: "packages/tools",
    suites: ["test", "test:gates"],
    why: "tools 里大部分是门禁本身,改判据就得跑门禁自测(它 spawn 真实命令)",
  },
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
    area: "benchmarks",
    suites: ["test:vm", "test:e2e"],
    why: "基准脚本同时被 VM 组当执行体、被 e2e 组当 CLI 夹具",
  },
  {
    area: "sandbox-rootfs",
    suites: [],
    why: "rootfs 漂移由 gate:static 里的 gate:rootfs 盯,不牵扯对局",
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
    why: "CI 接线由 packages/tools/src/ci.test.ts 盯(快链成员、缓存键)",
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
    suites: ["test", "test:vm", "test:e2e"],
    why: "脚本与依赖一变,任何一族都可能受影响:收窄就是假绿",
  },
  {
    area: "pnpm-lock.yaml",
    suites: ["test", "test:vm", "test:e2e"],
    why: "同上:依赖树变了等于换了一套运行时",
  },
  {
    area: "pnpm-workspace.yaml",
    suites: ["test", "test:vm", "test:e2e"],
    why: "工作区拓扑变了,包解析与打包都会动",
  },
  {
    area: "tsconfig.base.json",
    suites: ["test"],
    why: "编译选项影响所有包的产物形态",
  },
  {
    area: "tsconfig.json",
    suites: ["test"],
    why: "根 tsconfig 的引用集合,决定 `tsc -b` 的编译面",
  },
  {
    area: "tsconfig.scripts.json",
    suites: [],
    why: "只作用于 tools 的脚本工程,由 gate:types 覆盖",
  },
  {
    area: "vitest.config.ts",
    suites: ["test", "test:vm", "test:e2e", "test:gates"],
    why: "project 划分一变,「哪一族跑哪些文件」就变了——这是判据本身的定义",
  },
  {
    area: "vitest.global-setup.ts",
    suites: ["test", "test:vm", "test:e2e"],
    why: "它在任何模块加载前跑 tsc -b,四个测试族全靠它",
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
    why: "包边界规则由 gate:static 里的 gate:deps 之外的 verify:wide 覆盖",
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
  {
    area: "models.yaml",
    suites: [],
    why: "模型名册,生成链路按需读取;形状由 gen 的单测盯",
  },
  {
    area: "season.yaml",
    suites: [],
    why: "本地赛季配置,被 `run` 当输入;样例在 season.example.yaml",
  },
  {
    area: "season.example.yaml",
    suites: [],
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

export interface Plan {
  /** 按维度稳定顺序排好的待跑脚本(去重)。 */
  readonly scripts: readonly string[];
  /** 命中的规则(给人看"为什么是这些")。 */
  readonly hits: readonly Radius[];
}

/**
 * 把一组改动路径翻成待跑脚本。
 *
 * `ALWAYS` 先跑(便宜、失败快),其余按 `SUITES` 的顺序排——保证同样的改动每次得到同样的序列,
 * 报告与日志可比。
 */
export const planFor = (paths: readonly string[]): Plan => {
  const hits: Radius[] = [];
  const chosen = new Set<string>();
  for (const path of paths) {
    const rule = RADIUS.find(
      (candidate) => path === candidate.area || path.startsWith(`${candidate.area}/`),
    );
    if (rule === undefined) {
      throw new UnregisteredPathError(path);
    }
    if (!hits.includes(rule)) hits.push(rule);
    for (const script of rule.suites) chosen.add(script);
  }
  const scripts = [...ALWAYS, ...SUITES.filter((suite) => chosen.has(suite))];
  return { scripts, hits };
};

/** 改了没登记的地方。**必须红**:静默跳过等于机器给人一个假的绿。 */
export class UnregisteredPathError extends Error {
  constructor(path: string) {
    super(
      `路径没有归属:${path}\n` +
        "请在 packages/tools/src/scope/change-radius.ts 的 RADIUS 里给它一条规则" +
        "(拿不准就往多的写:多跑几秒比假绿便宜)。",
    );
    this.name = "UnregisteredPathError";
  }
}
