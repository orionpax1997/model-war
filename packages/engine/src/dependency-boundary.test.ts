/**
 * engine 包的依赖边界测试(hld §2.2.8 / §3.2)。
 *
 * 这个文件身兼两职,两件都是真的:
 *
 * 1. 它是 engine 侧的一条真实断言——engine 的**运行时代码**不得 import `node:crypto`
 *    以外的任何内置模块,也不得 import runner/gen。断言方式是机器门禁本身:
 *    spawn `depcruise` 跑真实配置,退出码非零即为违规。
 * 2. 它同时是「依赖规则只作用于运行时代码」这一条的**反例载体**:本文件读盘(`node:fs`)
 *    并 spawn 子进程(`node:child_process`),而这两件事在 engine 的运行时代码里一律禁止。
 *    依赖门禁必须对它网开一面;若哪天有人把门禁的作用域改成整个包,这个文件会第一个红。
 *
 * 断言的只有可外部观察的东西——`depcruise` 的退出码与它的报告文本,不碰任何内部形状。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = here("../../../");
const engineDist = here("../dist/");

/**
 * 巡航入口与 `check:deps` 完全一致(取自根 package.json 的那条脚本),
 * 这里重述一遍是为了让「本测试跑的到底是哪片图」写在文件里而不是靠记忆。
 */
const cruiseEntries = [
  "packages/schema/dist",
  "packages/replay/dist",
  "packages/engine/dist",
  "packages/runner/dist",
  "packages/gen/dist",
  "apps/cli/dist",
];

const runDepcruise = (): { status: number; output: string } => {
  const result = spawnSync(here("../../../node_modules/.bin/depcruise"), cruiseEntries, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

it("engine 的运行时代码只 import node:crypto 一个内置模块", () => {
  // depcruise 巡航的是 tsc -b 的产物(它在本仓库没有可用的 TS 编译器,见 .dependency-cruiser.js 顶部),
  // 所以 dist 必须先在。门禁脚本自己带 tsc -b,这里只在裸跑 vitest 时兜一次底。
  if (!existsSync(engineDist)) {
    const build = spawnSync(
      here("../../../node_modules/typescript/bin/tsc"),
      ["-b", "--pretty", "false"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(build.status, `tsc -b 失败:\n${build.stdout}${build.stderr}`).toBe(0);
  }

  const result = runDepcruise();
  expect(result.status, `依赖门禁不通过:\n${result.output}`).toBe(0);

  // 反面证据:报告里必须真的有图。若 depcruise 静默跳过 .ts(depcruise 缺 TS 编译器时的行为),
  // 报告会写着 0 modules,而那是一条永远全绿、什么也没断言的假门禁。
  const cruised = /(\d+) modules, (\d+) dependencies cruised/.exec(result.output);
  expect(cruised, `依赖门禁没有报告巡航规模,疑似空跑:\n${result.output}`).not.toBeNull();
  expect(Number(cruised?.[1] ?? "0")).toBeGreaterThan(5);

  // 本文件自己就 import 了 node:fs 与 node:child_process,编译产物里必须留着这两条。
  // 它们必须在图里(否则「豁免」只是因为边被裁掉了,不是真的豁免),同时不得出现在违规列表里。
  const emittedTestModule = readFileSync(`${engineDist}dependency-boundary.test.js`, "utf8");
  expect(emittedTestModule).toContain("node:child_process");
  expect(emittedTestModule).toContain("node:fs");
  expect(result.output).not.toContain("engine-runtime-only-allows-node-crypto");
});

it("engine 的运行时代码源码里没有第二个 node: 内建模块 import", () => {
  // 与上面的门禁互为交叉验证:门禁看编译产物,这里直接看源码。
  // 写进测试文件里的 import 由本用例豁免(依赖门禁只管运行时代码)。
  const sources = readdirSync(here("./"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(here(name), "utf8"))
    .join("\n");

  const builtins = new Set([...sources.matchAll(/["'](node:[a-z_/]+)["']/g)].map((m) => m[1]));
  for (const builtin of builtins) {
    expect(builtin, "engine 运行时代码只允许 node:crypto").toBe("node:crypto");
  }
});
