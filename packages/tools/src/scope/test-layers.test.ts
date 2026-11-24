/**
 * 「改动半径表」自身的判据。它盯的不是业务行为,而是**这张表还准不准**。
 *
 * 为什么表需要判据:漏一条规则的后果是「那部分代码改了却没人跑它的测试」,而它**不会**以报错
 * 的形式自己显形——恰恰相反,它会给出一个绿。这与 `gate:landings` 被删掉的理由是同一个形状:
 * 一条只证明"我对了"而不证明"我真的验了"的机制,比没有更坏。所以这里用四条断言把表钉住。
 *
 * 四条:
 * 1. 表里引用的每个脚本名都真实存在于 `package.json`(改名即红,不是等 `spawn` 才报 Unknown script);
 * 2. 仓库顶层每个条目都被某条规则或 `IGNORED_AREAS` 覆盖(新增包 / 新增顶层目录即红);
 * 3. `vitest.config.ts` 里每个 project 都有能跑到它的命名脚本(新增 project 而没人会跑它即红);
 * 4. 收口用的 `all` 项目**没有**排除 e2e / vm(`all` 一旦漏掉,收口就不是全量了)。
 *
 * 这些全是静态读文件,0.1s 级——之所以能这么便宜,是因为它读的是**入库事实**而不是跑一遍。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALWAYS,
  IGNORED_AREAS,
  RADIUS,
  SUITES,
  UnregisteredPathError,
  planFor,
} from "./change-radius.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const manifest = (): { scripts: Record<string, string> } =>
  JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
const configText = (): string =>
  readFileSync(fileURLToPath(new URL("../../../../vitest.config.ts", import.meta.url)), "utf8");

/** `vitest.config.ts` 里某个 project 的那一段(从 `name:` 到下一个 `name:`)。 */
const projectBlockOf = (config: string, name: string): string => {
  const start = config.indexOf(`name: "${name}"`);
  expect(start, `vitest.config.ts 里找不到 project ${name}`).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start);
  const next = rest.indexOf('name: "', 10);
  return next < 0 ? rest : rest.slice(0, next);
};

const projectNames = (): readonly string[] => {
  const config = configText();
  return [...config.matchAll(/name: "([a-z]+)"/g)].map((match) => match[1] ?? "");
};

describe("改动半径表:引用的脚本都真实存在", () => {
  it.each([...ALWAYS, ...SUITES])("%s 在 package.json 里", (script) => {
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

  it("每条规则都写了 why(读的人不必翻代码就能判断它该不该改)", () => {
    for (const rule of RADIUS) {
      expect(rule.why.length, `${rule.area} 的 why 太短,等于没写`).toBeGreaterThan(10);
    }
  });
});

describe("改动半径表:仓库顶层没有盲区", () => {
  it("根目录每个条目都被覆盖(新增包 / 新增顶层目录即红)", () => {
    const covered = new Set([...RADIUS.map((rule) => rule.area), ...IGNORED_AREAS]);
    const rootEntries = readdirSync(repoRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".git" + "") || name === ".githooks");
    const uncovered = rootEntries.filter(
      (name) => !covered.has(name) && ![...covered].some((area) => area.startsWith(`${name}/`)),
    );
    expect(uncovered, `这些顶层条目没有规则:${uncovered.join(", ")}`).toEqual([]);
  });

  it("apps/ 与 packages/ 下的每个子目录都被覆盖", () => {
    const areas = new Set(RADIUS.map((rule) => rule.area));
    for (const parent of ["apps", "packages"]) {
      const children = readdirSync(
        fileURLToPath(new URL(`../../../../${parent}/`, import.meta.url)),
      );
      for (const child of children) {
        expect(areas.has(`${parent}/${child}`), `${parent}/${child} 没有规则`).toBe(true);
      }
    }
  });
});

describe("改动半径表:每个 project 都有人会跑", () => {
  it.each(projectNames())("project %s 至少被一条命名脚本覆盖", (project) => {
    const scripts = manifest().scripts;
    const covered = Object.entries(scripts).some(([name, command]) =>
      name.startsWith("test") || name.startsWith("verify")
        ? command.includes(`--project ${project}`)
        : false,
    );
    expect(covered, `没有任何 test*/verify* 脚本会跑 project ${project}`).toBe(true);
  });

  it("收口用的 all 项目没有排除 e2e / vm", () => {
    const block = projectBlockOf(configText(), "all");
    // 收口的定义就是"全量";漏掉一族时它仍然是绿的,但已经不再覆盖那些用例了。
    expect(block).not.toContain("E2E_TESTS");
    expect(block).not.toContain("VM_TESTS");
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
});

describe("planFor:拿不准就往多的写,不知道就红", () => {
  it("改 docs 只跑 ALWAYS(散文不牵扯对局)", () => {
    expect(planFor(["docs/hld.md"]).scripts).toEqual([...ALWAYS]);
  });

  it("改引擎要带上真 VM 那一族", () => {
    expect(planFor(["packages/engine/src/runner/quickjs.ts"]).scripts).toEqual([
      ...ALWAYS,
      "test",
      "test:vm",
    ]);
  });

  it("改 CLI 要带上进程级 e2e", () => {
    expect(planFor(["apps/cli/src/index.ts"]).scripts).toEqual([...ALWAYS, "test", "test:e2e"]);
  });

  it("改依赖锁定文件时保守到三族全跑", () => {
    expect(planFor(["pnpm-lock.yaml"]).scripts).toEqual([...ALWAYS, "test", "test:vm", "test:e2e"]);
  });

  it("多个路径取并集,顺序稳定(ALWAYS 先,其余按 SUITES)", () => {
    const plan = planFor(["apps/cli/src/index.ts", "docs/hld.md", "packages/engine/src/index.ts"]);
    expect(plan.scripts).toEqual([...ALWAYS, "test", "test:vm", "test:e2e"]);
  });

  it("没登记的路径**抛错**而不是跳过(静默跳过等于假绿)", () => {
    expect(() => planFor(["apps/cli/src/index.ts", "future-pkg/src/index.ts"])).toThrow(
      UnregisteredPathError,
    );
  });

  it("前缀不会误吞相邻名字(apps/cli 不该吃掉 apps/cli-tools)", () => {
    expect(() => planFor(["apps/cli-tools/src/index.ts"])).toThrow(UnregisteredPathError);
  });
});
