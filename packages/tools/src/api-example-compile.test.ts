/**
 * 面向模型的 API 文档里**每一个可运行示例都真编译过**——用参赛脚本那份编译配置。
 *
 * ── 为什么这道缝重要 ───────────────────────────────────────────────────────────
 * `docs/rules-v1/api.md` 是**直接进 prompt** 的:模型照着它写脚本,它里面的示例就是模型心里的
 * 「正确写法」。散文读起来对,模型写出来的代码仍可能编译不过(`noUncheckedIndexedAccess` 下
 * `arr[i].x` 一句就够),而这一层没有任何东西看守:§3/§4/§5 之外的散文按设计不被逐字节比。
 * 这道缝把散文从「读起来对」变成「跑起来对」——它红一次,就有人回来改文档。
 *
 * ── 「可运行示例」怎么认,不靠人维护一份清单 ───────────────────────────────────
 * 判据是**块里声明了顶层入口 `function loop(`**:入口声明是契约里唯一一句「这是一份完整脚本」的话,
 * 块里没有它就不是可运行示例,只是一个片段(比如 §3 里那个两行的判别片段)。
 * 用内容判而不用「受判节清单」,是因为清单会被忘记:新写一节示例的人不会记得去登记它,
 * 而登记这件事一旦漏了,那道缝就在那一节上静默失效。内容判没有这个漏法。
 *
 * ── 类型面已回填,于是这道缝判的是零诊断零退出 ──────────────────────────────────
 * 脚本 API 的类型声明面家已定在真源包(`packages/schema/script-api/index.d.ts`),
 * `tsconfig.scripts.json` 的 `types` 经它引入。于是每个示例编译后必须**零诊断、零退出**:
 * 不只是 API 名字有着落了,连签名也对上了——`getObjectsByType("unit", …)` 交出来的是 `Unit[]`
 * 而不是那个一调就报错的联合数组,而 `noUncheckedIndexedAccess` 下的下标取值示例也都判过空。
 *
 * 下面是**这道缝变严那一刻的样子**:它曾经判的是「非零退出 + 全部诊断都是找不到名字 + 那些名字
 * 都在符号表里」,也就是「除了 API 名字还没声明,示例没有别的毛病」。那一半今天仍然被本文件钉着,
 * 形态换成「零诊断」;翻 `TYPE_SURFACE_BACKFILLED` 的那个开关正是这条纪律的落点。
 *
 * ── 这道缝不做什么 ───────────────────────────────────────────────────────────
 * 它**不**替类型面说话:声明面覆盖了哪些字段、22 个名字逐条对不对得上,归
 * `script-api-type-surface.test.ts`。它**不**在仓库里落任何声明文件——临时目录里一个文件都不写,
 * 编译产物不读。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { SANDBOX_INJECTED_API_SYMBOLS } from "@model-war/schema";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const repoRoot = here("../../../");
const TSC = here("../../../node_modules/.bin/tsc");
const API_DOC = here("../../../docs/rules-v1/api.md");

/** 全仓库唯一那份参赛脚本编译配置。示例就是按它编译的,不多不少。 */
const SCRIPT_CONFIG = `${repoRoot}tsconfig.scripts.json`;

/**
 * 脚本 API 的类型声明面**已回填**:家是 `packages/schema/script-api/index.d.ts`,经
 * `tsconfig.scripts.json` 的 `types` 引入(hld §6.2「API 误用」那一行读的就是它)。
 *
 * 它是下面那几条断言的分叉开关。翻它的那天有两处必须一起改:一是本文件的断言形态,
 * 二是 §3 那张 API 表的签名一栏——回填前它由符号表的 `signature` 投影,回填后改为从类型面投影,
 * 而那张表现在是真源的直接投影(生成器报的头注释里写着这一点)。
 *
 * 翻回 `false` 的唯一正当理由是类型面被撤走(而不是被改坏):那时候「示例编译过」的诚实说法
 * 退回「除了 API 名字还没声明,没有别的毛病」。
 */
const TYPE_SURFACE_BACKFILLED = true;

/** 围栏代码块。信息串留空,内容整段取走。 */
const fencedBlocks = (file: string): readonly string[] =>
  [...file.matchAll(/^```[a-z]*\r?\n([\s\S]*?)^```/gm)].map((matched) => matched[1] ?? "");

/**
 * 可运行示例 = 块里声明了顶层入口的代码块。
 *
 * 锚在行首的 `function loop(`:辅助函数内部、注释里、字符串里的 `function loop(` 都不算。
 */
const isRunnableExample = (block: string): boolean => /^function loop\(/m.test(block);

/** 文档里全部可运行示例,按出现顺序。 */
const runnableExamples = (): readonly string[] =>
  fencedBlocks(readFileSync(API_DOC, "utf8")).filter(isRunnableExample);

const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * 把一段源码当参赛脚本编译一遍,返回退出码与诊断全文。
 *
 * 编译在系统临时目录里做,与 `script-compile-config.test.ts` 同一理由:临时目录在仓库之外,
 * 模块解析一路向上也够不到本仓库的 `node_modules`,「模块解析面被清空」在测试里才是真的。
 * 运行配置由基座派生、只覆盖 `files` 与 `outDir`——与将来的生成管线同形(TS5042)。
 */
const compileExample = (source: string): { readonly status: number; readonly output: string } => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-api-example-"));
  workspaces.push(dir);
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "script.ts"), source, "utf8");
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(
      { extends: SCRIPT_CONFIG, compilerOptions: { outDir: "out" }, files: ["script.ts"] },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = spawnSync(TSC, ["-p", join(dir, "run.json"), "--pretty", "false"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}`.trim() };
};

/** 「找不到名字」这一类诊断:TS2304 与 TS2552(后者带一句 did you mean)。 */
const unresolvedNamePattern = /error TS(?:2304|2552): Cannot find name '([^']+)'/g;

it("API 文档里至少有一个可运行示例,否则下面两条断言会在空集上绿", () => {
  expect(
    runnableExamples().length,
    "docs/rules-v1/api.md 里一个声明了顶层入口 `function loop(` 的代码块都没有",
  ).toBeGreaterThan(0);
});

it("每个可运行示例都真编译过,差异只有「API 名字还没有类型声明」这一件", () => {
  for (const [index, source] of runnableExamples().entries()) {
    const { status, output } = compileExample(source);
    const where = `API 文档第 ${index + 1} 个可运行示例`;

    if (TYPE_SURFACE_BACKFILLED) {
      // 零诊断而不是「零退出」:本配置刻意不设 `noEmitOnError`,所以退出码还会受别的原因影响,
      // 而「一条诊断都没有」才是这一格真正要说的话。
      expect(output, `${where} 编译期有诊断(类型面已回填,这一格该零诊断):\n${output}`).toBe("");
      expect(status, `${where} 编译没过:\n${output}`).toBe(0);
      continue;
    }

    // 类型面未回填 ⇒ 配置的 `types` 是空的 ⇒ 示例用到 API 就必然非零退出。
    // 零退出在这里是**坏消息**:它意味着某个东西替 API 填上了声明,而那不是这一格该做的。
    expect(
      status,
      `${where} 编译通过了。类型面还没回填,` +
        "所以这要么是它压根没调 API(那它不是可运行示例),要么是这一格偷偷填了类型面:\n" +
        output,
    ).not.toBe(0);

    // 逐条诊断都得是「找不到名字」,且那个名字得在注入面符号表里。多一句 `document`、
    // 多一个 `import`、多一处 `arr[i].x`,落到的都是这一类诊断而名字不在表里。
    const declared = [...output.matchAll(unresolvedNamePattern)].map((m) => m[1] ?? "");
    const diagnostics = output.split("\n").filter((line) => line.includes("error TS"));
    expect(
      declared.length,
      `${where} 的诊断里没有一条是「找不到名字」,说明它有别的毛病:\n${output}`,
    ).toBe(diagnostics.length);
    for (const name of declared) {
      expect(
        SANDBOX_INJECTED_API_SYMBOLS,
        `${where} 用到了符号表里没有的名字 \`${name}\`,` +
          "模型照着它写就是一次 API 误用(或者踩了禁列全局)",
      ).toContain(name);
    }
  }
});
