/**
 * gen 包的依赖边界测试(FR-5 AC1;hld §3.2、§6.2、§2.2.10)。
 *
 * AC1 的原文是「管线全程只回喂静态校验错误,代码中不存在将对局结果传回生成环节的路径」
 * (srs FR-5 AC1;hld §6.2 写作「`gen` 代码中不存在对战结果回传路径」)。它是一个「不存在」断言,
 * 而「不存在」只能被机器门禁证明。这句话的可执行化有**互不可替代**的两半:
 *
 * 1. 包图那一半(本文件):`gen` 不得 import engine / runner / replay。engine 持有对局结果类型
 *    (`RunMatchParams` / `RunMatchResult`),runner 跑对局并把产物落 `runs/`,replay 读对局产物——
 *    三条边各是一条能把对局结果带回生成环节的通路。断言方式是机器门禁本身:spawn `depcruise`
 *    跑真实配置(`check:deps` 的同一条),退出码非零即为违规。规则名见 `.dependency-cruiser.js`。
 * 2. 源码符号那一半(`no-match-result-symbols.test.ts`):`gen` 运行时代码里不得出现对局结果符号。
 *    它不看构建产物,补上门禁看不见的那些字面量——`runs/` 这种字符串没有跨包边。
 *
 * ── 「现在绿」本身不证明任何东西:两种已知的静默失效与它们的反证 ──
 *   a. 图是空的。depcruise 在本仓库没有能用的 TS 编译器,直接巡航 `src` 会写「0 modules」并退出 0
 *      (`.dependency-cruiser.js` 头注与 hld §2.2.10 的实验事实 2)。若连 `packages/gen/dist` 都没 build,
 *      本包的规则不是「通过」而是**根本没跑**,报告却一样是绿的。反证落在下面的用例里:
 *      「巡航入口必须含 `packages/gen/dist`」+「巡航规模不为零」两条断言。
 *   b. 规则没挂上(名字写错、`from` 条件写偏、交替式只写了半边),此时图再完整也永远是绿的。
 *      这条的反证方式是**真注入一条违规 import 再撤掉**,但它的家不在本文件:
 *      `packages/tools/src/gates.test.ts` 的「依赖门禁反例」一节按需跑(`pnpm run test:gates`),
 *      engine / runner 那两条反例也在那里。为什么不能放在这里:本文件跑在 `unit`,
 *      与 engine 的同一支测试**并行**,而那边的 depcruise 巡航的是同一张全图——
 *      往 `packages/gen/dist` 里放探针,会让那次巡航在列目录与读文件之间少掉一个文件
 *      (实测 `ENOENT ... __gate-probe.js`,红的却是 engine 的测试)。
 *
 * 断言的只有可外部观察的东西:`depcruise` 的退出码与它的报告文本,不碰任何内部形状。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = here("../../../");
const genDist = here("../dist/");

/**
 * 巡航入口与 `check:deps` 的命令行参数同一范围(`packages` 与 `apps` 下各包的 `dist` 目录),但这里由目录列举得出。
 * 不把它抄成一份字面量清单:那种写法要求每加一个包就回来改一次,漏改时测试还是绿的——
 * 而它绿的恰好是「巡航到的图少了这个包」这件事,不是真绿。
 * 判据是同一个:包的 `dist` 里有 `.js`(只产 `.d.ts` 的 `tools` 因此自然不在图里)。
 *
 * 写成函数而不是顶层常量:`dist` 可能还没 build,而 tsc -b 的兜底在用例里发生。
 */
const cruiseEntries = (): string[] =>
  ["packages", "apps"].flatMap((root) =>
    readdirSync(here(`../../../${root}/`), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${root}/${entry.name}/dist`)
      .filter(
        (dir) =>
          existsSync(here(`../../../${dir}/`)) &&
          readdirSync(here(`../../../${dir}/`)).some((name) => name.endsWith(".js")),
      ),
  );

const runDepcruise = (): { status: number; output: string } => {
  const result = spawnSync(here("../../../node_modules/.bin/depcruise"), cruiseEntries(), {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

it("gen 的运行时代码不 import engine / runner / replay", () => {
  // depcruise 巡航的是 tsc -b 的产物(本仓库没有它能用的 TS 编译器,见 .dependency-cruiser.js 顶部),
  // 所以 dist 必须先在。`check:deps` 自带 tsc -b,vitest 的 globalSetup 也补一次;
  // 这里只在裸跑本文件时兜底,起法与 vitest.global-setup.ts 一致(process.execPath + tsc 入口)。
  if (!existsSync(genDist)) {
    const build = spawnSync(
      process.execPath,
      [here("../../../node_modules/typescript/bin/tsc"), "-b", "--pretty", "false"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(build.status, `tsc -b 失败:\n${build.stdout}${build.stderr}`).toBe(0);
  }

  // 反证 a1:gen 自己必须在巡航图里。缺了它,下面的退出码 0 只说明「别的包没违规」,
  // 与本票要断言的 gen 规则无关——`dist` 没 build 时正是这种假绿(而 globalSetup 刚 build 过)。
  expect(cruiseEntries(), "gen 的 dist 不在巡航入口里,gen 那条规则等于没跑").toContain(
    "packages/gen/dist",
  );

  const result = runDepcruise();
  expect(result.status, `依赖门禁不通过:\n${result.output}`).toBe(0);

  // 反证 a2:报告里必须真的有图。depcruise 缺 TS 编译器时会写「0 modules, 0 dependencies cruised」
  // 并退出 0——一条永远全绿、什么也没断言的假门禁(hld §2.2.10 的实验事实 2)。
  const cruised = /(\d+) modules, (\d+) dependencies cruised/.exec(result.output);
  expect(cruised, `依赖门禁没有报告巡航规模,疑似空跑:\n${result.output}`).not.toBeNull();
  expect(Number(cruised?.[1] ?? "0"), "巡航到的模块数为 0,门禁空跑").toBeGreaterThan(0);
});
