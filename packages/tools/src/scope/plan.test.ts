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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspacesOf } from "./build-outputs.ts";
import { GATES_CASES, decide } from "./change-radius.ts";
import { FULL_CHAIN, labelOf, runsFor } from "./check.ts";
import {
  PROJECT_CONTAINS,
  chainScriptNames,
  chainProjects,
  fullPlan,
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

const configText = (): string => readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");

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

  it("PROJECT_CONTAINS 与 vitest.config.ts 对得上,且 gates 不在任何父池子里", () => {
    const config = configText();
    const names = new Set(
      [...config.matchAll(/name: "([a-z0-9]+)"/gu)].map((match) => match[1] ?? ""),
    );
    for (const [parent, children] of Object.entries(PROJECT_CONTAINS)) {
      expect(names.has(parent), `vitest.config.ts 里没有 project ${parent}`).toBe(true);
      for (const child of children) {
        expect(names.has(child), `vitest.config.ts 里没有 project ${child}`).toBe(true);
      }
    }
    // 包含关系的**内容**也是事实:`all` 的 include 就是 unit ∪ e2e ∪ vm 那一批文件,
    // 它排除的只有 gates / slow / sandbox / gen-cli —— 所以 `gates` 永远不会被吞掉。
    expect(Object.values(PROJECT_CONTAINS).flat()).not.toContain("gates");
    const start = config.indexOf('name: "all"');
    const block = config.slice(start, config.indexOf('name: "unit"', start));
    expect(block).not.toContain("E2E_TESTS");
    expect(block).not.toContain("VM_TESTS");
    // 而 unit 才是排掉 e2e/vm 的那一个:反过来验证一下切片没错位。
    expect(configText().slice(configText().indexOf('name: "unit"'))).toContain("VM_TESTS");
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
    const deduped = runs.filter((run) => !plan.extras.includes(run));
    expect(deduped.length + plan.extras.length).toBe(runs.length);
    // 逐条对得上:同一个 RunItem 不会既在链侧又在 extras 侧。
    for (const item of plan.extras) expect(deduped).not.toContain(item);
    // 结论:门禁自测是链唯一漏掉的一族。
    expect(plan.extras.map(labelOf)).toEqual(["test:gates"]);
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
 * 2. 链 + extras 之后**一条不剩**:`D ⊆ F` 成立。
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

    // 第一问:链漏掉的恰好是 `chainGap`(不是"全都漏"也不是"一条不漏")。
    expect(uncoveredRuns({ scripts, chain: FULL_CHAIN, runs }).map(labelOf)).toEqual([...chainGap]);
    expect(plan.extras.map(labelOf)).toEqual([...chainGap]);

    // 第二问:链 + extras 之后一条不剩 —— 这就是 `D ⊆ F` 的机器表达。
    expect(
      uncoveredRuns({ scripts, chain: FULL_CHAIN, runs, extras: plan.extras }),
      `${path} 的默认计划里有一步收口计划不执行:更严格的验证反而少跑了`,
    ).toEqual([]);
  });
});
