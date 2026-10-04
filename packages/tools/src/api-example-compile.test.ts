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
 * ── 类型面未回填,于是判的不是「编译通过」而是「只差类型面这一件事」─────────────
 * 脚本 API 的类型声明面**尚未回填**(家已定在真源包,内容由对局内核与沙箱执行器回填),
 * `tsconfig.scripts.json` 的 `types` 因此是空的。于是每个示例编译后**必然非零退出**,
 * 诊断逐条是「某个 API 名字还没有类型声明」。本文件断言的正是这个精确形态:
 *
 *   1. 退出码非零(类型面确实还没来——零退出意味着这一格偷偷填了类型面);
 *   2. **全部**诊断都是「找不到名字」这一类,没有别的;
 *   3. 那些名字逐个都在注入面符号表里。
 *
 * 第 2 条是这道缝真正抓东西的地方:多一句 `document`、多一个 `import`、多一处下标越界、
 * 多一个拼错的变量名,落到的都是「找不到名字」但名字不在表里,于是红。第 3 条顺带把
 * 「示例里用到的每个 API 名字都在符号表里」这条也管住了,而它用的是**同一张符号表**
 * (`SANDBOX_INJECTED_API_SYMBOLS`),没有另立一份名单。
 *
 * 类型面回填那天把下面那个 `TYPE_SURFACE_BACKFILLED` 翻成 `true`,断言自动改成「零诊断、退出码 0」;
 * 那一刻这道缝比现在更严(签名也对上了),而今天这几条是它的**前置子集**。
 *
 * ── 这道缝不做什么 ───────────────────────────────────────────────────────────
 * 它**不**替类型面说话:类型面对不对是回填那一格的事,这里只保证「除了缺声明,示例没有别的毛病」。
 * 它也**不**在仓库里落任何声明文件——临时目录里一个文件都不写,编译产物不读。
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
 * 脚本 API 的类型声明面**尚未回填**。
 *
 * 它是下面那几条断言的分叉开关,也是这张注释的读者第一件要确认的事:类型面回来之前,
 * 「示例编译过」的诚实说法不是「退出码 0」,而是「除了 API 名字还没声明,没有别的毛病」。
 * 回填触发条件(hld §6.2「API 误用」那一行):真源包里那些函数声明本身存在的那天。
 * 翻它之前先看一眼 §3 的 API 表——那张表的签名在回填前由符号表投影给出,回填后改为从类型面投影。
 */
const TYPE_SURFACE_BACKFILLED = false;

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
      expect(status, `${where} 编译没过(类型面已回填,这一格该零诊断):\n${output}`).toBe(0);
      expect(output, `${where} 编译期有诊断:\n${output}`).toBe("");
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
