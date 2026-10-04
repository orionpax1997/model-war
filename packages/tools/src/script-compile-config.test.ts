/**
 * 参赛脚本的编译配置(`tsconfig.scripts.json`)的对外可观察行为。
 *
 * 断言对象是**编译器的退出码、诊断文本与产物内容**,以及产物在裸上下文里的运行结果——
 * 没有任何一处断言这份配置的字段形状:配置里每一条关键取舍(Node 类型进不来、DOM 进不来、
 * import 进不来、产物不带模块语法)都有对应的编译期或运行期现象,断言形状只会把那些现象
 * 抄一遍,还会让「改配置」与「改断言」变成同一件事。
 *
 * 这份配置的身份是编译器的输入,没有仓库代码 import 它,所以它只能靠「真跑一遍 tsc」被看见——
 * 这也是本文件存在的理由(对应 hld §6.2「编译」那一行:没有它,白名单反转与入口签名都无从执行)。
 *
 * 编译在系统临时目录里做,不在仓库里落任何文件:
 *   - 临时目录在仓库之外,模块解析一路向上也够不到本仓库的 node_modules,
 *     于是「模块解析面被清空」这条在测试里是真的,而不是被测试环境偷偷兜住;
 *   - 每次编译派生一份只覆盖 `files` 与 `outDir` 的运行配置,这正是生成管线将来要做的形态
 *     (`tsc -p` 不能与源文件同命令行出现,TS5042),所以这里跑的路径与将来的管线同形。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { afterAll, expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const repoRoot = here("../../../");
const TSC = here("../../../node_modules/.bin/tsc");

/** 全仓库唯一那份参赛脚本编译配置。 */
const SCRIPT_CONFIG = `${repoRoot}tsconfig.scripts.json`;

/** 一份形状合规的参赛脚本:顶层声明入口、返回类型可省略、单文件自包含。 */
const COMPLIANT_SCRIPT = `// 顶层声明入口,返回类型省略(终稿契约的裁决)。
var ticks = 0;
function loop() {
  ticks += 1;
  const squares: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    squares.push(i * i);
  }
  return squares.length;
}
`;

type Compile = { readonly status: number; readonly output: string; readonly products: string };

const workspaces: string[] = [];

/** 一次编译的落点:临时目录 + 派生运行配置 + 产物目录。 */
const open = (): { dir: string; config: string } => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-script-compile-"));
  workspaces.push(dir);
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(
      {
        extends: SCRIPT_CONFIG,
        compilerOptions: { outDir: "out" },
        files: ["script.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { dir, config: join(dir, "run.json") };
};

/**
 * 把 `source` 当参赛脚本编译一遍,断言对象只有三样:退出码、诊断文本、产物内容。
 *
 * 产物内容在编译失败时是空串——产物不存在与产物为空在这里不作区分,因为编译失败这一侧
 * 由退出码与诊断文本负责,真要区分「没产物」与「空产物」,得先有一份能编过的脚本。
 */
const compile = (source: string): Compile => {
  const { dir, config } = open();
  writeFileSync(join(dir, "script.ts"), source, "utf8");

  const result = spawnSync(TSC, ["-p", config, "--pretty", "false"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }

  const status = result.status ?? -1;
  let products = "";
  if (status === 0) {
    products = readFileSync(join(dir, "out", "script.js"), "utf8");
  }
  return { status, output: `${result.stdout}${result.stderr}`, products };
};

afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ── 类型环境:仓库编译基座刻意不继承 ─────────────────────────────────────────

it("脚本里引用 Node 专有名字 → 编译期红,同一路径换回合规脚本 → 绿", () => {
  // 基线:同一份配置下,合规脚本编得过。少了它,下面那个非零退出可能只是探针本身写得不对。
  const clean = compile(COMPLIANT_SCRIPT);
  expect(clean.status, `合规脚本被拦下:\n${clean.output}`).toBe(0);

  // 反例:Node 与 @types/node 提供的名字逐个点名。它们都只可能来自类型环境——
  // 脚本在沙箱里跑,而沙箱里没有 Node。
  const nodeNames = compile(`function loop() {
  return [process, Buffer, require, setTimeout, __dirname, globalThis.process.env];
}
`);
  expect(nodeNames.status, "Node 专有名字必须编译期就红").not.toBe(0);
  expect(nodeNames.output, nodeNames.output).toContain("Cannot find name 'process'");
  // 这条诊断的措辞本身就是证据:它说的是「类型定义没装」,不是「这个名字不存在于任何地方」。
  expect(nodeNames.output, nodeNames.output).toContain("types");
  expect(nodeNames.products, "编译没过却留下了产物").toBe("");

  expect(compile(COMPLIANT_SCRIPT).status, "撤掉探针后没有回到绿").toBe(0);
});

it("脚本里引用 DOM 名字 → 编译期红(lib 不带 DOM)", () => {
  const clean = compile(COMPLIANT_SCRIPT);
  expect(clean.status, `合规脚本被拦下:\n${clean.output}`).toBe(0);

  const dom = compile(`function loop() {
  return [document, window, fetch];
}
`);
  expect(dom.status, "DOM 名字必须编译期就红").not.toBe(0);
  expect(dom.output, dom.output).toContain("Cannot find name 'document'");
  expect(dom.output, dom.output).toContain("Cannot find name 'fetch'");
  expect(dom.products, "编译没过却留下了产物").toBe("");

  expect(compile(COMPLIANT_SCRIPT).status, "撤掉探针后没有回到绿").toBe(0);
});

it("脚本里写 import → 编译期红(单文件自包含的这一半)", () => {
  const clean = compile(COMPLIANT_SCRIPT);
  expect(clean.status, `合规脚本被拦下:\n${clean.output}`).toBe(0);

  const imported = compile(`import { readFileSync } from "node:fs";
function loop() {
  return readFileSync;
}
`);
  expect(imported.status, "脚本里的 import 必须编译期就红").not.toBe(0);
  expect(imported.output, imported.output).toContain("node:fs");
  expect(imported.products, "编译没过却留下了产物").toBe("");

  expect(compile(COMPLIANT_SCRIPT).status, "撤掉探针后没有回到绿").toBe(0);
});

// ── 产物形态:裸脚本,入口调得动 ─────────────────────────────────────────────

it("产物是裸脚本形态:无 import / export / require,loop 是函数且调得动", () => {
  const result = compile(COMPLIANT_SCRIPT);
  expect(result.status, `合规脚本被拦下:\n${result.output}`).toBe(0);

  // 产物形态这一层不需要判词,逐个查:模块语法一个都不许出现。
  for (const syntax of ["import", "export", "require"]) {
    expect(result.products.includes(syntax), `产物里出现了模块语法 ${syntax}`).toBe(false);
  }

  // 执行面:在一个**裸**上下文里载入并调入口——与沙箱 evalCode 同一形态
  // (上下文里没有 require、没有 process,所以「产物自带模块语义」这件事在这里也无从藏)。
  const sandbox: Record<string, unknown> = {};
  runInContext(result.products, createContext(sandbox));

  const entry = sandbox["loop"];
  expect(typeof entry, "产物里的入口不是函数").toBe("function");
  expect((entry as () => number)(), "入口调不动或返回值不对").toBe(3);
  expect(sandbox["ticks"], "入口的副作用不可观察").toBe(1);
  expect(sandbox["require"], "上下文里凭空多出 require,产物不是裸脚本").toBeUndefined();
  expect(sandbox["process"], "上下文里凭空多出 process").toBeUndefined();
});

// ── 配置自身的形状防线:它不是可直接跑的项目,也不会吞进整个仓库 ─────────────

it("这份配置自己拒绝被直接跑:直接 tsc -p 它非零退出,而不是把整个仓库编一遍", () => {
  const result = spawnSync(TSC, ["-p", SCRIPT_CONFIG, "--pretty", "false"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }

  const output = `${result.stdout}${result.stderr}`;
  // 它是编译选项的基座:每次编译由生成管线派生一份只覆盖 files 与 outDir 的运行配置。
  // 少掉这一条,「直接 tsc -p 它」就会默认 include **/*,把整个仓库吞进一个 program。
  expect(result.status, `直接跑这份配置居然过了:\n${output}`).not.toBe(0);
  expect(output, output).toContain("TS18002");
});
