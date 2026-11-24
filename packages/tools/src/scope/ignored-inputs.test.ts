/**
 * 「测试不许依赖 git 忽略的本机状态」的判据自测:纯函数的行为、反方向能红、以及入库事实的自洽。
 *
 * ── 为什么落 `unit` 而不是 `gates` ──
 * 它一条测试都不 spawn(只读两份入库 JSON、过一遍 `git check-ignore`、读几行源码),
 * 放在 `packages/tools/src/scope/` 就落进 `unit`,跟着默认链 `pnpm run test` 在 PR 上生效,
 * 而不是等人想起 `pnpm run test:gates`。门禁入口本身(`run-ignored-inputs-gate.ts`)在
 * `gate:static` 上;两侧跑的是同一份判据,这里额外负责「反例真的会红」。
 *
 * ── 这一份盯的是什么 ──
 * 1. **两类不许一刀切**:派生必须放行,本机状态必须红。
 * 2. **反方向**:把 `archive` 塞进派生白名单 → `swallowedLocalState` 点名;往命中里塞一条
 *    没有登记的忽略路径 → `uncovered` 点名;**空登记表不许当全过**。
 * 3. **登记表口径**:幽灵条目(行号漂了 / 字面量不在 / 文件没了)、过期条目(不再覆盖任何命中)、
 *    空理由,三种都红。
 * 4. **入库事实**:真实 map + 真实登记表 + 真实 git 判下来是干净的;派生白名单非空、每条探针
 *    今天仍被忽略;并且这道门禁真的挂在 `gate:static` 上。
 *
 * ── 反例为什么改文本而不改文件 ──
 * 与 `gate/vacuous.test.ts` 同一条纪律:反例要能现做现验,但不该把仓库树弄脏。所以幽灵 /
 * 过期 / 吞本机状态全部走**注入的 `sourceLine` 与伪造的规则表**,而真实文件那一侧只读不改。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DERIVED_RULES,
  type DerivedRule,
  type Hit,
  LOCAL_STATE_PROBES,
  type RegistryEntry,
  REGISTRY_PATH,
  REGISTRY_SCHEMA,
  covers,
  isDerived,
  judgeIgnoredInputs,
  mentionsPathEnd,
  observedInputs,
  swallowedLocalState,
} from "./ignored-inputs.js";
import { INPUTS_MAP_PATH, loadInputsMap } from "./test-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 读一个仓库相对路径的文本(不在就抛:读不到不该被当成空)。 */
const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), "utf8");

/** 真实源文件的第 `line` 行(1 起);越界 → `undefined`。 */
const realSourceLine = (file: string, line: number): string | undefined =>
  read(file).split("\n")[line - 1];

describe("两类不许一刀切", () => {
  it("派生类放行:dist / node_modules / tsbuildinfo / 工具临时目录", () => {
    expect(isDerived("packages/engine/dist/index.js")).toBe(true);
    expect(isDerived("apps/cli/node_modules/@model-war/engine/dist/package.json")).toBe(true);
    expect(isDerived("packages/engine/tsconfig.tsbuildinfo")).toBe(true);
    expect(isDerived(".vitest/report.json")).toBe(true);
    expect(isDerived(".stryker-tmp/sandbox-1/index.js")).toBe(true);
  });

  it("本机状态 / 产物 / 配置一律不是派生(探针表逐条断言)", () => {
    for (const probe of LOCAL_STATE_PROBES) {
      expect(isDerived(probe), `${probe} 被判成了派生,它不在任何 clone 里`).toBe(false);
    }
  });

  it("前缀不误吞相邻名字:dist 只认整段路径", () => {
    // `distribution.ts` 不是 `dist/` 下的产物;按字符串前缀匹配会把它吞进来。
    expect(isDerived("packages/runner/src/distribution.ts")).toBe(false);
    expect(isDerived("packages/runner/src/nodes_modules.ts")).toBe(false);
  });
});

describe("反方向:白名单会红", () => {
  it("真实白名单没有吞掉任何一类本机状态", () => {
    expect(swallowedLocalState(DERIVED_RULES)).toEqual([]);
  });

  it("把 archive 塞进派生白名单 → 点名(白名单不能被用来让本机状态过门)", () => {
    const widened: readonly DerivedRule[] = [
      ...DERIVED_RULES,
      { kind: "segment", value: "archive", probe: "archive/probe.js", why: "反例:不该成立" },
    ];
    const swallowed = swallowedLocalState(widened);
    expect(swallowed, "把 archive 加进白名单之后一条都没点名:这道反例不成立").not.toEqual([]);
    expect(swallowed).toContain("archive/claude-opus-5-5/meta.json");
    // 反例只影响注入的表,真实白名单不变。
    expect(swallowedLocalState(DERIVED_RULES)).toEqual([]);
  });

  it("白名单非空:空表会让「派生放行」这条判据静默消失", () => {
    expect(DERIVED_RULES.length).toBeGreaterThan(0);
  });
});

describe("登记表口径", () => {
  const entry: RegistryEntry = {
    test: "packages/x/src/a.test.ts",
    line: 7,
    path: "archive/a",
    reason: "反例用的登记",
  };
  const hit: Hit = { test: "packages/x/src/a.test.ts", path: "archive/a/r1/script.js" };

  it("前缀覆盖带 `/`:archive/a 覆盖 archive/a/r1.js,不覆盖 archive/ab.js", () => {
    expect(covers(entry, hit)).toBe(true);
    expect(covers(entry, { ...hit, path: "archive/ab/r1.js" })).toBe(false);
    // 别的测试文件读到同一路径不算覆盖:豁免按测试文件给,不按路径给。
    expect(covers(entry, { ...hit, test: "packages/y/src/b.test.ts" })).toBe(false);
  });

  it("命中没有登记 → uncovered 点名(门禁红的那一行)", () => {
    const judgment = judgeIgnoredInputs({
      hits: [hit],
      registry: [],
      sourceLine: () => undefined,
    });
    expect(judgment.uncovered).toEqual([hit]);
  });

  it("空登记表不许当全过:没有条目时每条命中都自己红", () => {
    const hits: readonly Hit[] = [hit, { ...hit, path: "archive/b/r2/script.js" }];
    const judgment = judgeIgnoredInputs({
      hits,
      registry: [],
      sourceLine: realSourceLine,
    });
    expect(judgment.uncovered).toHaveLength(2);
    // 空登记表不是「全过」,也不是「全红」:它把判决交回给命中本身。
    expect(judgment.problems).toEqual([]);
  });

  it("登记覆盖住命中 → 不报 uncovered", () => {
    const judgment = judgeIgnoredInputs({
      hits: [hit],
      registry: [entry],
      sourceLine: () => '  join(root, "archive", "a", "r1");',
    });
    expect(judgment.uncovered).toEqual([]);
    expect(judgment.problems).toEqual([]);
  });

  it("幽灵条目①:行号上读不到东西(文件没了 / 行号越界)→ 红", () => {
    const judgment = judgeIgnoredInputs({
      hits: [hit],
      registry: [entry],
      sourceLine: () => undefined,
    });
    expect(judgment.problems.map((problem) => problem.kind)).toEqual(["ghost"]);
    expect(judgment.problems[0]?.detail).toContain("行号越界");
  });

  it("幽灵条目②:那一行里没有这条路径的末段字面量 → 红", () => {
    const judgment = judgeIgnoredInputs({
      hits: [hit],
      registry: [entry],
      sourceLine: () => "  const unrelated = 1;",
    });
    expect(judgment.problems.map((problem) => problem.kind)).toEqual(["ghost"]);
  });

  it("过期条目:不再覆盖任何命中 → 红(过期豁免比没有更坏)", () => {
    const judgment = judgeIgnoredInputs({
      hits: [{ ...hit, path: "archive/other/r9/script.js" }],
      registry: [entry],
      sourceLine: () => '  join(root, "archive", "a", "r1");',
    });
    // 命中侧红一次(没登记的路径)、登记侧红一次(过期),两边都要出声。
    expect(judgment.uncovered).toHaveLength(1);
    expect(judgment.problems.map((problem) => problem.kind)).toEqual(["stale"]);
    expect(judgment.problems[0]?.detail).toContain("删掉它");
  });

  it("空理由等于没登记 → 红", () => {
    const judgment = judgeIgnoredInputs({
      hits: [hit],
      registry: [{ ...entry, reason: "   " }],
      sourceLine: () => '  join(root, "archive", "a", "r1");',
    });
    expect(judgment.problems.map((problem) => problem.kind)).toEqual(["no-reason"]);
  });
});

describe("定位判据(末段字面量)", () => {
  it("整串写法与 join 拆行写法都算定位;注释里提一句不算", () => {
    expect(mentionsPathEnd('  const p = "archive/a/r1/meta.json";', "archive/a/r1/meta.json")).toBe(
      true,
    );
    expect(
      mentionsPathEnd('  join(root, "archive", "a", "meta.json"),', "archive/a/meta.json"),
    ).toBe(true);
    // 无引号的出现(注释、散文、标识符)不承认:那不是「这一行在说这件事」。
    expect(mentionsPathEnd("  // 见 archive/a/meta.json", "archive/a/meta.json")).toBe(false);
    expect(mentionsPathEnd("  const metadata = 1;", "archive/a/meta.json")).toBe(false);
  });

  it("空路径定位不到(空 path 不许当成覆盖一切)", () => {
    expect(mentionsPathEnd('  "archive",', "")).toBe(false);
    expect(covers({ test: "t", line: 1, path: "", reason: "r" }, { test: "t", path: "" })).toBe(
      false,
    );
  });
});

describe("入库事实:真实 map + 真实登记表 + 真实 git", () => {
  /**
   * 真实的一次 `git check-ignore --stdin --no-index`。退出码 0/1 是判据,其它一律抛:
   * 折算成「没被忽略」会让这条断言在最该红的地方变绿。
   */
  const gitIgnored = (paths: readonly string[]): ReadonlySet<string> => {
    const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index"], {
      cwd: repoRoot,
      input: `${paths.join("\n")}\n`,
      encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore 退出码 ${String(result.status)}:${result.stderr}`);
    }
    return new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  };

  const observed = observedInputs(loadInputsMap(repoRoot));
  const candidates = [
    ...new Set(observed.filter((hit) => !isDerived(hit.path)).map((hit) => hit.path)),
  ].sort();
  const ignored = gitIgnored(candidates);
  const hits = observed.filter((hit) => ignored.has(hit.path));

  const registryFile = JSON.parse(read(REGISTRY_PATH)) as {
    version?: number;
    entries?: readonly RegistryEntry[];
  };
  const registry = registryFile.entries ?? [];

  it("枚举自证:map 读得出东西,且过了一遍 git(否则下面的「干净」是空的)", () => {
    expect(observed.length, `${INPUTS_MAP_PATH} 一条输入都没读到`).toBeGreaterThan(100);
    // 被忽略的路径存在过;它全空也不能证明判据成立,所以计数下界取一个保守值。
    expect(candidates.length).toBeGreaterThan(0);
    expect(registryFile.version).toBe(REGISTRY_SCHEMA);
  });

  it("真实树上没有未登记的忽略输入,也没有幽灵 / 过期 / 缺理由的登记", () => {
    const judgment = judgeIgnoredInputs({ hits, registry, sourceLine: realSourceLine });
    expect(
      judgment.uncovered.map((hit) => `${hit.test} ← ${hit.path}`),
      "有测试读到 git 忽略的本机状态,却不在登记表里",
    ).toEqual([]);
    expect(
      judgment.problems.map(
        (problem) => `${problem.kind}:${problem.entry.test}:${String(problem.entry.line)}`,
      ),
    ).toEqual([]);
  });

  it("每条登记的路径今天仍然真的被 git 忽略(否则豁免在替一条已入库的路径开洞)", () => {
    const stillIgnored = gitIgnored(registry.map((entry) => entry.path));
    for (const entry of registry) {
      expect(stillIgnored.has(entry.path), `${entry.path} 已经不被 git 忽略了`).toBe(true);
    }
  });

  it("派生白名单每条的探针今天仍被 .gitignore 命中", () => {
    const probes = gitIgnored(DERIVED_RULES.map((rule) => rule.probe));
    for (const rule of DERIVED_RULES) {
      expect(probes.has(rule.probe), `${rule.value} 的探针 ${rule.probe} 不再被忽略`).toBe(true);
    }
  });

  it("门禁挂在 gate:static 上(快链),且没被挪进按需链", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    expect(scripts["gate:static"] ?? "", "门禁不在 gate:static 里").toContain(
      "packages/tools/src/scope/run-ignored-inputs-gate.ts",
    );
    // 它不进 check 自己的链:选择器不为一道静态门禁付一次进程钱(判据住在脚本清单里)。
    expect(scripts["check"] ?? "", "门禁被塞进了 check").not.toContain(
      "run-ignored-inputs-gate.ts",
    );
  });
});
