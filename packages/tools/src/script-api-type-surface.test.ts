/**
 * 脚本 API 的**类型面**(`packages/schema/script-api/index.d.ts`)的对外可观察行为。
 *
 * ── 这道缝在量什么 ───────────────────────────────────────────────────────────
 * 类型面是 hld §6.2「API 误用」那一行的承载方:它的存在意义只有一个——**一份写错的脚本在编译期
 * 就红**,而不是编译通过、跑到沙箱里才炸。所以本文件的断言几乎全都是「编译器的退出码与诊断」,
 * 没有任何一处断言声明文本本身长什么样:改了声明的写法而它对脚本的判决没变,那是白改;
 * 反过来它开始改判决(某个名字认不出了、某个字段读不到了),那就得有人回来改。
 *
 * ── 编译在系统临时目录里做 ───────────────────────────────────────────────────
 * 与 `script-compile-config.test.ts` / `api-example-compile.test.ts` 同一理由:临时目录在仓库之外,
 * 模块解析一路向上也够不到本仓库的 `node_modules`,于是「模块解析面被清空」在这里是真的,
 * 而不是被测试环境偷偷兜住。运行配置由基座派生、**只覆盖 `files` 与 `outDir`**
 * (`tsc -p` 不能与源文件同命令行出现,TS5042),与将来的生成管线同形。
 *
 * ── 「零诊断」与「非零退出」是两件事,别混 ────────────────────────────────────
 * 这份配置刻意不设 `noEmitOnError`,所以正例的判据是**诊断输出为空**;反例的判据是**某条具体诊断
 * 出现**。只判退出码的话,一份「因为别的原因红着」的反例会让任何用例都绿。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { SANDBOX_INJECTED_API_SYMBOLS } from "@model-war/schema";

import { SCRIPT_API_DECLARATION, readScriptApiDeclarations } from "./script-api/declarations.ts";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const repoRoot = here("../../../");
const TSC = `${repoRoot}node_modules/.bin/tsc`;
const SCRIPT_CONFIG = `${repoRoot}tsconfig.scripts.json`;

type Compile = { readonly status: number; readonly output: string };

const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * 一次编译。**额外覆盖 `typeRoots`/`types`** 是反向用例要的:把声明换成一份旧版,
 * 编译器必须跟着改判——否则这份声明就只是个摆设。
 */
const compile = (source: string, typeSurface?: { readonly declaration: string }): Compile => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-script-api-"));
  workspaces.push(dir);
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "script.ts"), source, "utf8");
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(
      {
        extends: SCRIPT_CONFIG,
        compilerOptions: {
          outDir: "out",
          ...(typeSurface === undefined
            ? {}
            : { typeRoots: [typeSurface.declaration], types: ["old"] }),
        },
        files: ["script.ts"],
      },
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

/** 读一遍真源声明。 */
const surface = (): ReturnType<typeof readScriptApiDeclarations> =>
  readScriptApiDeclarations(
    SCRIPT_API_DECLARATION,
    readFileSync(`${repoRoot}${SCRIPT_API_DECLARATION}`, "utf8"),
  );

// ── 对齐:符号表与声明面 22 条逐条,不多不少 ─────────────────────────────────

/**
 * **声明面声明的值名 = 注入面符号表那 22 个,逐条同序,不多不少。**
 *
 * 「不多」这一向由它守住:声明里多声明一个全局值,就多了一个注入面不知道、而脚本调得到的名字——
 * 症状是编译器放行、沙箱里没有,正是这份声明要消灭的那种失败。「不少」那一向由下面那条编译探针守。
 *
 * 反例:往声明里加一条 `declare const fly: "fly";`,本条立刻红。
 */
it("声明面声明的值名与注入面符号表逐条对齐,22 个不多不少", () => {
  expect([...surface().valueNames]).toEqual([...SANDBOX_INJECTED_API_SYMBOLS]);
  expect(SANDBOX_INJECTED_API_SYMBOLS.length, "符号表被改了,数目先对一遍再说").toBe(22);
});

/**
 * 声明里的每一个**类型名**都真的能被脚本当类型引用。
 *
 * 这条是判据「不收类型名」的正面那一半:那些名字擦掉类型标注后不剩运行时值,符号表不收它们
 * (另一半在 `packages/schema` 那侧),但它们作为**类型**必须在声明里存在——`api.md` §2.3
 * 承诺过 `ErrResult` 的承载形态不披露、只给两个 helper,那句话兑现的前提就是这些类型名都在。
 *
 * 用**声明自己读出来的清单**而不是另抄一份:抄一份就得同时维护「声明里有哪些类型名」与
 * 「清单里有哪些」,而它们分叉时没有任何机器信号。
 */
it("声明里的每一个类型名都能被脚本当类型引用", () => {
  const typeNames = surface().typeNames;
  expect(typeNames.length, "声明里一个类型名都没有").toBeGreaterThan(0);
  const probe = `function loop(): void {
  void 0;
}
${typeNames.map((name, at) => `type Probe${String(at)} = ${name};`).join("\n")}
`;
  const result = compile(probe);
  expect(result.output, `声明里的类型名有引用不到的:\n${result.output}`).toBe("");
});

// ── 正例:22 个名字全部可调,快照字段全部可读 ─────────────────────────────────

/**
 * **注入面那 22 个名字逐个被脚本引用一次,零诊断。**
 *
 * 探针的源码由符号表生成,不另抄一份名单:抄一份就多一处「清单忘了跟上」的地方,而症状是
 * 「声明少了一个名字」这件事静静过去。这条与上面那条一起把「不多不少」两个方向都钉住。
 */
it("注入面那 22 个名字逐个可引用,零诊断", () => {
  const names = SANDBOX_INJECTED_API_SYMBOLS;
  const probe = `function loop(): void {
  const seen: unknown[] = [
${names.map((name) => `    ${name},`).join("\n")}
  ];
  void seen;
}
`;
  const result = compile(probe);
  expect(result.output, `注入面上有引用不到的名字:\n${result.output}`).toBe("");
  expect(result.status, result.output).toBe(0);
});

/**
 * **全部 action / 查询函数逐个真调一遍**(按签名给字面量参数),零诊断。
 *
 * 与上一条分工:上一条只证「这个名字存在」,这条证「它按声明的签名调得动」——参数个数、参数类型、
 * 返回值形态三者一起被卡住。签名改了而这一条不红,说明改得太宽容。
 */
it("全部 action / 查询函数按声明的签名逐个调得动,零诊断", () => {
  const probe = `function loop(): void {
  void getTick();
  void getObjectById(1);
  void getObjectsByType("unit");
  void getObjectsByType("site", { owner: 0, kind: "base" });
  void getObjectsByType("player");
  void getRange(0, 0, 1, 1);
  void getTerrainAt(0, 0);
  void findPath(0, 0, 1, 1);
  void move(1, 0, 1);
  void moveTo(1, 2, 3);
  void attack(1, 2);
  void harvest(1, 2);
  void transfer(1);
  void spawnUnit(1, "melee");
  const me = getMyIndex();
  const result = move(1, 0, 1);
  if (isError(result)) {
    const code = errCode(result);
    if (
      code === ERR_NOT_ENOUGH_RESOURCES ||
      code === ERR_INVALID_UNIT ||
      code === ERR_NOT_OWNER ||
      code === ERR_OUT_OF_RANGE ||
      code === ERR_INVALID_TARGET ||
      code === ERR_INVALID_SITE ||
      code === ERR_BAD_ARGS
    ) {
      void me;
    }
  }
}
`;
  const result = compile(probe);
  expect(result.output, `有函数按声明的签名调不动:\n${result.output}`).toBe("");
  expect(result.status, result.output).toBe(0);
});

/**
 * **快照的全部可读字段逐个读一遍**,含 `Site.remaining?` 与 `Site.producing`,零诊断。
 *
 * 判据是「契约面承诺的每一个字段都在」:少一个字段,脚本就会在运行时读到一个 `undefined`,
 * 而它连编译期都过得去。点位上的 `producing` 在这里被写成 `site.producing` 而不是别的形状——
 * 产线订单挂在点位上,不是一张独立队列表。
 */
it("快照的全部可读字段都能读到(含 Site.remaining 与 Site.producing)", () => {
  const probe = `declare const snap: Snapshot;
function loop(): void {
  const values: number[] = [
    snap.tick,
    snap.players[0]!.index,
    snap.players[0]!.resources,
    snap.players[0]!.alive ? 1 : 0,
    snap.players[0]!.exceptionTicks,
    snap.units[0]!.id,
    snap.units[0]!.owner,
    snap.units[0]!.x,
    snap.units[0]!.y,
    snap.units[0]!.hp,
    snap.units[0]!.carrying,
    snap.sites[0]!.id,
    snap.sites[0]!.x,
    snap.sites[0]!.y,
    snap.sites[0]!.owner,
    snap.sites[0]!.progressOwner,
    snap.sites[0]!.progress,
    snap.sites[0]!.remaining ?? 0,
    snap.sites[0]!.producing?.remainingTicks ?? 0,
  ];
  void values;
  // 两个字符串枚举单独校:混进上面那个 number[] 里会把它们当成可与数字互换的东西,
  // 那样这一条就只证明「有个叫 type / kind 的字段」,证不出它的取值域。
  const unitType: "worker" | "melee" | "ranged" | "cavalry" = snap.units[0]!.type;
  const siteKind: "base" | "resource" = snap.sites[0]!.kind;
  // 产线订单的 type 也是契约面逐字段承诺的一栏(type 与 remainingTicks),单独读一次。
  const producedType: "worker" | "melee" | "ranged" | "cavalry" | null =
    snap.sites[0]!.producing?.type ?? null;
  void unitType;
  void siteKind;
  void producedType;
}
`;
  const result = compile(probe);
  expect(result.output, `快照有读不到的字段:\n${result.output}`).toBe("");
  expect(result.status, result.output).toBe(0);
});

/**
 * **三件「不许有」的事,各由一条 `@ts-expect-error` 钉住:座位不在快照里、产线不是队列表、
 * 快照没有写入口。**
 *
 * `@ts-expect-error` 在这里当断言用:**那一行真的报错 → 零诊断;那一行不报错 → tsc 报
 * 「Unused '@ts-expect-error' directive」,编译非零退出**。于是这条用例的判据是「零诊断」,
 * 与正例那几条同一个形态。
 *
 * 三件事的性质不同,值得分开写:前两件是**别留第二个入口**(座位只从 `getMyIndex()` 读、产线只从
 * `site.producing` 读),第三件是**没有写入口**——意图的 `check()` 的入参就是这份 `Snapshot`,
 * 「它不会写引擎状态」因此是类型形状的事实而不是纪律;一旦这里给了写入口,那句话就退化成一句
 * 需要人遵守的约定,而引擎状态是全局唯一的对局真值。
 */
it("座位不在快照形状里、产线不是独立队列表、快照没有写入口", () => {
  const probe = `declare const snap: Snapshot;
function loop(): void {
  // @ts-expect-error 座位不在快照形状里:它只由 getMyIndex() 给出,不留第二个入口。
  void snap.you;
  // @ts-expect-error 产线订单是点位上的那一个字段,不是一张独立队列表。
  void snap.productions;
  // @ts-expect-error 快照深只读:check() 的入参类型里根本没有写入口。
  snap.tick = 1;
  // @ts-expect-error 对象字段同样只读。
  snap.units[0]!.hp = 1;
}
`;
  const result = compile(probe);
  expect(
    result.output,
    `上面三条 @ts-expect-error 有哪一条其实不报错(声明里多了不该有的东西):\n${result.output}`,
  ).toBe("");
  expect(result.status, result.output).toBe(0);
});

// ── 反例:拼错 API 名字 → 编译期红;换旧声明 → 判决跟着变 ──────────────────────

/**
 * **本票的核心验收:把一个 action 的名字拼错 → 编译期红。**
 *
 * 没有这一条,前面那些都只是搬了一份文件:形状齐不齐、字段全不全,都不回答「这份声明到底拦不拦得住
 * 一份写错的脚本」。这一条是那个问题的答案,而且它是**编译器的名字解析**给的,不是本仓库的哪条规则。
 *
 * 诊断文本逐字点名 `moev`:只有「找不到这个名字」这一类才说明拦住它的是白名单反转,换成别的诊断
 * (比如某个类型不兼容)就说明是别的东西碰巧把它拦下了。
 */
it("把一个 action 的名字拼错 → 编译期红,且红在「找不到这个名字」上", () => {
  const clean = compile("function loop(): void {\n  void move(1, 0, 1);\n}\n");
  expect(clean.output, `基线脚本被拦下了(那说明是探针本身写得不对):\n${clean.output}`).toBe("");

  const typo = compile("function loop(): void {\n  void moev(1, 0, 1);\n}\n");
  expect(typo.status, "拼错的 action 名字竟然编译通过了").not.toBe(0);
  expect(typo.output, typo.output).toContain("Cannot find name 'moev'");

  expect(compile("function loop(): void {\n  void move(1, 0, 1);\n}\n").output).toBe("");
});

/**
 * **反向用例:换成一份旧版声明(少一个 `harvest`)→ 用到它的脚本编译期红。**
 *
 * 它防的是「把这份声明做成一个软约束」:如果红与不红跟声明内容无关(比如真源之外的某处又给了一遍
 * 声明,或者某个 `skipLibCheck` / `any` 把它架空了),那么这一条会立刻绿——所以它是**先绿后红**的
 * 探针:同一份配置下 `move` 调得动(声明照旧管用),换成旧声明之后 `harvest` 调不动。
 *
 * 「少一个名字」而不是「换一份形状不同的」:形状不同会同时牵动别的诊断,而少一个名字的后果最干净——
 * 正是「文档说能用、编译器说没有」那一句的字面形态。
 */
it("反向用例:换成一份少一条的旧声明 → 那一条调用编译期红,其余照旧", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-old-declaration-"));
  workspaces.push(dir);
  // `typeRoots` 的成员是**装着类型包的目录**,包本身是它下面的一层子目录——所以旧声明要自己
  // 装成一个包(带 package.json 指到 index.d.ts),不能把一个 index.d.ts 直接摊在 typeRoots 上。
  mkdirSync(join(dir, "old"), { recursive: true });
  writeFileSync(
    join(dir, "old", "package.json"),
    `${JSON.stringify({ name: "old", version: "0.0.0", private: true, types: "./index.d.ts" }, null, 2)}\n`,
    "utf8",
  );
  // 旧版声明:`harvest` 那一条不在了,其余逐字照抄。**不是**另写一份小的——那份小的会让
  // 「少了 harvest」与「整份声明都变了」分不开,而分不开就说明这条用例判的不是它想判的那件事。
  const old = readFileSync(`${repoRoot}${SCRIPT_API_DECLARATION}`, "utf8").replace(
    /declare function harvest\([^)]*\):[^;]*;/,
    "",
  );
  expect(old, "旧声明的造法没生效(harvest 那一条还在)").not.toContain("declare function harvest");
  writeFileSync(join(dir, "old", "index.d.ts"), old, "utf8");

  const harvest = compile("function loop(): void {\n  void harvest(1, 2);\n}\n", {
    declaration: dir,
  });
  expect(harvest.status, "换掉声明之后,少掉的那个名字竟然还调得动").not.toBe(0);
  expect(harvest.output, harvest.output).toContain("Cannot find name 'harvest'");

  // 同一份旧声明下没少掉的那个照旧可用:红的是「少了谁」,不是「这份配置坏了」。
  const move = compile("function loop(): void {\n  void move(1, 0, 1);\n}\n", {
    declaration: dir,
  });
  expect(move.output, `换声明之后连没少掉的名字也红了:\n${move.output}`).toBe("");
});
