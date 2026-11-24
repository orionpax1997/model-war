/**
 * 计划代数的判据:默认计划 ⊆ 收口计划,这件事由**可计算**的集合关系承担。
 *
 * 要防的那个洞是实测过的:`packages/tools` 的改动让默认 `check` 选中 `test:gates`(166s),而
 * `--full` 只跑 `FULL_CHAIN = verify + gate:types`——`verify → test:all → --project all
 * --project property`,`gates` project 不在其中。于是"更严格的验证"反而少跑一族,而且**不报错**。
 *
 * 这里的断言分三层,每层失败指向不同的东西:
 *
 * 1. **纯函数层**(1–6):展开、抽 project、覆盖判定。喂的是真的 `package.json` 脚本表,
 *    因为"脚本形态"正是这一层要跟住的事实(它一变,展开就失效)。
 * 2. **组合断言**(7):对五个代表性改动跑**真实** `decide()`,再用 `runsFor` 算出计划,断言
 *    `D ⊆ F`。这是本文件存在的主要理由——前六层都对、组合起来仍然可能漏一族。
 * 3. **事实对照**(3 的附带项):`PROJECT_CONTAINS` 与 `vitest.config.ts` 对得上。少了这条,
 *    一个手写的包含关系会慢慢变成第二个真源。
 *
 * 全部是静态读文件与纯函数调用,不起进程、不跑测试。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, matchesGlob, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { workspacesOf } from "./build-outputs.ts";
import { GATES_CASES, decide } from "./change-radius.ts";
import { FULL_CHAIN, labelOf, runsFor } from "./check.ts";
import {
  PROJECT_CONTAINS,
  chainScriptNames,
  chainProjects,
  fullPlan,
  isCovered,
  leavesOf,
  projectsIn,
  runProjects,
  scriptProjects,
  uncoveredRuns,
  type RunItem,
  type Scripts,
} from "./plan.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 真实的脚本表。计划代数跟的是**这份**形态:换成别的写法它就该保守地进 extras。 */
const scripts = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Scripts }
).scripts;

const workspaces = workspacesOf(repoRoot);

/** 产物当作都在盘上:组合断言要验的是计划代数,不是"没 build 就退回全量"那条分支。 */
const decideOn = (paths: readonly string[]) => decide({ paths, workspaces, exists: () => true });

type ProjectConfig = {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

/**
 * `vitest.config.ts` 的 project 表。**import 它求值**,不拿正则切文本。
 *
 * 这里曾经是 `configText().indexOf('name: "all"')` 切一刀再断言切片里没有 `VM_TESTS`:
 * 它看着像在核对"all 包含 vm",实际只核对"这两行之间的文本长什么样"。配置换个换行、
 * 把常量展开成字面量、把 `exclude` 改成 `include` 的写法,切片就切到别处——而**切错位不会红**,
 * 它只会让那两条 `not.toContain` 安静地成立。
 *
 * 求值之后 `include` / `exclude` 里的常量(`E2E_TESTS`、`VM_TESTS`…)已经是数组,于是可以直接
 * 问"这个 project 拾取这个文件吗"。同一份写法在 `test-layers.test.ts` 里已经跑着。
 */
const projectsOf = async (): Promise<readonly ProjectConfig[]> => {
  // specifier 放在变量里:根配置不在 `packages/tools` 这个编译单元里(rootDir 不含仓库根),
  // 而运行时的 Node 类型擦除直接执行它。
  const specifier = pathToFileURL(join(repoRoot, "vitest.config.ts")).href;
  const loaded = (await import(specifier)) as {
    default: { test: { projects: readonly { test: ProjectConfig }[] } };
  };
  return loaded.default.test.projects.map((project) => project.test);
};

/** 配置说这个 project 拾取这个文件吗(include 命中且 exclude 不命中)。 */
const picks = (project: ProjectConfig, file: string): boolean =>
  project.include.some((glob) => matchesGlob(file, glob)) &&
  !project.exclude.some((glob) => matchesGlob(file, glob));

/**
 * `apps/*` 与 `packages/*` 下的所有测试文件(仓库相对、POSIX 分隔、已排序)。
 *
 * 样本来自**磁盘**而不是配置的 include:拿 include 里的 glob 去当样本,`picks` 与它同源,
 * 包含关系会变成一句恒真的自证。
 */
const repoTestFiles = (): readonly string[] =>
  ["apps", "packages"]
    .flatMap((parent) =>
      readdirSync(join(repoRoot, parent), { recursive: true, encoding: "utf8" }).map((name) =>
        [parent, name.split(sep).join("/")].join("/"),
      ),
    )
    .filter(
      (file) =>
        file.endsWith(".test.ts") && !file.includes("/dist/") && !file.includes("/node_modules/"),
    )
    .sort();

describe("展开:`node --run` 跟到底,环引用不死循环", () => {
  it("leavesOf 把 verify 展开成叶子:test:all 的命令体在里面,引用本身不在", () => {
    const leaves = leavesOf(scripts, "verify");
    // 递归展开的证据:`test:all` 与 `lint` 的命令体作为叶子出现(两者都是二三层引用)。
    expect(leaves).toContain(scripts["test:all"]);
    expect(leaves).toContain(scripts["lint"]);
    // 而"引用"本身不该留在叶子里——留着就等于没展开,`--project` 一条都抽不到。
    expect(leaves).not.toContain("node --run test:all");
    expect(leaves.every((leaf) => !leaf.startsWith("node --run "))).toBe(true);
    // 名字那一侧看得到中间层的脚本:`gate:static` 自己的命令体已被拆成叶子,
    // 只有名字集能告诉你"它跑过了"。
    expect(chainScriptNames(scripts, ["verify"]).has("gate:static")).toBe(true);
  });

  it("环引用不死循环:走过的名字不再进,展开不出东西就是空", () => {
    const cyclic: Scripts = { a: "node --run b", b: "node --run a" };
    expect(leavesOf(cyclic, "a")).toEqual([]);
    // 名字那一侧同样不递归第二次。
    expect([...chainScriptNames(cyclic, ["a"])].sort()).toEqual(["a", "b"]);
    // 自环也一样。
    expect(leavesOf({ self: "node --run self" }, "self")).toEqual([]);
  });
});

describe("project:两种写法都认", () => {
  it("projectsIn 认 `--project x` 与 `--project=x`", () => {
    expect(projectsIn("vitest run --project all --project=property")).toEqual(["all", "property"]);
    expect(projectsIn("vitest run --project=gates")).toEqual(["gates"]);
  });

  it("`--project` 缺值不算一个 project(缺值不是「全部」)", () => {
    expect(projectsIn("vitest run --project --reporter=json")).toEqual([]);
    expect(projectsIn("vitest run --project=")).toEqual([]);
    expect(projectsIn("oxlint --type-aware apps packages")).toEqual([]);
  });
});

describe("覆盖的两个来源:脚本名与 project 集", () => {
  it("scriptProjects:verify ⊇ {all, property};test:gates 恰为 {gates}", () => {
    expect([...scriptProjects(scripts, "verify")].sort()).toEqual(["all", "property"]);
    expect([...scriptProjects(scripts, "test:gates")]).toEqual(["gates"]);
    // 不跑 vitest 的脚本抽不出 project:这正是"只看 project 会把 quick 再跑一遍"的由来。
    expect(scriptProjects(scripts, "quick").size).toBe(0);
  });

  it("chainScriptNames:链里跑过的脚本名字都在,不只是链的两个成员", () => {
    const names = chainScriptNames(scripts, FULL_CHAIN);
    for (const name of [...FULL_CHAIN, "quick", "gate:static", "test:all"]) {
      expect(names.has(name), `链里跑过了 ${name},名字集里却没有`).toBe(true);
    }
    // 负例:门禁自测不在链上——它必须被判成"没覆盖",否则本模块什么也不用做。
    expect(names.has("test:gates")).toBe(false);
  });

  it("PROJECT_CONTAINS 与 vitest.config.ts 对得上,且 gates 不在任何父池子里", async () => {
    const projects = await projectsOf();
    const byName = new Map(projects.map((project) => [project.name, project]));
    for (const [parent, children] of Object.entries(PROJECT_CONTAINS)) {
      expect(byName.has(parent), `vitest.config.ts 里没有 project ${parent}`).toBe(true);
      for (const child of children) {
        expect(byName.has(child), `vitest.config.ts 里没有 project ${child}`).toBe(true);
      }
    }
    // 包含关系的**内容**也是事实:`all` 的 include 就是 unit ∪ e2e ∪ vm 那一批文件,
    // 它排除的只有 gates / slow / sandbox / gen-cli —— 所以 `gates` 永远不会被吞掉。
    expect(Object.values(PROJECT_CONTAINS).flat()).not.toContain("gates");

    const files = repoTestFiles();
    expect(files.length, "一个测试文件都没数到:下面三条会静默成立").toBeGreaterThan(40);
    const pickedBy = (name: string): readonly string[] => {
      const project = byName.get(name);
      expect(project, `vitest.config.ts 里没有 project ${name}`).toBeDefined();
      return files.filter((file) => picks(project as ProjectConfig, file));
    };

    // 子集方向:每个子 project 拾取的文件,父 project 也拾取。这才能拿 `all` 当重量。
    for (const [parent, children] of Object.entries(PROJECT_CONTAINS)) {
      const parentFiles = new Set(pickedBy(parent));
      for (const child of children) {
        const leaked = pickedBy(child).filter((file) => !parentFiles.has(file));
        expect(leaked, `这些文件被 ${child} 拾取、${parent} 却没拾取:${leaked.join(", ")}`).toEqual(
          [],
        );
      }
    }

    // 反方向:不在任何子 project 里、却被 `all` 拾取的文件 = 被声明为"包含"却真的没人跑。
    const childFiles = new Set(Object.values(PROJECT_CONTAINS).flat().flatMap(pickedBy));
    const orphan = pickedBy("all").filter((file) => !childFiles.has(file));
    expect(
      orphan,
      `这些文件只在 all 里:收口跑了它,分档设定里却没有任何族对它负责:${orphan.join(", ")}`,
    ).toEqual([]);

    // `gates` 确实在父池子之外——这一条从配置推导,不是从 `PROJECT_CONTAINS` 抄。
    const covered = new Set([...childFiles, ...pickedBy("all")]);
    const gatesFiles = pickedBy("gates");
    expect(gatesFiles.length, "gates project 没拾取任何文件:这条断言会静默成立").toBeGreaterThan(0);
    expect(
      gatesFiles.filter((file) => covered.has(file)),
      "gates 的文件被某个父池子收进去了:于是收口会把它当已覆盖,实际没跑",
    ).toEqual([]);
  });
});

describe("计划构造函数:唯一的入口是 runsFor", () => {
  it("改源码时给出一条 related,project 集取自 test:related 的定义", () => {
    const runs = runsFor({
      scripts,
      decision: decideOn(["packages/engine/src/runner/quickjs.ts"]),
    });
    expect(runs.map(labelOf)).toEqual(["quick", "gate:static", "test:related(3 个文件)"]);
    const related = runs.find((run) => run.kind === "related");
    expect(related?.projects).toEqual([...scriptProjects(scripts, "test:related")]);
    expect(related?.kind === "related" ? related.files : []).toContain(
      "packages/engine/src/runner/quickjs.ts",
    );
  });

  it("test:all 已选中时不再多一条 related(同一批文件不跑第二遍)", () => {
    const runs = runsFor({ scripts, decision: decideOn(["package.json"]) });
    expect(runs.some((run) => run.kind === "related")).toBe(false);
    expect(runs.map(labelOf)).toEqual(["quick", "gate:static", "test:all"]);
  });

  it("观测命中的测试文件也递给依赖图(图看不见它们)", () => {
    const runs = runsFor({
      scripts,
      decision: decideOn(["packages/engine/src/runner/quickjs.ts"]),
      observed: ["packages/engine/src/runner/quickjs.test.ts"],
    });
    const related = runs.find((run) => run.kind === "related");
    expect(related?.kind === "related" ? related.files : []).toContain(
      "packages/engine/src/runner/quickjs.test.ts",
    );
  });
});

describe("fullPlan:只补差集,不重复执行", () => {
  const related: RunItem = {
    kind: "related",
    projects: ["all"],
    files: ["packages/engine/src/runner/quickjs.ts"],
  };

  it("链覆盖的 run 不进 extras(quick 不会被跑第二遍)", () => {
    const plan = fullPlan({
      scripts,
      chain: FULL_CHAIN,
      runs: [
        { kind: "script", script: "quick" },
        { kind: "script", script: "gate:static" },
        related,
      ],
    });
    expect(plan.chain).toEqual([...FULL_CHAIN]);
    expect(plan.extras).toEqual([]);
    // `quick` 没有 project、`related` 的 `all` 已被链跑过:两条腿各自都靠得住。
    expect(runProjects(scripts, related)).toEqual(new Set(["all"]));
    expect(chainProjects(scripts, FULL_CHAIN)).toEqual(new Set(["all", "property"]));
  });

  it("gates 被链漏掉,extras 恰为那一项", () => {
    const gates: RunItem = { kind: "gates", patterns: [] };
    const plan = fullPlan({
      scripts,
      chain: FULL_CHAIN,
      runs: [{ kind: "script", script: "quick" }, gates],
    });
    expect(plan.extras).toEqual([gates]);
  });

  it("extras 与去重后的 run 恰好切分 runs(既不丢也不重复)", () => {
    const runs = runsFor({ scripts, decision: decideOn(["packages/tools/src/gates-harness.ts"]) });
    const plan = fullPlan({ scripts, chain: FULL_CHAIN, runs });
    // 按**标签**分,不按对象同一性:`includes(item)` 判引用,构造一变就会静默把两边算错。
    const extras = plan.extras.map(labelOf);
    const deduped = runs.filter((run) => !extras.includes(labelOf(run)));
    expect(deduped.length + plan.extras.length).toBe(runs.length);
    // 逐条对得上:同一条 run 不会既在链侧又在 extras 侧。
    for (const label of extras) expect(deduped.map(labelOf)).not.toContain(label);
    // 结论:门禁自测是链唯一漏掉的那一族。
    expect(extras).toEqual(["test:gates"]);
  });
});

/**
 * 本票最重要的判据:`D ⊆ F`。
 *
 * 默认计划的每一步,在收口计划(链 + extras)跑完之后都必须已经有人执行过。五个代表性改动覆盖
 * 三源的每一条腿:源码走图、数据文件与仓库事实走表、门禁实现走"表 + 独立 project(`-t` 子集)"。
 * 选择器自身也走图(T4:`packages/tools/src/scope` 不再拖门禁自测)。
 *
 * 为什么用**真实** `decide()` 而不是手搓 decision:坑恰恰出在两者之间——单看 `plan.ts` 都是对的,
 * 组合起来才漏(`gates` 不在链里)。手搓的 decision 会把这条漏掉。
 *
 * 断言分两问,顺序有意义:
 *
 * 1. 只靠链时,差集**恰为已知的那个洞**(`test:gates`;engine 源码 / 规则取值 / 根 package.json
 *    三处为空)。它证明"洞是真的",也证明补差集不是把所有东西都往 extras 里塞。
 * 2. `runs` 被「链已覆盖」与 `extras` **划分**:每一条要么已在链跑过,要么被 extras 补上;
 *    两边不重叠(重叠 = 同一批文件跑第二遍),也不遗漏(遗漏 = `D ⊄ F`)。
 *
 * T4 之后,这个洞的形状变了两处,断言跟着变——两处都不是"放宽",而是**预期变小**:
 *
 * - 选择器自身的改动**不再**进 gates(`src/scope` 交依赖图),所以它的差集是空的;
 * - 具体门禁实现的差集仍是 `test:gates`,但标签带着 `-t` 子集(模式引自 `GATES_CASES`,
 *   在这里不拄一份):收口计划补上的是那一批用例,不是整族。
 */
describe("五个代表性改动:D ⊆ F", () => {
  const cases: readonly {
    readonly label: string;
    readonly path: string;
    /** 只靠链时链漏掉的那几项(空 = 链自己就够了)。 */
    readonly chainGap: readonly string[];
  }[] = [
    {
      label: "engine 源码",
      path: "packages/engine/src/runner/quickjs.ts",
      chainGap: [],
    },
    {
      label: "规则取值 rulesets/v2.json",
      path: "rulesets/v2.json",
      chainGap: [],
    },
    {
      label: "选择器自身 packages/tools/src/scope/check.ts",
      path: "packages/tools/src/scope/check.ts",
      // T4:`src/scope` 的判据在 unit 池子里(图能选中),不再额外拖门禁自测。
      chainGap: [],
    },
    {
      label: "具体门禁实现 packages/tools/src/gate/no-float-gate.ts",
      path: "packages/tools/src/gate/no-float-gate.ts",
      // 差集仍是 gates 那一族,但收尾到那一道门禁的 `-t` 子集(模式引自 `GATES_CASES`)。
      chainGap: [
        `test:gates -t ${(GATES_CASES["packages/tools/src/gate/no-float-gate.ts"] ?? []).join("|")}`,
      ],
    },
    {
      label: "根 package.json",
      path: "package.json",
      chainGap: [],
    },
  ];

  it.each(cases)("$label", ({ path, chainGap }) => {
    expect(existsSync(join(repoRoot, path)), `${path} 不存在:这条断言盯的是真改动`).toBe(true);
    const decision = decideOn([path]);
    const runs = runsFor({ scripts, decision });
    const plan = fullPlan({ scripts, chain: FULL_CHAIN, runs });
    const extras = plan.extras.map(labelOf);

    // 第一问:链漏掉的恰好是 `chainGap`(不是"全都漏"也不是"一条不漏")。
    expect(uncoveredRuns({ scripts, chain: FULL_CHAIN, runs }).map(labelOf)).toEqual([...chainGap]);
    expect(extras).toEqual([...chainGap]);

    // 第二问:`runs` 被「链已覆盖」与「extras」划成两个不相交的集合,两侧合起来恰好是全体。
    //
    // 这里曾经是 `uncoveredRuns({..., extras})` 为空——那句是**恒真式**:`extras` 的定义就是
    // `fullPlan` 算出的没覆盖项,把它传回去当然一条不剩。它对任何实现都成立,所以那里真出
    // 问题也看不出来。下面三条换成可错的形状:
    const covered = chainProjects(scripts, FULL_CHAIN);
    const coveredScripts = chainScriptNames(scripts, FULL_CHAIN);
    const byChain = runs.filter((run) => isCovered(scripts, run, covered, coveredScripts));
    const byExtras = runs.filter((run) => extras.includes(labelOf(run)));

    // (a) 不遗漏:`D ⊆ F` —— 每一条要么链跑过了,要么 extras 补上了。
    expect(
      runs.filter((run) => !byChain.includes(run) && !byExtras.includes(run)).map(labelOf),
      `${path} 的默认计划里有一步收口计划不执行:更严格的验证反而少跑了`,
    ).toEqual([]);
    // (b) 不重复:已被链覆盖的 run 不在 extras 里(否则同一批文件跑第二遍)。
    expect(
      plan.extras.filter((run) => isCovered(scripts, run, covered, coveredScripts)).map(labelOf),
      "extras 里有链已经跑过的项:收口会把同一批文件执行两次",
    ).toEqual([]);
    // (c) 划分完整:`runs` 一条不多一条不少地落在两侧。
    expect(byChain.length + byExtras.length).toBe(runs.length);
  });
});
