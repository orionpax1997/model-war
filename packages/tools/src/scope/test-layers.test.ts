/**
 * 「改动半径」自身的判据。它盯的不是业务行为,而是**这套选择器还准不准**。
 *
 * 为什么选择器需要判据:漏一条规则的后果是「那部分代码改了却没人跑它的测试」,而它**不会**
 * 以报错的形式自己显形——恰恰相反,它会给出一个绿。所以这里用几条断言把两端都钉住:
 *
 * - 表里的规则必须**指向真实存在的路径**(写了一条没人命中的规则 = 你脑补了一个目录);
 * - 仓库顶层与每个包都必须在某一端的覆盖下(新增包、新增顶层目录即红);
 * - 源码改动必须能映射到产物(映射不出来就等于图看不见它,静默少选);
 * - 产物不在盘上时必须退回全量,而不是照旧少选。
 *
 * 这些全是静态读文件或纯函数调用,0.4s 级——便宜是因为它读的是**入库事实**,不是跑一遍。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOutputsOf, workspacesOf } from "./build-outputs.js";
import {
  ALWAYS,
  IGNORED_AREAS,
  RADIUS,
  SUITES,
  UnregisteredPathError,
  decide,
} from "./change-radius.js";
import { isInputPath, loadInputsMap } from "./test-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workspaces = workspacesOf(repoRoot);
const built = (): boolean => true;

const manifest = (): { scripts: Record<string, string> } =>
  JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

const unexplainable = (paths: readonly string[]): string => `\n  ${paths.join("\n  ")}`;

const decideOn = (paths: readonly string[]) => decide({ paths, workspaces, exists: built });

const configText = (): string =>
  readFileSync(fileURLToPath(new URL("../../../../vitest.config.ts", import.meta.url)), "utf8");

describe("表:引用的脚本与路径都真实存在", () => {
  it.each([...ALWAYS, ...SUITES, "test:related"])("%s 在 package.json 里", (script) => {
    expect(manifest().scripts[script], `package.json 里没有 ${script}`).toBeDefined();
  });

  it("规则里出现的 suite 都在 SUITES 里(没有偷偷多一个测试族)", () => {
    const allowed = new Set(SUITES);
    for (const rule of RADIUS) {
      for (const suite of rule.suites) {
        expect(allowed.has(suite), `${rule.area} 引用了未登记的测试族 ${suite}`).toBe(true);
      }
    }
  });

  it("每条规则指向的路径真实存在(写了一条没人命中的规则 = 脑补了一个目录)", () => {
    for (const rule of RADIUS) {
      expect(existsSync(join(repoRoot, rule.area)), `${rule.area} 在仓库里不存在`).toBe(true);
    }
  });

  it("每条规则都写了 why(读的人不必翻代码就能判断它该不该改)", () => {
    for (const rule of RADIUS) {
      expect(rule.why.length, `${rule.area} 的 why 太短,等于没写`).toBeGreaterThan(10);
    }
  });
});

describe("覆盖:仓库没有盲区", () => {
  it("根目录每个条目都被覆盖(新增顶层目录即红)", () => {
    const covered = new Set([...RADIUS.map((rule) => rule.area), ...IGNORED_AREAS]);
    // `apps` / `packages` 由下一条断言覆盖:它们的每个子包都必须有可映射的编译目录。
    const workspaceRoots = new Set(["apps", "packages"]);
    const uncovered = readdirSync(repoRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter(
        (name) =>
          !workspaceRoots.has(name) &&
          !covered.has(name) &&
          ![...covered].some((area) => area.startsWith(`${name}/`)),
      );
    expect(uncovered, `这些顶层条目没有规则:${uncovered.join(", ")}`).toEqual([]);
  });

  it("apps/ 与 packages/ 下的每个包都能进依赖图(有 tsconfig 的 rootDir/outDir)", () => {
    for (const parent of ["apps", "packages"]) {
      for (const child of readdirSync(join(repoRoot, parent))) {
        const dir = `${parent}/${child}`;
        expect(
          workspaces.some((workspace) => workspace.dir === dir),
          `${dir} 没有可映射的编译目录:它的源码改动进不了依赖图,选择器会静默少选`,
        ).toBe(true);
      }
    }
  });

  it("只产声明的包(packages/tools)只映射到 .d.ts,不许映射出不存在的 .js", () => {
    const tools = workspaces.find((workspace) => workspace.dir === "packages/tools");
    expect(
      tools?.emitDeclarationOnly,
      "packages/tools 的 emitDeclarationOnly 变了,映射要跟着改",
    ).toBe(true);
    const outputs = buildOutputsOf("packages/tools/src/scope/change-radius.ts", workspaces);
    expect(outputs).toEqual(["packages/tools/dist/scope/change-radius.d.ts"]);
  });

  it("每个包的源码都能映射到产物(映射是空的那条边就是断的)", () => {
    for (const workspace of workspaces) {
      const probe = `${workspace.dir}/${workspace.rootDir}/index.ts`;
      expect(
        existsSync(join(repoRoot, probe)),
        `${workspace.dir} 没有 ${workspace.rootDir}/index.ts`,
      ).toBe(true);
      expect(buildOutputsOf(probe, workspaces).length, `${probe} 映射不出产物`).toBeGreaterThan(0);
    }
  });
});

describe("decide:图与表各管半边", () => {
  it("只改散文时,一步测试都不用跑", () => {
    const decision = decideOn(["docs/hld.md"]);
    expect(decision.scripts).toEqual([...ALWAYS]);
    expect(decision.graphFiles).toEqual([]);
  });

  it("改引擎源码时交给图,并把源码与两个产物都递过去", () => {
    const decision = decideOn(["packages/engine/src/runner/quickjs.ts"]);
    expect(decision.scripts).toEqual([...ALWAYS]);
    expect(decision.graphFiles).toEqual([
      "packages/engine/dist/runner/quickjs.d.ts",
      "packages/engine/dist/runner/quickjs.js",
      "packages/engine/src/runner/quickjs.ts",
    ]);
  });

  it("改 tools 时额外跑门禁自测(它住在独立 project 里,图选不到)", () => {
    const decision = decideOn(["packages/tools/src/scope/build-outputs.ts"]);
    expect(decision.scripts).toContain("test:gates");
    expect(decision.graphFiles.length).toBeGreaterThan(0);
  });

  it("改规则取值时跑真 VM 那一族(数据文件进不了图)", () => {
    const decision = decideOn(["rulesets/basic.json"]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:vm"]);
    expect(decision.graphFiles).toEqual([]);
  });

  it("改依赖锁定文件时保守到全量", () => {
    expect(decideOn(["pnpm-lock.yaml"]).scripts).toEqual([...ALWAYS, "test:all"]);
  });

  it("多个路径取并集,顺序稳定(ALWAYS 先,其余按 SUITES)", () => {
    const decision = decideOn([
      "packages/tools/src/index.ts",
      "docs/hld.md",
      "rulesets/basic.json",
    ]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:vm", "test:gates"]);
  });

  it("全量被选中时把它的子集收掉(同一批文件不该跑第二遍)", () => {
    const decision = decideOn([
      "pnpm-lock.yaml",
      "rulesets/basic.json",
      "packages/tools/src/index.ts",
    ]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:gates", "test:all"]);
  });

  it("产物不在盘上时退回全量,而不是照旧少选", () => {
    const decision = decide({
      paths: ["packages/engine/src/runner/quickjs.ts"],
      workspaces,
      exists: () => false,
    });
    expect(decision.notBuilt.length).toBe(2);
    expect(decision.scripts).toEqual([...ALWAYS, "test:all"]);
  });

  it("没登记的路径**抛错**而不是跳过(静默跳过等于假绿)", () => {
    expect(() => decideOn(["future-pkg/src/index.ts"])).toThrow(UnregisteredPathError);
  });

  it("前缀不会误吞相邻名字(apps/cli 不该吃掉 apps/cli-tools)", () => {
    expect(() => decideOn(["apps/cli-tools/src/index.ts"])).toThrow(UnregisteredPathError);
  });
});

describe("链的组成:编辑循环窄,收口宽", () => {
  it("默认 test 不含真 VM / 进程级 e2e(否则每次业务改动都付 290s 的账)", () => {
    const test = manifest().scripts["test"] ?? "";
    expect(test).not.toContain("--project e2e");
    expect(test).not.toContain("--project vm");
  });

  it("收口的 verify 走单池 test:all,不是默认 test", () => {
    // 三腿的顺序也是判据:便宜的先跑,红了就在两秒内退出,不会先跑完 70s 的测试。
    expect((manifest().scripts["verify"] ?? "").split(" && ")).toEqual([
      "node --run quick",
      "node --run gate:static",
      "node --run test:all",
    ]);
  });

  it("test:all 就是老的全量口径:all + property", () => {
    const all = manifest().scripts["test:all"] ?? "";
    expect(all).toContain("--project all");
    expect(all).toContain("--project property");
    // 分片不许混进来:那会把同一批文件跑第二遍。
    expect(all).not.toContain("--project unit");
    expect(all).not.toContain("--project e2e");
    expect(all).not.toContain("--project vm");
  });

  it("收口用的 all 项目没有排除 e2e / vm", () => {
    const config = configText();
    const start = config.indexOf('name: "all"');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = config.slice(start);
    const next = rest.indexOf('name: "', 10);
    const block = next < 0 ? rest : rest.slice(0, next);
    expect(block).not.toContain("E2E_TESTS");
    expect(block).not.toContain("VM_TESTS");
  });

  it("每个 project 都至少被一条命名脚本覆盖", () => {
    const config = configText();
    const projects = [...config.matchAll(/name: "([a-z]+)"/g)].map((match) => match[1] ?? "");
    expect(projects.length).toBeGreaterThan(5);
    const scripts = manifest().scripts;
    for (const project of projects) {
      const covered = Object.entries(scripts).some(
        ([name, command]) =>
          (name.startsWith("test") || name.startsWith("verify")) &&
          command.includes(`--project ${project}`),
      );
      expect(covered, `没有任何 test*/verify* 脚本会跑 project ${project}`).toBe(true);
    }
  });
});

/**
 * 观测 map(ADR-0038 第三条)自己的判据。
 *
 * 它盯的是这个机制**还活着**,以及它记下的东西**都能被解释**。后一条比它看起来重要:map 是
 * 判据的输入,一条无法解释的输入意味着选择器对它是瞎的——而"瞎"的表现是少跑,不是报错。
 * 换句话说,这条断言把「我没想到的第四类输入」从"不可能发现"变成"下一次录就红"。
 */
describe("观测 map:它自己也要有判据", () => {
  const map = loadInputsMap(repoRoot);
  const inputs = [...new Set(Object.values(map.files).flat())];

  it("map 非空,且键都是仓库里真实存在的测试文件(空 map 等于观测没接上)", () => {
    const keys = Object.keys(map.files);
    expect(
      keys.length,
      "观测 map 是空的:recorder 没装上,或 execArgv 没接进 worker",
    ).toBeGreaterThan(20);
    expect(inputs.length, "一条输入都没记到,观测没有实际作用").toBeGreaterThan(50);
    const missing = keys.filter((key) => !existsSync(join(repoRoot, key)));
    expect(missing, `这些键不是真实的测试文件:${missing.join(", ")}`).toEqual([]);
  });

  it("每个被观测到的输入都能被选择器解释(没有第四类输入)", () => {
    const unexplained: string[] = [];
    for (const input of inputs) {
      try {
        decide({ paths: [input], workspaces, exists: built });
      } catch {
        unexplained.push(input);
      }
    }
    expect(
      unexplained,
      "这些输入被读到过,但选择器对它们没有说法——加一条 RADIUS 规则或让它能被映射:" +
        unexplainable(unexplained),
    ).toEqual([]);
  });

  it("map 里没有混进产物路径(报告与对局产物不是输入)", () => {
    expect(inputs.filter((input) => !isInputPath(input))).toEqual([]);
  });

  it("recorder 挂在 worker 的 execArgv 上(拆掉它 map 会静默变空)", () => {
    const config = configText();
    expect(config).toContain("poolOptions: { forks: { execArgv: RECORD_EXEC_ARGV } }");
    expect(config, "recorder 的装载位置不在 config 里").toContain("RECORD_SETUP");
    expect(config, "收口那次跑(all)必须带录制开关").toContain("RECORD_EXEC_ARGV");
  });
});
