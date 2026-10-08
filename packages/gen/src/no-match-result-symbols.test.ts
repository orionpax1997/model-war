/**
 * AC1 的源码级那一半:gen 运行时代码里不得出现对局结果符号
 * (srs FR-5 AC1;hld §3.2、§6.2「`gen` 代码中不存在对战结果回传路径」)。
 *
 * 与 `dependency-boundary.test.ts` 的那一半互不可替代:depcruise 看的是**编译产物里的 import 边**,
 * 而 `"runs/…/result.json"` 这样的字符串、或从别处抄来的一个 `RunMatchResult` 类型名,
 * 可以完全没有跨包边——它恰好就是 AC1 要禁的那条通路。这一半不看构建产物,裸读源码即可红。
 *
 * ── 为什么禁的是这几个符号(每条都得能回答「它为什么出现在 gen 里就是违规」) ──
 * `runs/`           对局产物的根目录名(hld §8.3:`runs/<runId>/` 里是回放 JSONL、对局结果与报告、
 *                   叙事战报)。gen 自己的产物只落 `archive/<slug>/<runId>/`,出现这个路径说明它在看对局产物。
 * `.result.json`    单场对局结果的文件名。gen 手里有它就等于拿到了对局反馈。
 * `MatchResult`     engine 的对局结果类型族(现实例:`RunMatchResult`,packages/engine/src/run-match.ts)。
 * `RunMatchParams`  跑一局所需的对局入参类型;gen 手上有这个类型说明它打算自己跑对局。
 * `runMatch`        engine 的对局入口函数。AC1 禁的不是「读结果」这一种动作,而是**任何**把结果带回生成环节的路。
 * `MatchOutcome`    对局判定结果类型的通用名(名次/胜负);与 `MatchResult` 同一族的不同拼法。
 * `@model-war/{engine,runner,replay}`  跨包边。这三条与 depcruise 重复,但 depcruise 需要 `dist`
 *                   先 build、且只看得见 import 语句;这里连 import 之外的写法一起拦,零构建。
 *
 * ── 遍历口径 ──
 * 运行时 `.ts`(`*.test.ts` / `*.prop.ts` / `*.d.ts` 除外),用真实 `readdir` 递归、**不写文件清单**:
 * 后续票往 `packages/gen/src`(含 `http/` 这类子目录)加文件时它们自动落进这条断言;
 * 写死清单的版本会在「新文件没被扫到」时照样绿,而它绿的恰好是覆盖面本身。
 * 另两条用例分别钉住那两件事:「扫到 0 个文件」不算通过,以及遍历口径本身(临时造一棵树看它怎么取舍)。
 *
 * 助手全部留在这个文件里,不抽成 `packages/gen/src/**` 下的运行时模块:禁用符号的字面量本身就是
 * 「被禁源码」,抽到运行时目录里会让门禁扫到自己、自己把自己判红。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/** gen 的源码根:本文件就在它下面。 */
const genSrc = fileURLToPath(new URL("./", import.meta.url));

/** 不进遍历的目录名:依赖树与本包自己的构建产物(`dist` 里是编译过一遍的同一份代码)。 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

/**
 * 是否是运行时代码:`*.ts` 且不是测试 / 属性测试 / 声明文件。
 * 口径与依赖门禁的豁免同源(hld §3.2:门禁约束的是运行时代码,测试代码不进生产路径)。
 */
const isRuntimeSource = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".prop.ts") &&
  !name.endsWith(".d.ts");

const filesIn = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...filesIn(path));
      }
    } else if (isRuntimeSource(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
};

/** 遍历 `root` 下的运行时代码,回传文件路径(按路径排序,好让失败信息可 diff)。 */
const runtimeSourceFilesIn = (root: string): string[] => filesIn(root);

/**
 * 把运行时代码读成一整串:门禁要问的是「这个包里有没有出现这个符号」,
 * 符号落在哪个文件、在代码里还是在注释里都不是判据——注释里写着 `runs/`,一样说明这个包在往外看对局产物。
 */
const runtimeSourceText = (root: string): string =>
  runtimeSourceFilesIn(root)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

/** 一条禁用符号:符号本体 + 它为什么出现在 gen 里就是 AC1 被破了。 */
type ForbiddenSymbol = { readonly symbol: string; readonly why: string };

/** 判据清单。新增一条的门槛是右栏能写清:这个符号在 gen 里出现意味着哪条回喂通路被打开了。 */
const FORBIDDEN_SYMBOLS: readonly ForbiddenSymbol[] = [
  {
    symbol: "runs/",
    why: "对局产物的根目录名(hld §8.3):gen 只写 archive/<slug>/<runId>/",
  },
  { symbol: ".result.json", why: "单场对局结果的文件名:拿到它就等于拿到了对局反馈" },
  { symbol: "MatchResult", why: "engine 的对局结果类型族(现实例 RunMatchResult)" },
  { symbol: "RunMatchParams", why: "跑一局所需的对局入参:手上有它说明 gen 打算自己跑对局" },
  { symbol: "runMatch", why: "engine 的对局入口函数:AC1 禁的是任何一条把结果带回来的路" },
  { symbol: "MatchOutcome", why: "对局判定结果(名次/胜负)的通用类型名" },
  { symbol: "@model-war/engine", why: "跨包边(与 depcruise 重复,但这条零构建、裸看源码就红)" },
  { symbol: "@model-war/runner", why: "跨包边:runner 跑对局并把产物落 runs/" },
  { symbol: "@model-war/replay", why: "跨包边:replay 读对局产物" },
];

/** 在拼好的源码里找禁用符号,按清单顺序回传命中项(空数组 = 通过)。 */
const forbiddenHits = (sources: string): readonly ForbiddenSymbol[] =>
  FORBIDDEN_SYMBOLS.filter(({ symbol }) => sources.includes(symbol));

it("gen 运行时代码里没有对局结果符号", () => {
  const files = runtimeSourceFilesIn(genSrc);
  // 反证:扫到 0 个文件时下面那条断言是空转的(遍历写错、源码目录被搬走,都会长成这个形状)。
  expect(files.length, "packages/gen/src 下没扫到任何运行时代码,这条断言空转").toBeGreaterThan(0);

  const hits = forbiddenHits(runtimeSourceText(genSrc));
  expect(
    hits.map(({ symbol }) => symbol),
    `gen 运行时代码出现对局结果符号(FR-5 AC1):${hits
      .map(({ symbol, why }) => `\n  ${symbol} —— ${why}`)
      .join("")}`,
  ).toEqual([]);
});

it("覆盖口径:后续票在子目录里加的运行时代码也进判据", () => {
  // 临时造一棵「后续票会加出来的」树,验的是判据的覆盖口径而不是「今天 gen 恰好有哪几个文件」:
  // 顶层文件、子目录文件都要被看到(遍历不递归 / 只看顶层列表时会漏),而测试文件、属性测试、
  // 声明文件与产物目录里的同一串不算违规。写死文件清单的实现会在这条用例上原形毕露。
  const dir = mkdtempSync(join(tmpdir(), "gen-runtime-sources-"));
  try {
    mkdirSync(join(dir, "http"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "run.ts"), "export type Probed = MatchResult;\n", "utf8");
    writeFileSync(
      join(dir, "http", "chat-completions.ts"),
      'export const url = "runs/r1";\n',
      "utf8",
    );
    // `.result.json` 只出现在不该被扫的地方:它一旦被扫到,下面的期望值就会多出一项。
    for (const skipped of ["probe.test.ts", "probe.prop.ts", "probe.d.ts"]) {
      writeFileSync(join(dir, skipped), 'export const p = ".result.json";\n', "utf8");
    }
    writeFileSync(join(dir, "dist", "run.js"), 'export const p = ".result.json";\n', "utf8");

    expect(forbiddenHits(runtimeSourceText(dir)).map(({ symbol }) => symbol)).toEqual([
      "runs/",
      "MatchResult",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
