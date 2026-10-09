/**
 * 门禁本身的退出码——本 feature 的主缝(spec《Testing Decisions》)。
 *
 * 断言对象是 CI 将来会敲的那几条命名脚本,以及门禁脚本自己的退出码;
 * 断言的东西全部是外部可观察的:进程的退出码与报告文本。没有任何一处断言内部函数形状。
 *
 * 每道门禁都配了**现做现验的反例**:往仓库里放一处违规,确认非零退出,再确认修好后回到 0。
 * 反例里刻意不用「临时目录 + 另一份配置」,而是让真实的门禁脚本在真实的仓库状态上红一次——
 * 一条只在夹具里才成立的规则,和没有规则是同一种东西。
 *
 * 反例策略按「违规能落在哪棵树里」分两种:
 *   - **落进源码树**(各包 src 目录下的 `__*-probe.js`):给 oxfmt / oxlint 用。它们按目录扫描,
 *     探针必须是真实源码文件才会进视野。探针取 `.js` 而非 `.ts`,因为各包 tsconfig 的 include
 *     只收 `.ts` 且不开 allowJs——`.js` 进得了格式化与 lint 门禁、进不了编译,
 *     于是不会把 `tsc -b` 一起弄红,反例只证明它该证明的那一件事。
 *     唯一的例外是 `typescript/*` 那批规则(oxlint 不把它们施加到 .js 上),它们用 .ts 探针;
 *     反正 lint 用例里不跑 tsc,编译被染红也轮不到它说话。
 *   - **落进工具包源码树的 .ts 探针**(`__declared-deps-probe.ts`):给「声明即依赖」门禁用。
 *     它读的是 `packages/tools/src` 的源码,所以探针必须是 .ts;而它读不到 dist 里的任何东西,
 *     与禁浮点门禁同形态。
 *   - **落进产物树**(各包 dist 目录下的 `__gate-probe.js`):给 dependency-cruiser 用。
 *     它巡航的是 dist(见 .dependency-cruiser.js 顶部:本仓库的 TypeScript 7 没有 JS 编程 API,
 *     depcruise 认不了 `.ts`),而 dist 不入库,所以这个反例既走真实配置与真实规则,
 *     又不会在失败时脏工作区。
 *   - **落在根层那份真配置上**(参赛脚本编译配置那一节):门禁按路径列表逐个点名根层文件,
 *     所以「它到底在不在门里」只有一个测法——排版弄坏真的那份配置,看门禁说不说话,
 *     再按字节还原。它不是探针文件,所以不进 `PROBES`(没有第二次清理的机会)。
 *   - **落在真源与生成物**(生成器那一节):先改真源、不重跑生成器,规则层读到的还是上一版——
 *     这本身是漂移检查(票 04)要抓的形态,但在本票里它有个更直接的后果可测:
 *     真源改了 + 重跑生成器,门禁判决必须跟着变。
 *   - **落在数据文件上的真源**(规则文档数值表那一节):那一件生成物的真源不是 `.ts` 而是
 *     `rulesets/v1.json`,所以「改真源」不需要先编过去——门禁当场读到的就是新值。
 *     断言落在同一处:改了取值不重跑必须红,手改文档里那段表格也必须红。
 *   - **登记进注册表的新生成物**(漂移检查那一节):它必须**留在版本库之外**,否则第二刀就抓不到它,
 *     而落进 `dist/` 之类被忽略的目录会让它压根不进视野。所以它落在 `packages/tools/src/generated/`,
 *     并且进了 `PROBES` 列表。
 *
 * `withProbeFile` 的 `finally` 保证成败都撤掉探针;`afterAll` 再兜一次底,
 * 覆盖进程被硬杀、`finally` 根本没机会跑的那种情况。
 *
 * 与 unit / property 分成不同的 vitest project 是为了不递归:全量门禁 `check` 里含
 * `vitest run`,而这里会 spawn `check`。见 vitest.config.ts 的 GATES_TEST 常量,
 * 以及本文件末尾那条盯着该不变量的用例。
 *
 * **这里只放门禁自测**(同机实测:本文件约 43s),由 `pnpm run test:gates` 按需运行,不属于默认快速 `test`。
 * 契约自证门禁的四问与三个反例、以及会 spawn 全量 `check` 的那一条在 `gates-slow.test.ts`(约 350s),由 `pnpm run test:slow` 按需运行。
 * 快慢拆分的理由写在 `gates-slow.test.ts` 的头注里。
 * 两个文件共用的那一层观察手段(`script` / `withProbeFile` / 末尾复核清单)在 `gates-harness.ts`,
 * 清单只有一份,分叉的后果是「一道门禁既不在末尾又被断言在末尾」而两处断言都绿。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, expect, it } from "vitest";
import { SANDBOX_RUNTIME_ARTIFACT_PATH } from "@model-war/schema";

import {
  VIOLATING_SCRIPT_PROBE_PATH,
  type Outcome,
  here,
  manifest,
  repoRoot,
  run,
  script,
  tailSteps,
  withProbeFile,
} from "./gates-harness.ts";
import { sectionMarker } from "./generate/section.ts";

const bin = (name: string): string => here(`../../../node_modules/.bin/${name}`);

/**
 * 漂移检查那一节用的三个探针路径(常量提到这里,好让 `afterAll` 的兜底清理能引用它们):
 * 一件是「登记进注册表但没进版本库」的生成物,同一件的两种藏法(普通未跟踪 / 被 `.gitignore`
 * 命中),以及一个「与生成物无关的未跟踪文件」。
 */
const EXTRA_ARTIFACT_PATH = "packages/tools/src/generated/__drift-probe.ts";
const IGNORED_ARTIFACT_PATH = "packages/tools/dist/__drift-probe.ts";
const UNRELATED_NOISE_PATH = "docs/__drift-noise-probe.md";
const SECTION_PROBE_PATH = "docs/__section-probe.md";

/** 禁浮点反例用的探针路径:落在 engine 的运行时代码里,这道门禁才看得见它。 */
const NO_FLOAT_PROBE = "packages/engine/src/__nofloat-probe.ts";

/** 本文件用过的全部探针路径(`gates-slow.test.ts` 用它自己的那一条,各自兜底)。 */
const PROBES = [
  "packages/schema/src/__fmt-probe.js",
  "packages/schema/src/__lint-probe.js",
  "packages/schema/src/__lint-probe.ts",
  NO_FLOAT_PROBE,
  "packages/tools/src/__declared-deps-probe.ts",
  "packages/runner/dist/__gate-probe.js",
  "packages/engine/dist/__gate-probe.js",
  "packages/gen/dist/__gate-probe.js",
  EXTRA_ARTIFACT_PATH,
  IGNORED_ARTIFACT_PATH,
  UNRELATED_NOISE_PATH,
  SECTION_PROBE_PATH,
  VIOLATING_SCRIPT_PROBE_PATH,
] as const;

afterAll(() => {
  for (const probe of PROBES) {
    rmSync(`${repoRoot}${probe}`, { force: true });
  }
});

// ── 全量门禁末尾那一组:提交内容复核 ───────────────────────────────────────────
//
// 三道门禁共享同一条位置纪律:**「提交内容对不对」的复核都挂在 `check` 末尾**,
// 排在编译、静态、单测与依赖方向那几道各自独立的检查之后。
// 这个清单只在这里写一份,由下面三处断言共用:写成三份 `slice(-2)` 的话,加一道门禁要改三处,
// 而三处里漏掉一处的后果是「有一道复核其实不在末尾」没人发现。
//
// 为什么是清单而不是「最后 N 步」:纪律是「末尾那几道都是复核」,不是「末尾恰好 N 道」。
// 清单可枚举,N 会漂——多一道或少一道,前者让断言变红,后者让它安静地放过一道混进末尾的新检查。

// 「挂在 `check` 末尾的提交内容复核」那份清单与取末尾一段的算术都在 `gates-harness.ts`,
// `gates-slow.test.ts` 与本文件的三处断言共用同一份(`slice(-3)` 写成三处,加一道门禁要改三处,
// 而三处里漏掉一处的后果是「有一道复核其实不在末尾」没人发现)。

// ── 分层门禁在空壳上各自退出 0 ────────────────────────────────────────────────

it("check:quick(格式 + lint + 工具版本耦合)在空壳上退出 0", () => {
  const result = script("check:quick");
  expect(result.status, result.output).toBe(0);
});

it("check:types(check:quick + tsc -b + 类型感知 lint)退出 0", () => {
  const result = script("check:types");
  expect(result.status, result.output).toBe(0);
});

it("check:deps(依赖门禁)退出 0,且报告的巡航规模不为零", () => {
  const result = script("check:deps");
  expect(result.status, result.output).toBe(0);

  // 反面证据:必须真的巡航到了图。depcruise 缺 TS 编译器时的行为是**静默跳过 .ts**,
  // 报告写着「0 modules, 0 dependencies」并且 exit 0——那是一条永远全绿、什么也没断言的假门禁。
  // 所以这一条不是装饰:它是「check:deps 退出 0」这句话不成立的那种情形的唯一防线。
  const cruised = /(\d+) modules, (\d+) dependencies cruised/.exec(result.output);
  expect(cruised, `依赖门禁没有报告巡航规模,疑似空跑:\n${result.output}`).not.toBeNull();
  expect(Number(cruised?.[1] ?? "0"), "巡航到的模块数为零,门禁等于没跑").toBeGreaterThan(5);
  expect(Number(cruised?.[2] ?? "0")).toBeGreaterThan(5);
});

it("test:props(长时属性测试)退出 0", () => {
  const result = script("test:props");
  expect(result.status, result.output).toBe(0);
});

// 「check(全量门禁)退出 0」那条在 `gates-slow.test.ts`:它要真跑一遍全量门禁(内含 64 场对局,
// 单次约 90s),而这一份文件是给「想快点知道门禁自测过没过」的人跑的。

// ── 工具版本耦合:错位即非零退出 ──────────────────────────────────────────────

it("工具版本耦合断言:配套为 0,错位为 1", () => {
  const gate = ["packages/tools/src/toolchain-coupling.ts"] as const;
  const aligned = run("node", [...gate]);
  expect(aligned.status, aligned.output).toBe(0);

  // 反例一:tsgolint 配套的是 TypeScript 7.0.1,而仓库锁的是 7.0.2。
  const misaligned = run("node", [...gate, "7.0.2", "7.0.1003"]);
  expect(misaligned.status, "版本错位必须非零退出").toBe(1);
  expect(misaligned.output, misaligned.output).toContain("版本配套");

  // 反例二:tsgolint 停在 TS 7 之前的 0.x 系列,压根不配套。
  const legacy = run("node", [...gate, "7.0.2", "0.25.0"]);
  expect(legacy.status, "0.x 时代的 tsgolint 必须非零退出").toBe(1);
  expect(legacy.output, legacy.output).toContain("版本号编码");

  // 反例三:manifest 写成范围而非精确锁版——错位的另一半是「压根没锁」。
  const ranged = run("node", [...gate, "^7.0.0", "7.0.2003"]);
  expect(ranged.status, "范围锁版必须非零退出").toBe(1);
  expect(ranged.output, ranged.output).toContain("精确锁版");
});

// ── quickjs-wasi 版本耦合:改根依赖钉的版本号即红 ──────────────────────────

it("quickjs-wasi 版本耦合断言:配套为 0,改根钉版即 1", () => {
  const gate = ["packages/tools/src/gate/run-quickjs-coupling-gate.ts"] as const;
  const aligned = run("node", [...gate]);
  expect(aligned.status, aligned.output).toBe(0);
  expect(aligned.output, aligned.output).toContain("quickjs-wasi 版本耦合 ok");

  // 反例:把根依赖钉的版本号改掉——按新版本组合复验之前,这条必须立刻红。
  const bumped = run("node", [...gate, "3.7.0"]);
  expect(bumped.status, "改根钉版后必须非零退出").toBe(1);
  expect(bumped.output, bumped.output).toContain("根依赖与冻结常量一致");
  // 报错信息要直接告诉人跑哪个脚本、把数字写回哪一节。
  expect(bumped.output, bumped.output).toContain("pnpm run probes:sandbox");
  expect(bumped.output, bumped.output).toContain("docs/hld.md §5.0");
});

// ── 禁浮点门禁反例 ───────────────────────────────────────────────────────────

it("禁浮点门禁:engine 源码里出现浮点字面量就红,撤掉即绿", () => {
  const clean = script("check:no-float");
  expect(clean.status, clean.output).toBe(0);

  // 探针落在 engine 的运行时代码里,而且是 .ts 而非 .js:这道门禁读的是**源码**
  // (自建校验器建在 oxc-parser 上,不经 tsc 产物),所以在 dist 里丢文件它根本看不见。
  // 位置与扩展名合起来才是「它真的在读该读的那片源码」的证据。
  const violated = withProbeFile(NO_FLOAT_PROBE, "export const speed = 1.5;\n", () =>
    script("check:no-float"),
  );
  expect(violated.status, "浮点字面量必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("__nofloat-probe.ts");

  // 同一路径换成整数:判决跟着内容走,不是跟着文件名走。
  const fixed = withProbeFile(NO_FLOAT_PROBE, "export const speed = 3;\n", () =>
    script("check:no-float"),
  );
  expect(fixed.status, `整数仍被拦下:\n${fixed.output}`).toBe(0);

  expect(script("check:no-float").status).toBe(0);
});

// ── 生成器:改真源 → 重跑 → 门禁的判决跟着变 ───────────────────────────────────

/** 白名单的真源与它的生成物。规则层读的是后者,所以只改前者不会有任何效果——必须重跑。 */
const SCHEMA_ALLOWLIST = "packages/schema/src/builtin-globals.ts";
const GENERATED_ALLOWLIST = "packages/tools/src/generated/builtin-globals.ts";
const GENERATED_SCRIPT_SURFACE = "packages/tools/src/generated/script-surface.ts";

/**
 * 反例里被从真源摘掉的那个成员。
 *
 * 选它而不是 `abs`,是因为必须摘一个 engine 源码**一处都不用**的成员:摘掉它只让「用它的探针」
 * 变红,engine 自己的代码一处都不被牵连,末一条断言(仍在名单里的成员照旧放行 → 整道门禁退 0)
 * 才成立。换成 engine 正在用的成员(如 `abs`),那些调用会一起被判违规,门禁无论如何都退非零,
 * 那条断言就变成了在测一个不存在的状态(票 12 修掉的那条红)。这个前提由下面那条前置自证盯着。
 */
const REMOVED_MEMBER = "clz32";
/** 探针:一条用到 `REMOVED_MEMBER` 的运行时代码。它在名单里时放行,摘掉后必被拒。 */
const REMOVED_MEMBER_PROBE = `export const probe = Math.${REMOVED_MEMBER}(-1);\n`;
/** 探针:一条用到另一个成员的运行时代码。`sign` 与 `clz32` 一样,engine 源码一处不用。 */
const STILL_ALLOWED_MEMBER_PROBE = "export const probe = Math.sign(-1);\n";

/**
 * 从禁浮点门禁的输出里取出被判违规的文件路径(去重)。
 *
 * 违规行形如 `<仓库根相对路径>:<行>:<列>  <规则>  <说明>`;末尾那行汇总
 * (`禁浮点门禁:检查 N 个文件,M 处违规。`)不含 `:行:列` 前缀,天然被滤掉。
 * 用它把「违规只来自探针文件」从一句注释变成一条机器可判的前提。
 */
const violatingFiles = (output: string): readonly string[] => [
  ...new Set(
    output
      .split("\n")
      .map((line) => /^(\S+?):\d+:\d+ /.exec(line)?.[1])
      .filter((path) => path !== undefined),
  ),
];

/**
 * 一次真源改动的两端:改哪个真源、重跑生成器会重写哪些落点。
 *
 * 两端都要显式写出来,而不是靠「改了白名单真源就顺手还原白名单生成物」这种默认:本文件里已有两处
 * 真源(白名单与注入面符号表),而它们的落点形状完全不同——前者是一份整文件生成物,后者是一段
 * 落在契约文档里的区块。漏还原一个落点,后面每一条「回到绿」的断言就都在替上一条用例擦屁股。
 */
type TruthTarget = {
  /** 真源的仓库根相对路径。真源是 `.ts`,所以改完必须 `tsc -b` 才成为门禁看得见的状态。 */
  readonly truth: string;
  /** 重跑生成器会重写的落点,按字节与真源一起还原。 */
  readonly rewritten: readonly string[];
};

/**
 * 改真源 →(可选地跑根脚本 `generate`)→ 跑 `body`,无论成败都把真源与落点**按字节**还原。
 *
 * 还原走字节而不是「再跑一次生成器」,是为了让「本用例有没有留下副作用」与生成器是否正确无关:
 * 生成器坏了也不该由还原路径顺手把它修好,那样这条用例的判决就永远绿。
 *
 * `regenerate: false` 是漂移检查那一节要的反例形态:改了真源**故意不重跑**,留下的正是
 * 「生成物停在上一版」那个状态。两条用例共用这一条还原路径,免得仓库里有两份。
 */
const withPatchedTruth = (
  target: TruthTarget,
  patch: (source: string) => string,
  options: { readonly regenerate: boolean },
  body: () => Outcome,
): Outcome => {
  const truth = `${repoRoot}${target.truth}`;
  const originals = [truth, ...target.rewritten.map((path) => `${repoRoot}${path}`)].map(
    (path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }),
  );
  const originalTruth = originals[0]?.text ?? "";

  const patched = patch(originalTruth);
  // 补丁没打上 = 判据随真源改了形状,这条用例会安静地测一个不存在的东西。必须当场红。
  expect(patched, "补丁没有改动真源,这条反例不成立").not.toBe(originalTruth);
  writeFileSync(truth, patched, "utf8");

  try {
    // 先把真源编过去:真源是 `.ts`,而生产函数 import 的是 `@model-war/schema` 的编译产物,
    // 所以「改了真源」要成为漂移检查看得见的状态,得先让 `tsc -b` 把它编进 `packages/schema/dist`。
    // CI 里这一步由 `check:types` 提供(`check:drift` 搭它的车),在这里必须自己补上。
    const build = script("build");
    expect(build.status, `构建失败,真源改动没进 dist,反例不成立:\n${build.output}`).toBe(0);

    if (options.regenerate) {
      const generatedRun = script("generate");
      expect(generatedRun.status, `生成器自身非零退出:\n${generatedRun.output}`).toBe(0);
    }
    return body();
  } finally {
    for (const snapshot of originals) {
      writeFileSync(snapshot.path, snapshot.text, "utf8");
    }
    // 真源还原之后,`packages/schema/dist` 可能停在被改过的源码上。补一次构建,
    // 让后续用例(尤其依赖已就位产物的 check:deps 与漂移检查)看到一致状态;结果不额外断言,
    // 断言留给那些真正依赖构建产物的用例,免得它盖掉 body 原本的失败信息。
    script("build");
  }
};

/** 白名单那一对:真源是一份整文件生成物。 */
const ALLOWLIST_TARGET: TruthTarget = {
  truth: SCHEMA_ALLOWLIST,
  rewritten: [GENERATED_ALLOWLIST],
};

/** `withPatchedTruth` 的「改了真源并重跑生成器」那一档。 */
const withRegeneratedAllowlist = (
  patch: (source: string) => string,
  body: () => Outcome,
): Outcome => withPatchedTruth(ALLOWLIST_TARGET, patch, { regenerate: true }, body);

it("生成器:改真源重跑后,禁浮点门禁的白名单判决随之改变", () => {
  // 基线:`clz32` 在名单里,用到它的脚本放行。没有它,后面那个「变红」可能只是探针本身写得不对。
  const allowed = withProbeFile(NO_FLOAT_PROBE, REMOVED_MEMBER_PROBE, () =>
    script("check:no-float"),
  );
  expect(allowed.status, `名单内的成员被拦下:\n${allowed.output}`).toBe(0);

  // 从真源里摘掉 `REMOVED_MEMBER` 并重跑生成器:同一条探针,从通过变拒绝。这就是「改真源 →
  // 门禁行为改变」这条链的正面证据,断言落在门禁的退出码与报告文本上,不碰任何内部函数。
  const removed = withRegeneratedAllowlist(
    (source) => source.replace(`  "${REMOVED_MEMBER}",\n`, ""),
    () => withProbeFile(NO_FLOAT_PROBE, REMOVED_MEMBER_PROBE, () => script("check:no-float")),
  );
  expect(removed.status, "真源摘掉成员后,用到它的脚本必须被拒绝").toBe(1);
  expect(removed.output, removed.output).toContain(`Math.${REMOVED_MEMBER}`);

  // 前置自证:被摘掉的成员此刻必须**只在探针里**被用到。若 engine 源码哪天开始使用它,
  // 这里的违规文件就不再只有探针——那种红会以「名单内的其他成员被连坐」的旧文案误导后来者
  // (正是票 12 修掉的那一条)。所以断言「违规恰好只来自探针文件」,并把处方写进报错。
  const files = violatingFiles(removed.output);
  expect(files.length, `探针没有被判违规,这条反例不成立:\n${removed.output}`).toBeGreaterThan(0);
  expect(
    files,
    `engine 源码里已经用上了 \`Math.${REMOVED_MEMBER}\`,这条反例该换成员了:` +
      "摘掉它会把 engine 自己的代码一起弄红,违规不该只留在探针文件里。" +
      `\n${removed.output}`,
  ).toEqual([NO_FLOAT_PROBE]);

  // 同一时刻仍在名单里的成员照旧放行:变红的是「白名单」,不是整道门禁——
  // 少了这一条,「生成器把规则层弄坏了」也会被算作通过。
  const stillAllowed = withRegeneratedAllowlist(
    (source) => source.replace(`  "${REMOVED_MEMBER}",\n`, ""),
    () => withProbeFile(NO_FLOAT_PROBE, STILL_ALLOWED_MEMBER_PROBE, () => script("check:no-float")),
  );
  expect(
    stillAllowed.status,
    `仍在名单里的成员被连坐:摘掉的是 \`${REMOVED_MEMBER}\`,而 \`sign\` 没动,` +
      `整道门禁不该退非零(engine 源码零使用 \`${REMOVED_MEMBER}\` 是本条的前提):\n${stillAllowed.output}`,
  ).toBe(0);

  // 链路的另一头:还原后门禁回到绿。少了它,一条「红到底」的假实现也能满足上面四条。
  expect(script("check:no-float").status, "还原后禁浮点门禁没有回到绿").toBe(0);
});

// ── 生成物漂移检查反例 ────────────────────────────────────────────────────────

/** 漂移检查的命名脚本。它需要构建前置(生产函数 import 真源包),所以只挂在全量门禁末尾。 */
const driftCheck = (): Outcome => script("check:drift");

/**
 * 往注册表数组字面量里插一条生成物声明,跑 `body`,无论成败都把注册表**按字节**还原。
 *
 * 注册表数组字面量的首行与末行是**结构性锚点**,不写死整条声明。
 *
 * 写死 `= [builtinGlobalsAllowlist];` 这种整条文本是脆的:第二件生成物(参赛脚本可见面的
 * 三张名单)一注册进来,锚点就不存在了,这条反例会以「注册表的锚点变了」红掉——
 * 而注册表按设计就是**加一行**的事(文档生成那几件还会再加几行),拿它当锚点等于
 * 把「加一行」的纪律钉死成「注册表永远只有一件」。所以只认首行(`= [`)与末行(`];`),
 * 件数与内容都不参与匹配。
 *
 * 插在末尾的 `];` 之前,而不是切字符:切一个字符会把数组提前闭合,一个漏掉的逗号会让它
 * 变成语法错误——两份错法都会被门禁报成「注册表坏了」,不是「生成物没入库」,
 * 于是这条反例测的根本不是它要测的那件事。
 *
 * 声明是**源码文本**而不是真构造出来的对象:注册表是代码里的字面量,而门禁跑的就是那份源码。
 * 所以 `form` 这类契约字段必须一并写全——漏了它,这条反例会因为「形态不完整」而不是因为
 * 它要测的那件事变红。
 */
const withRegistryEntry = (entry: string, body: () => Outcome): Outcome => {
  const registry = `${repoRoot}packages/tools/src/generate/registry.ts`;
  const original = readFileSync(registry, "utf8");

  const arrayOpen = "export const GENERATED_ARTIFACTS: readonly GeneratedArtifact[] = [";
  const closeAt = original.lastIndexOf("\n];");
  expect(original, "注册表的形状变了(找不到数组字面量的开头)").toContain(arrayOpen);
  expect(closeAt, "注册表的形状变了(找不到数组字面量的结尾)").toBeGreaterThan(0);
  const arrayEnd = original.slice(closeAt, closeAt + 3);

  writeFileSync(
    registry,
    original.slice(0, closeAt + 1) + entry + arrayEnd + original.slice(closeAt + 3),
    "utf8",
  );
  try {
    return body();
  } finally {
    writeFileSync(registry, original, "utf8");
  }
};

it("生成物漂移检查:改真源不重跑 → 变红,重跑并提交 → 变绿", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  // 反例①:真源加一个成员,生成器不跑。生成物路径上的内容一字未动,所以**只有**「重生成后无差异」
  // 那一段能抓住它——这正是这道检查不能只做 git 两刀的理由。
  const stale = withPatchedTruth(
    ALLOWLIST_TARGET,
    (source) => source.replace('  "abs",\n', '  "abs",\n  "sign2",\n'),
    { regenerate: false },
    () => driftCheck(),
  );
  expect(stale.status, "改了真源不重跑,漂移检查必须非零退出").toBe(1);
  expect(stale.output, stale.output).toContain(GENERATED_ALLOWLIST);

  // 同一处真源改动 + 重跑生成器:内容回到一致,剩下「未提交」那一刀,红的原因跟着变。
  // 少了这条,「它只会报那句生成器提示」也能满足上面两条。
  const regenerated = withPatchedTruth(
    ALLOWLIST_TARGET,
    (source) => source.replace('  "abs",\n', '  "abs",\n  "sign2",\n'),
    { regenerate: true },
    () => driftCheck(),
  );
  expect(regenerated.status, "重跑后内容一致,只剩未提交那一刀,仍应为红").toBe(1);
  expect(regenerated.output, regenerated.output).toContain("未提交");

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成物漂移检查:生成物被删 → 变红,还原 → 变绿", () => {
  const target = `${repoRoot}${GENERATED_ALLOWLIST}`;
  const original = readFileSync(target, "utf8");
  rmSync(target);

  try {
    const missing = driftCheck();
    expect(missing.status, "生成物被删必须非零退出").toBe(1);
    expect(missing.output, missing.output).toContain("不存在");
    // 被删是一处「对 HEAD 的差异」,所以第一刀也该说话:只报一致性那一段的话,
    // 「生成物被 `git rm` 掉」这条形态就没人管了。
    expect(missing.output, missing.output).toContain("未提交");
  } finally {
    writeFileSync(target, original, "utf8");
  }

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成物漂移检查:生成物被手改 → 变红,按字节还原 → 变绿", () => {
  const target = `${repoRoot}${GENERATED_ALLOWLIST}`;
  const original = readFileSync(target, "utf8");
  // 改在最后一行后面:手改最常见的形态是「在文件尾巴上添一句」,而头部在下一条用例里已被覆盖。
  const tampered = `${original}\n// 手改\n`;
  writeFileSync(target, tampered, "utf8");

  try {
    const violated = driftCheck();
    expect(violated.status, "手改生成物必须非零退出").toBe(1);
    expect(violated.output, violated.output).toContain("不一致");
    expect(violated.output, violated.output).toContain("// 手改");
  } finally {
    writeFileSync(target, original, "utf8");
  }

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成物漂移检查:新增一件生成物但没进版本库 → 变红", () => {
  /**
   * 把一件新生成物登记进注册表(内容与生产函数逐字节一致,所以一致性那一段是绿的),
   * 按 `path` 写出它的文件,跑 `body`,无论成败都把注册表与文件按字节还原。
   */
  const withRegisteredArtifact = (path: string, body: () => Outcome): Outcome =>
    withRegistryEntry(
      `  {\n    id: "drift-probe",\n    form: "whole-file",\n    path: "${path}",\n` +
        `    produce: () => "export const driftProbe: readonly string[] = [];\\n",\n  },`,
      () => {
        mkdirSync(dirname(`${repoRoot}${path}`), { recursive: true });
        writeFileSync(
          `${repoRoot}${path}`,
          "export const driftProbe: readonly string[] = [];\n",
          "utf8",
        );
        try {
          return body();
        } finally {
          rmSync(`${repoRoot}${path}`, { force: true });
        }
      },
    );

  // 形态一:文件在生成物目录下、内容正确、但没 `git add`。版本两刀里只有「在不在版本库里」
  // 那一刀能看见它——差异检查对未跟踪文件一律沉默,而第一件生成物正是新增的。
  const untracked = withRegisteredArtifact(EXTRA_ARTIFACT_PATH, () => driftCheck());
  expect(untracked.status, "新增生成物没进版本库必须非零退出").toBe(1);
  expect(untracked.output, untracked.output).toContain("不在版本库里");
  expect(untracked.output, untracked.output).toContain("未被 git 跟踪");
  expect(untracked.output, untracked.output).toContain(EXTRA_ARTIFACT_PATH);

  // 形态二:同一个错误换一种藏法——落进 `.gitignore` 命中的目录(`dist/`)。
  // 它在 `git status` 与 `git ls-files` 里连行都不留,而干净克隆同样不会有它。
  // 少了这一档,「把生成物写进 dist 就万事大吉」这条错法就没人管。
  const ignored = withRegisteredArtifact(IGNORED_ARTIFACT_PATH, () => driftCheck());
  expect(ignored.status, "生成物被 .gitignore 命中必须非零退出").toBe(1);
  expect(ignored.output, ignored.output).toContain(".gitignore");

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成物漂移检查:工作树里有与生成物无关的未提交内容时不误报", () => {
  // 一处**被跟踪**文件的改动 + 一个**未跟踪**的新文件,都在生成物路径之外。
  // 两种形态各占一条 git 判据(差异 / 未跟踪),所以两种都得在场,否则这条用例只覆盖了一半。
  const tracked = `${repoRoot}docs/hld.md`;
  const untracked = `${repoRoot}${UNRELATED_NOISE_PATH}`;
  const originalTracked = readFileSync(tracked, "utf8");
  writeFileSync(tracked, `${originalTracked}\n<!-- 与生成物无关的未提交改动 -->\n`, "utf8");
  writeFileSync(untracked, "与生成物无关的未跟踪文件\n", "utf8");

  try {
    // 反面证据:裸的 `git diff --exit-code` 在这个工作树上**是红的**——误报防护确实在干活,
    // 而不是一个碰巧干净的工作树。没有这一条,下面那个 0 说明不了任何事。
    const bare = run("git", ["diff", "--exit-code", "--", "docs/hld.md"]);
    expect(bare.status, "反例前提失效:裸 git diff 本来就看不见这条改动").not.toBe(0);

    const result = driftCheck();
    expect(result.status, `与生成物无关的改动被误报了:\n${result.output}`).toBe(0);
    expect(result.output, result.output).not.toContain("__drift-noise-probe");
    expect(result.output, result.output).not.toContain("docs/hld.md");
  } finally {
    writeFileSync(tracked, originalTracked, "utf8");
    rmSync(untracked, { force: true });
  }
});

it("生成物漂移检查挂在全量门禁末尾,且不进快门禁", () => {
  // 挂在末尾而不是中间:前面几道各自独立,末尾那几道是「提交内容对不对」的复核(清单见上)。
  expect(tailSteps(), "漂移检查不在全量门禁末尾那一组复核里").toContain("pnpm run check:drift");

  // 不进快门禁的理由是它需要一次 `tsc -b`,而快门禁的零构建性质不能破(ADR-0003 的混合传输)。
  // 「零构建」没法直接断言,能断言的是它没被挂进快门禁这条链里。
  expect(manifest().scripts["check:quick"]).not.toContain("check:drift");
  expect(manifest().scripts["check:types"]).not.toContain("check:drift");
});

// ── 生成物漂移检查:区块形态(一份文件里的某一段是生成物) ─────────────────────────

/**
 * 探针区块的定界标记与真源产出的正文。
 *
 * 标记**取自 `sectionMarker(id)`** 而不是在这里重写一遍字面量:它必须只由 `id` 决定才叫稳定串,
 * 而「这个默认形状有没有人走」正是靠探针走它来回答的——在这里另抄一份字面量,那个默认就会变成
 * 一个没人走过的死代码,而没人走过的默认值等于没有默认值(票 04 起的每一件都得自己重新想一遍形状)。
 * 报告里指认区块用的仍然是这两个串,断言的是门禁的外部输出。
 */
const SECTION_PROBE_MARKER = sectionMarker("section-probe");
const SECTION_PROBE_BEGIN = SECTION_PROBE_MARKER.begin;
const SECTION_PROBE_END = SECTION_PROBE_MARKER.end;
const SECTION_PROBE_BLOCK = ["| 一 | 二 |", "| --- | --- |", "| 1 | 2 |"];

/** 真源产出的区块正文:末尾带换行,与文档里夹住的那段逐字节相同。 */
const sectionProbeContent = (block: readonly string[]): string => `${block.join("\n")}\n`;

/** 探针文档:散文 + 区块 + 散文。散文刻意留在两侧——它就是「不比」的那半边。 */
const sectionProbeDoc = (block: readonly string[]): string =>
  [
    "# 区块探针",
    "",
    "上面这段散文不在区块里,手改它漂移检查不该管。",
    "",
    SECTION_PROBE_BEGIN,
    ...block,
    SECTION_PROBE_END,
    "",
    "下面这段散文同样不比。",
    "",
  ].join("\n");

/** 整段被删掉之后的样子:两行标记与区块正文都没了,剩下的全是散文。 */
const sectionProbeDocWithoutSection = (): string =>
  [
    "# 区块探针",
    "",
    "上面这段散文不在区块里,手改它漂移检查不该管。",
    "",
    "下面这段散文同样不比。",
    "",
  ].join("\n");

/**
 * 登记一件**区块形态**的生成物(真源产出的正文恒为 `SECTION_PROBE_BLOCK`),写出文档 `doc`
 * (`undefined` = 文档根本不存在),跑 `body`,无论成败都还原注册表与文档。
 *
 * 真源与文档分开传:反例要动的永远是**文档**那一侧,而真源那侧一动,红的原因就变成「真源改了」,
 * 不是「文档被手改」了。两者同源是基线的前提,所以基线里它们必须逐字节相同。
 *
 * `doc` 传 `undefined` 是为着把「落点还没有」与「落点上没有标记」分开:生成器对前者与后者
 * 都非零退出,但两条的处方不同(先建文件 / 把标记写回去),报告要说得出是哪一种。
 */
const withSectionProbe = (doc: string | undefined, body: () => Outcome): Outcome => {
  const entry =
    `  {\n    id: "section-probe",\n    form: "section",\n    path: "${SECTION_PROBE_PATH}",\n` +
    `    produce: () => ({\n` +
    `      marker: { begin: "${SECTION_PROBE_BEGIN}", end: "${SECTION_PROBE_END}" },\n` +
    `      content: ${JSON.stringify(sectionProbeContent(SECTION_PROBE_BLOCK))},\n` +
    `    }),\n  },`;
  return withRegistryEntry(entry, () => {
    if (doc !== undefined) {
      writeFileSync(`${repoRoot}${SECTION_PROBE_PATH}`, doc, "utf8");
    }
    try {
      return body();
    } finally {
      rmSync(`${repoRoot}${SECTION_PROBE_PATH}`, { force: true });
    }
  });
};

/** 内容判定(①)说话时必出的两个片段。版本库那两刀(未提交 / 未跟踪)说话时**不带**这两个。 */
const SECTION_CONTENT_VERDICTS = ["区块与真源不一致", "抽不出区块"];

/**
 * 跑 `body`,无论成败都把两件已入库的生成物**按字节**还原。
 *
 * 理由同 `withPatchedTruth`:`generate` 是逐件重写注册表上的**每一件**,所以它跑一次就把工作树
 * 改成了「本机 dist 里的真源」那个形态。不还原的话,红着的就变成了真实的漂移,后面每一条
 * 「回到绿」的断言都跟着失效——而那些断言正是防止一条永远红的假门禁混过去的那道。
 */
const withGeneratedArtifactsRestored = (body: () => Outcome): Outcome => {
  const snapshots = [GENERATED_ALLOWLIST, GENERATED_SCRIPT_SURFACE].map((path) => ({
    path,
    text: readFileSync(`${repoRoot}${path}`, "utf8"),
  }));
  try {
    return body();
  } finally {
    for (const snapshot of snapshots) {
      writeFileSync(`${repoRoot}${snapshot.path}`, snapshot.text, "utf8");
    }
  }
};

it("生成物漂移检查:区块形态——改正文、删整段、改标记都判红,改散文不管", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  /**
   * 基线:区块与真源逐字节相同。
   *
   * 它仍然是红的——一件**运行期登记**的生成物按定义没被 `git add`,所以版本库那两刀一定要说话,
   * 而内容判定必须沉默。这个区分是这一节全部断言的前提:不先把它立住,「所有形态都红」
   * 也能满足下面每一条断言。
   */
  const installed = withSectionProbe(sectionProbeDoc(SECTION_PROBE_BLOCK), () => driftCheck());
  expect(installed.status, "运行期登记的生成物必然红在版本库那一层").toBe(1);
  expect(installed.output, installed.output).toContain("不在版本库里");
  for (const verdict of SECTION_CONTENT_VERDICTS) {
    expect(
      installed.output,
      `内容逐字节相同却报「${verdict}」:\n${installed.output}`,
    ).not.toContain(verdict);
  }

  // 散文两侧被手改:内容判定仍然沉默。逐字节比整份的实现会把这一条变红——
  // 那就是「区块形态」这条能力没兑现的形态。
  const prose = withSectionProbe(
    `${sectionProbeDoc(SECTION_PROBE_BLOCK)}\n又一段手写的散文。\n`,
    () => driftCheck(),
  );
  for (const verdict of SECTION_CONTENT_VERDICTS) {
    expect(prose.output, `手改散文却报「${verdict}」:\n${prose.output}`).not.toContain(verdict);
  }

  // 反例①:区块正文被手改(表格里一个数字)。内容判定必须说话。
  const tampered = withSectionProbe(
    sectionProbeDoc([...SECTION_PROBE_BLOCK.slice(0, 2), "| 1 | 999 |"]),
    () => driftCheck(),
  );
  expect(tampered.status, "区块正文被手改必须非零退出").toBe(1);
  expect(tampered.output, tampered.output).toContain("区块与真源不一致");
  // 报告按标记指认是哪一段:只有 id 与路径,人看不出是哪一区块被手改了。
  expect(tampered.output, tampered.output).toContain(SECTION_PROBE_BEGIN);

  // 反例②:整段(两行标记 + 正文)被删。「让检查没东西可查」就是绕过检查的路,
  // 所以**抽不出区块必须按漂移报出来**,而不是悄悄跳过这一件。
  const removed = withSectionProbe(sectionProbeDocWithoutSection(), () => driftCheck());
  expect(removed.status, "整段被删必须非零退出").toBe(1);
  expect(removed.output, removed.output).toContain("抽不出区块");
  expect(removed.output, "删掉整段后必须说得出是整段没了").toContain("整段被删");
  expect(removed.output, "报告必须仍指着这一件生成物").toContain(SECTION_PROBE_BEGIN);

  // 反例③:标记被手改(区块正文一字未动)。少了这一条,「改掉标记另立一段」的形态没人管。
  const markerTampered = withSectionProbe(
    sectionProbeDoc(SECTION_PROBE_BLOCK).replace("section-probe:begin", "section-probe:start"),
    () => driftCheck(),
  );
  expect(markerTampered.status, "标记被手改必须非零退出").toBe(1);
  expect(markerTampered.output, markerTampered.output).toContain("抽不出区块");
  expect(markerTampered.output, "只剩一端标记要说得出是哪一种").toContain("只剩一端");

  // 反例④:只删掉**末行**那一行标记(起点还在)。它与上面三条都不同路:起点找得到、
  // 整条正则匹配不上。少了这一条,「删掉一端标记、留另一端顶着」就是一条没人管的绕过面。
  const endGone = withSectionProbe(
    sectionProbeDoc(SECTION_PROBE_BLOCK).replace(`${SECTION_PROBE_END}\n`, ""),
    () => driftCheck(),
  );
  expect(endGone.status, "末行标记被删必须非零退出").toBe(1);
  expect(endGone.output, endGone.output).toContain("抽不出区块");
  expect(endGone.output, "只删一端标记要说得出是哪一种").toContain("只剩一端");
  expect(endGone.output, "报告必须仍指着这一件生成物").toContain(SECTION_PROBE_BEGIN);

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成器:区块正文被手改后重跑 → 填回去且不动散文;标记没了则拒绝硬填", () => {
  // 反向的一条缝:填与抽是同一份机械(`section.ts`),所以「生成器写的」与「检查比的」必须是同一段字节。
  // 文档里的正文被手改 + 散文被手改,重跑之后:正文回到真源产出,散文一字不动。
  const docBefore = sectionProbeDoc([...SECTION_PROBE_BLOCK.slice(0, 2), "| 1 | 999 |"]);
  const proseLine = "又一段手写的散文。\n";

  withGeneratedArtifactsRestored(() =>
    withSectionProbe(`${docBefore}\n${proseLine}`, () => {
      const generated = script("generate");
      expect(generated.status, `生成器自身非零退出:\n${generated.output}`).toBe(0);

      const filled = readFileSync(`${repoRoot}${SECTION_PROBE_PATH}`, "utf8");
      expect(filled, "重跑后区块正文应当被填回真源产出").toContain(
        sectionProbeContent(SECTION_PROBE_BLOCK),
      );
      expect(filled, "重跑后区块外的散文必须逐字节不动").toContain(proseLine);

      const after = driftCheck();
      expect(after.output, `生成器填回去了,内容判定还在说话:\n${after.output}`).not.toContain(
        "区块与真源不一致",
      );
      // 生成器已经把它能做的做完了,剩下的红只来自版本库那一层(探针没入库),
      // 内容判定沉默就是这一条要的证据。
      expect(after.status, "重跑之后只剩版本库那一层在红").toBe(1);
      expect(after.output, after.output).toContain("不在版本库里");
      return after;
    }),
  );

  // 标记被删掉后重跑:生成器不猜这段该落在哪,非零退出并说明原因。
  const noMarker = withGeneratedArtifactsRestored(() =>
    withSectionProbe(sectionProbeDocWithoutSection(), () => script("generate")),
  );
  expect(noMarker.status, "目标文件里没有定界标记时生成器必须非零退出").toBe(1);
  expect(noMarker.output, noMarker.output).toContain("生成器:section-probe");
  expect(noMarker.output, noMarker.output).toContain(SECTION_PROBE_BEGIN);

  // 落点根本不存在(与「有文件、没有标记」分开):处方不同,报告也得说得出是哪一种。
  const noTarget = withGeneratedArtifactsRestored(() =>
    withSectionProbe(undefined, () => script("generate")),
  );
  expect(noTarget.status, "区块形态的落点不存在时生成器必须非零退出").toBe(1);
  expect(noTarget.output, "报告必须说得出是落点还没有,而不是让人去找标记").toContain(
    "读不出目标文件",
  );
  expect(noTarget.output, noTarget.output).toContain(SECTION_PROBE_BEGIN);

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

// ── 生成物漂移检查:规则文档的数值表(真源是数据文件,区块外散文不比) ─────────────────

/** 数值表那两件区块形态生成物的落点,以及它们的真源取值文件。 */
const RULESET_JSON = "rulesets/v1.json";
const RULES_DOC = "docs/rules-v1/rules.md";
const API_DOC = "docs/rules-v1/api.md";

/**
 * 改取值文件 → 跑 `body` → **按字节**还原,无论成败。
 *
 * 不经生成器还原,理由同 `withPatchedTruth`:否则这条反例的判决就依赖生成器是否正确。
 * 这一件的特别之处是**真源是数据文件**,所以改完立刻可判——不需要先 `tsc -b` 把真源编过去,
 * 门禁读的正是磁盘上那份 JSON。
 */
const withPatchedRuleset = (patch: (source: string) => string, body: () => Outcome): Outcome => {
  const truth = `${repoRoot}${RULESET_JSON}`;
  const original = readFileSync(truth, "utf8");
  const patched = patch(original);
  // 补丁没打上 = 判据随真源改了形状,这条用例会安静地测一个不存在的东西。必须当场红。
  expect(patched, "补丁没有改动取值文件,这条反例不成立").not.toBe(original);
  writeFileSync(truth, patched, "utf8");
  try {
    return body();
  } finally {
    writeFileSync(truth, original, "utf8");
  }
};

it("生成物漂移检查:规则文档数值表——改取值不重跑 → 变红,两份文档同时说话,还原 → 变绿", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  // 反例:改真源取值而**不重跑生成器**。两份文档里那段表格停在上一版,而检查当场读到的是新值。
  const stale = withPatchedRuleset(
    (source) => source.replace('"resourcePerSite": 200', '"resourcePerSite": 250'),
    () => driftCheck(),
  );
  expect(stale.status, "改了取值不重跑生成器,漂移检查必须非零退出").toBe(1);
  expect(stale.output, stale.output).toContain("区块与真源不一致");
  // 同一份内容的两处落点必须**同时**说话:少一处,就是有一份文档挂的不是这份真源,
  // 而它照样看起来是一份带表的文档。
  expect(stale.output, "机制文档那份数值表没有判红").toContain(RULES_DOC);
  expect(stale.output, "API 文档那份数值表没有判红").toContain(API_DOC);

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

it("生成物漂移检查:手改数值表区块正文 → 变红,手改表外散文 → 内容判定沉默,还原 → 变绿", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  const doc = `${repoRoot}${RULES_DOC}`;
  const original = readFileSync(doc, "utf8");

  // 形态一:改区块**外面**的一段散文。内容判定必须沉默——逐字节锁死整份文档的实现会把这一条变红,
  // 那正是区块形态要兑掉的形态。版本库那一刀仍会说话(文件整体未提交),所以退出码仍是 1。
  const prose = original.replace("# rules-v1 规则", "# rules-v1 规则(手写的一句话)");
  expect(prose, "补丁没有改到散文,这条反例不成立").not.toBe(original);
  writeFileSync(doc, prose, "utf8");
  try {
    const untouched = driftCheck();
    expect(untouched.output, `手改散文却报内容不一致:\n${untouched.output}`).not.toContain(
      "区块与真源不一致",
    );
  } finally {
    writeFileSync(doc, original, "utf8");
  }

  // 形态二:改区块**里面**的一格(表格里的一个数字)。内容判定必须说话,并按标记指认是哪一段。
  const tampered = original.replace("| `tickLimit` | 600 |", "| `tickLimit` | 999 |");
  expect(tampered, "补丁没有改到表格,这条反例不成立").not.toBe(original);
  writeFileSync(doc, tampered, "utf8");
  try {
    const violated = driftCheck();
    expect(violated.status, "手改区块正文必须非零退出").toBe(1);
    expect(violated.output, violated.output).toContain("区块与真源不一致");
    expect(violated.output, violated.output).toContain(
      "<!-- generated:rules-v1-value-table:begin -->",
    );
    // 只动了机制文档那一份,API 文档那份逐字节未动:报告不该把它一起点名
    // (那会让「哪一段漂了」这条信息变得没法用)。
    expect(violated.output, "没被动过的那一份也被点名了").not.toContain("api-v1-value-table");
  } finally {
    writeFileSync(doc, original, "utf8");
  }

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

// ── 预算结构门禁:已定稿预算键的结构断言(票 05)────────────────────────────

it("预算结构门禁:改一个预算取值(不是中断粒度的整数倍)→ 变红,按字节还原 → 变绿", () => {
  const clean = script("check:budget");
  expect(clean.status, clean.output).toBe(0);

  // 反例落在**数据文件**上(与数值表那一节同族):把事件计数上限改成一个不是中断粒度整数倍的数。
  // 门禁读的正是磁盘上那份 JSON,所以改完立刻可判、不需要先 `tsc -b`。
  const violated = withPatchedRuleset(
    (source) => source.replace('"eventTickLimit": 10000', '"eventTickLimit": 9999'),
    () => script("check:budget"),
  );
  expect(violated.status, "事件计数上限不是中断粒度整数倍时门禁必须非零退出").toBe(1);
  expect(violated.output, "报告必须指名那个键").toContain("eventTickLimit");
  expect(violated.output, "报告必须说清是整数倍这一条").toContain("整数倍");

  expect(script("check:budget").status, "还原后门禁没有回到绿").toBe(0);
});

it("预算结构门禁:内存夹逼被弄红——判罚线超过分配上限的一半 / 分配上限不足 8 倍 → 变红,还原 → 变绿", () => {
  const clean = script("check:budget");
  expect(clean.status, clean.output).toBe(0);

  // 反例:把判罚线抬到等于分配上限——既破了「判罚线 ≤ 分配上限的一半」,也破了「分配上限 ≥ 8 × 判罚线」。
  const violated = withPatchedRuleset(
    (source) => source.replace('"memoryTickCeiling": 524288', '"memoryTickCeiling": 4194304'),
    () => script("check:budget"),
  );
  expect(violated.status, "判罚线越过分配上限的一半时门禁必须非零退出").toBe(1);
  expect(violated.output, "报告必须指名内存两键").toContain("memoryTickCeiling");
  expect(violated.output, "报告必须说清是夹逼这一条").toContain("内存夹逼");

  expect(script("check:budget").status, "还原后门禁没有回到绿").toBe(0);
});

it("预算结构门禁:软阈(推导项)低于诚实存活堆峰值 → 变红,还原 → 变绿", () => {
  const clean = script("check:budget");
  expect(clean.status, clean.output).toBe(0);

  // 反例:判罚线取 250000。它仍满足夹逼(≤ 分配上限的一半、≥ 8 倍的反面也成立),但
  // 0.8 × 250000 = 200000 低于诚实峰值 201384——正常脚本会开始产内存压力观测。
  const violated = withPatchedRuleset(
    (source) => source.replace('"memoryTickCeiling": 524288', '"memoryTickCeiling": 250000'),
    () => script("check:budget"),
  );
  expect(violated.status, "软阈低于诚实峰值时门禁必须非零退出").toBe(1);
  expect(violated.output, "报告必须说清是软阈下界这一条").toContain("软阈下界");

  expect(script("check:budget").status, "还原后门禁没有回到绿").toBe(0);
});

it("预算结构门禁:体积上限低于基准产物最大值 → 变红,还原 → 变绿", () => {
  const clean = script("check:budget");
  expect(clean.status, clean.output).toBe(0);

  // 反例:把体积上限压到 4096——低于三份基准产物的最大值(cell-b 的 7579 字节)。
  // 这条下界不在默认链上(check:selfproof 按需跑),所以由本门禁带着。
  const violated = withPatchedRuleset(
    (source) => source.replace('"scriptSizeLimit": 32768', '"scriptSizeLimit": 4096'),
    () => script("check:budget"),
  );
  expect(violated.status, "体积上限低于基准产物最大值时门禁必须非零退出").toBe(1);
  expect(violated.output, "报告必须指名体积键").toContain("scriptSizeLimit");
  expect(violated.output, "报告必须说清是体积上限这一条").toContain("体积上限");

  expect(script("check:budget").status, "还原后门禁没有回到绿").toBe(0);
});

it("预算结构门禁:硬超时不足软限的 20 倍 → 变红,还原 → 变绿", () => {
  const clean = script("check:budget");
  expect(clean.status, clean.output).toBe(0);

  // 反例:硬超时压到 512——低于 20 × 软限 50 = 1000。硬超时是成本兜底,与只观测的软限的关系要钉住。
  const violated = withPatchedRuleset(
    (source) => source.replace('"wallClockHardTimeout": 1024', '"wallClockHardTimeout": 512'),
    () => script("check:budget"),
  );
  expect(violated.status, "硬超时不足软限的 20 倍时门禁必须非零退出").toBe(1);
  expect(violated.output, "报告必须指名硬超时键").toContain("wallClockHardTimeout");
  expect(violated.output, "报告必须说清是墙钟硬超时这一条").toContain("墙钟硬超时");

  expect(script("check:budget").status, "还原后门禁没有回到绿").toBe(0);
});

it("预算结构门禁挂在 check:quick,且没被挪进按需 / 慢链", () => {
  const scripts = manifest().scripts;
  // 在场:它必须挂在默认的快门禁上,否则改预算取值时没人拦。
  expect(scripts["check:quick"] ?? "", "预算结构门禁不在快门禁里").toContain("check:budget");
  // 缺席:零构建的静态门禁不该混进按需 / 慢链,也不该进默认功能测试(那是套娃)。
  expect(scripts["check:selfproof"] ?? "", "预算结构门禁被挪进了按需门禁").not.toContain(
    "check:budget",
  );
  expect(scripts["test:slow"] ?? "", "预算结构门禁被挪进了慢链").not.toContain("check:budget");
  expect(scripts["test"] ?? "", "预算结构门禁被挪进了默认测试").not.toContain("check:budget");
  // 末尾那组仍是「提交内容对不对」的复核:结构门禁不属于那里。
  expect(tailSteps(), "预算结构门禁被挪进了全量门禁末尾复核组").not.toContain("check:budget");
});

// ── 生成物漂移检查:API 面的表(真源是符号表与后果行,落在契约文档的正文里) ─────────

/** 注入面符号表那一件的真源:它渲染成契约文档里的一段区块,而它的落点是一份手写散文夹着的文档。 */
const INJECTED_SURFACE_TRUTH = "packages/schema/src/script-surface.ts";

it("生成物漂移检查:API 表区块——改真源不重跑 → 变红,手改区块正文 → 变红,还原 → 变绿", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  // 反例①:改真源(一行「为什么收」的措辞)而**不重跑生成器**。真源是 `.ts`,所以这一条比数值表
  // 那一节多一道前提:改了得先 `tsc -b` 编过去,否则门禁读到的还是上一版 dist,这条反例会假绿。
  const stale = withPatchedTruth(
    { truth: INJECTED_SURFACE_TRUTH, rewritten: [API_DOC] },
    (source) =>
      source.replace(
        'reason: "当前 tick 号;脚本每 tick 都要读一次时间轴,读出来是个数值。",',
        'reason: "当前 tick 号(探针改的措辞);读出来是个数值。",',
      ),
    { regenerate: false },
    () => driftCheck(),
  );
  expect(stale.status, "改了真源不重跑生成器,漂移检查必须非零退出").toBe(1);
  expect(stale.output, stale.output).toContain("区块与真源不一致");
  // 报告按标记指认是哪一段:API 表与数值表落在同一份文档里,不指认就没法一眼看出是哪半边。
  expect(stale.output, stale.output).toContain("<!-- generated:api-v1-api-surface:begin -->");
  // 反过来也成立:逐字节未动的那几段**不该**被点名(它们读的是别的真源)。
  expect(stale.output, "没被动过的数值表被连坐点名了").not.toContain("api-v1-value-table");
  expect(stale.output, "没被动过的对照表被连坐点名了").not.toContain("api-v1-outcome-table");
  expect(stale.output, "没被动过的整文件生成物被连坐点名了").not.toContain("script-surface-names");

  // 反例②:手改文档里那段区块正文(把签名里的一个参数名改掉)。形状与逐字节锁死整份文档时一样,
  // 但报告只该说这一段。
  const doc = `${repoRoot}${API_DOC}`;
  const original = readFileSync(doc, "utf8");
  const tampered = original.replace("| `getTick(): number` |", "| `getTick(n: number): number` |");
  expect(tampered, "补丁没有改到 API 表,这条反例不成立").not.toBe(original);
  writeFileSync(doc, tampered, "utf8");
  try {
    const violated = driftCheck();
    expect(violated.status, "手改 API 表区块正文必须非零退出").toBe(1);
    expect(violated.output, violated.output).toContain("区块与真源不一致");
    expect(violated.output, violated.output).toContain(
      "<!-- generated:api-v1-api-surface:begin -->",
    );
  } finally {
    writeFileSync(doc, original, "utf8");
  }

  expect(driftCheck().status, "还原后漂移检查没有回到绿").toBe(0);
});

// ── 依赖门禁反例:注入违规,确认规则真的挂在图上 ────────────────────────────────

it("依赖门禁:engine 一旦 import runner 或 gen 就红,撤掉即绿", () => {
  const clean = script("check:deps");
  expect(clean.status, clean.output).toBe(0);

  // 一条规则、两个禁止目标(runner / gen)写成 `(?:specifier|resolved)` 交替式。
  // 两侧必须各测一次:交替式写漏一半时,另一侧照样绿——只测一侧的话,
  // “gen 那半边静默失效”不会被任何东西发现。
  for (const target of ["runner", "gen"] as const) {
    const violated = withProbeFile(
      "packages/engine/dist/__gate-probe.js",
      `import "@model-war/${target}";\n`,
      () => script("check:deps"),
    );
    expect(violated.status, `engine import ${target} 必须非零退出`).not.toBe(0);
    expect(violated.output, violated.output).toContain("engine-must-not-depend-on-runner-or-gen");
    expect(violated.output, violated.output).toContain(`@model-war/${target}`);
  }

  const restored = script("check:deps");
  expect(restored.status, restored.output).toBe(0);
});

it("依赖门禁:runner 一旦 import engine 就红,撤掉即绿", () => {
  const clean = script("check:deps");
  expect(clean.status, clean.output).toBe(0);

  const violated = withProbeFile(
    "packages/runner/dist/__gate-probe.js",
    'import { replayTickLine } from "@model-war/engine";\nexport const probe = replayTickLine;\n',
    () => script("check:deps"),
  );
  expect(violated.status, "注入跨包方向违规后必须非零退出").not.toBe(0);
  expect(violated.output, violated.output).toContain("runner-must-not-depend-on-engine");

  const restored = script("check:deps");
  expect(restored.status, restored.output).toBe(0);
});

it("依赖门禁:gen 一旦 import engine / runner / replay 就红,撤掉即绿", () => {
  const clean = script("check:deps");
  expect(clean.status, clean.output).toBe(0);

  // 三个禁止目标写在同一台 `(?:specifier|resolved)` 交替式里:写漏一个时另外两个照样绿,所以三个各注一次。
  // 判据是「有一条违规行同时点名这条规则与这个目标」——只断言输出里出现过 `@model-war/<target>` 不够:
  // 探针那个 import 解析不到(gen 没声明这三个依赖),`not-to-unresolvable` 那行也带着这个串,
  // 于是「规则没挂上」会以绿的样子混过去。
  for (const target of ["engine", "runner", "replay"] as const) {
    const violated = withProbeFile(
      "packages/gen/dist/__gate-probe.js",
      `import "@model-war/${target}";\n`,
      () => script("check:deps"),
    );
    expect(violated.status, `gen import ${target} 必须非零退出`).not.toBe(0);
    const named = violated.output
      .split("\n")
      .filter(
        (line) =>
          line.includes("gen-must-not-depend-on-engine-runner-replay") &&
          line.includes(`@model-war/${target}`),
      );
    expect(
      named.length,
      `没有一条违规行同时点名这条规则与 @model-war/${target}:\n${violated.output}`,
    ).toBeGreaterThan(0);
  }

  const restored = script("check:deps");
  expect(restored.status, restored.output).toBe(0);
});

it("依赖门禁:engine 运行时一旦 import 第二个内建模块就红,撤掉即绿", () => {
  const clean = script("check:deps");
  expect(clean.status, clean.output).toBe(0);

  // 这条与上面那条不可互相替代:上面证明的是「包 → 包」那条边,
  // 这里证明的是「包 → 包外内建模块」那条边。两条规则的 from/to 条件不同,
  // 一条绿一条红完全可能发生(例如将来有人放宽包方向而没碰内建模块白名单)。
  const violated = withProbeFile(
    "packages/engine/dist/__gate-probe.js",
    'import { readFileSync } from "node:fs";\nexport const probe = readFileSync;\n',
    () => script("check:deps"),
  );
  expect(violated.status, "engine 运行时 import node:fs 必须非零退出").not.toBe(0);
  expect(violated.output, violated.output).toContain("engine-runtime-only-allows-node-crypto");

  const restored = script("check:deps");
  expect(restored.status, restored.output).toBe(0);
});

// ── 「声明即依赖」门禁反例:在工具包里 import 未声明的包 ────────────────────────────

it("声明即依赖门禁:工具包 import 未声明的包就红,撤掉即绿", () => {
  const clean = script("check:declared-deps");
  expect(clean.status, clean.output).toBe(0);
  // 反面证据:必须真的检查到了文件。「一个文件都没读到」是门禁目标失效的形态,
  // 那种情况入口会报 stderr 并按失败处理,但一条只会安静地扫零文件的规则更危险。
  expect(clean.output, `门禁没有报告检查规模,疑似空跑:\n${clean.output}`).toContain("检查");

  // 探针落在工具包的**运行时源码**里,引一个根上装着、而 packages/tools/package.json 没声明的包
  // (vitest 在根 devDependencies 里)。这正是仓库此前真实吃着的那条偷跑形态:tsc -b 退出 0,
  // 因为模块解析一路向上找到了根的 node_modules——只有这道门禁会红。
  const violated = withProbeFile(
    "packages/tools/src/__declared-deps-probe.ts",
    'import { expect, it } from "vitest";\nexport const probe = [expect, it];\n',
    () => script("check:declared-deps"),
  );
  expect(violated.status, "未声明的依赖必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("undeclared-dependency");
  expect(violated.output, violated.output).toContain("vitest");
  expect(violated.output, violated.output).toContain("__declared-deps-probe.ts");

  // 同一个探针换成已声明的依赖:判决跟着声明走,不是跟着文件名走。
  const declared = withProbeFile(
    "packages/tools/src/__declared-deps-probe.ts",
    'import { parseSync } from "oxc-parser";\nexport const probe = parseSync;\n',
    () => script("check:declared-deps"),
  );
  expect(declared.status, `已声明的依赖仍被拦下:\n${declared.output}`).toBe(0);

  expect(script("check:declared-deps").status, "撤掉探针后门禁没有回到绿").toBe(0);
});

// ── 格式门禁反例 ─────────────────────────────────────────────────────────────

it("格式门禁:未格式化的文件被拦下,由 oxfmt 修好后放行", () => {
  const clean = script("fmt");
  expect(clean.status, clean.output).toBe(0);

  const unformatted = "export const   fmtProbe   =    {a:1,   b:2}\n";

  const violated = withProbeFile("packages/schema/src/__fmt-probe.js", unformatted, () =>
    script("fmt"),
  );
  expect(violated.status, "未格式化文件必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("__fmt-probe.js");

  // 「格式化后通过」由真实的 oxfmt 去做,不由本测试代劳:自己拼一个「大概合格」的形态再拿去问门禁,
  // 问的不是门禁在比什么。
  const fixed = withProbeFile("packages/schema/src/__fmt-probe.js", unformatted, () => {
    const formatted = run(bin("oxfmt"), ["packages/schema/src/__fmt-probe.js"]);
    expect(formatted.status, `oxfmt 自身失败:\n${formatted.output}`).toBe(0);
    return script("fmt");
  });
  expect(fixed.status, `oxfmt 改过之后仍被拦下:\n${fixed.output}`).toBe(0);

  expect(script("fmt").status).toBe(0);
});

// ── 格式门禁覆盖面:根层那份脚本 tsconfig 也在门里 ───────────────────────────

it("参赛脚本的编译配置在格式门禁的覆盖范围内:它排版坏掉就红,按字节还原 → 绿", () => {
  // 根层配置逐个点名进了 fmt 的路径列表(`tsconfig.json`、`tsconfig.base.json` 之后多了一个)。
  // 少了这一条,那份配置就成了一份无人看管的配置:它既不在任何 tsc project 的 include 里
  // (根 `tsconfig.json` 是 files: []),oxlint 也不扫根层文件——排版坏了没有任何门禁会说话。
  //
  // 探针用的是**真实的配置文件本身**(按字节还原),不是临时目录里的另一份:只有动真文件,
  // 「路径在不在 fmt 的列表里」这件事才会被判决到。JSON 仍合法,变的只是排版。
  const config = `${repoRoot}tsconfig.scripts.json`;
  const original = readFileSync(config, "utf8");
  const mangled = original
    .replace('    "types": [],', '    "types":[],')
    .replace('"lib": ["es2023"],', '"lib":["es2023"],');
  expect(mangled, "补丁没有改动配置,这条反例不成立").not.toBe(original);
  writeFileSync(config, mangled, "utf8");

  try {
    const violated = script("fmt");
    expect(violated.status, "配置排版坏掉却过了格式门禁,说明它不在门里").toBe(1);
    expect(violated.output, violated.output).toContain("tsconfig.scripts.json");
  } finally {
    writeFileSync(config, original, "utf8");
  }

  expect(script("fmt").status, "还原后格式门禁没有回到绿").toBe(0);
});

// ── lint 门禁反例 ────────────────────────────────────────────────────────────

it("lint 门禁:被禁写法被拦下,改正后放行", () => {
  const clean = script("lint");
  expect(clean.status, clean.output).toBe(0);

  const banned = "const declaredButNeverUsed = 41 + 1;\nexport const kept = 1;\n";
  const corrected = "export const kept = 1;\n";

  const violated = withProbeFile("packages/schema/src/__lint-probe.js", banned, () =>
    script("lint"),
  );
  expect(violated.status, "被禁写法必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("no-unused-vars");

  // 同一个路径、同一道门禁,只把内容换成改正后的形态。
  // 路径不变这一条才是重点:它证明门禁的判决跟内容走,而不是跟文件名走。
  const fixed = withProbeFile("packages/schema/src/__lint-probe.js", corrected, () =>
    script("lint"),
  );
  expect(fixed.status, `改正之后仍被拦下:\n${fixed.output}`).toBe(0);

  // 反例二:类型层面的硬禁令(no-explicit-any)。它证明 .oxlintrc.json 里手写的 rules 真的在生效,
  // 而不只是 oxlint 的 correctness 类别在兜底——后者默认全是 warn,压根不会让退出码非零。
  // 探针因此取 .ts:`typescript/*` 那批规则不施加到 .js 上。
  const anyViolated = withProbeFile(
    "packages/schema/src/__lint-probe.ts",
    "export const anything: any = 1;\n",
    () => script("lint"),
  );
  expect(anyViolated.status, "any 必须非零退出").toBe(1);
  expect(anyViolated.output, anyViolated.output).toContain("no-explicit-any");

  const anyFixed = withProbeFile(
    "packages/schema/src/__lint-probe.ts",
    "export const anything: unknown = 1;\n",
    () => script("lint"),
  );
  expect(anyFixed.status, `unknown 仍被拦下:\n${anyFixed.output}`).toBe(0);

  expect(script("lint").status).toBe(0);
});

// ── 基准产物门禁反例:产物与源码分叉即红 ─────────────────────────────────────

/**
 * 反例手法:改入库产物里的**一个字节**,不改源码。
 *
 * 选产物而不是源码:改源码那一步,任何「产物是编译出来的」机制都会跟着变红,
 * 证明不了「入库的产物没人重新编译过」这一件——而那正是产物入库的理由
 * (clone 完直接能跑)。所以这里只动产物。
 */
it("基准产物门禁:入库的产物与源码分叉 → 变红,按字节还原 → 变绿", () => {
  const product = `${repoRoot}benchmarks/cell-c-claim-no-harvest/script.js`;
  const committed = readFileSync(product);

  const clean = script("check:bench");
  expect(clean.status, clean.output).toBe(0);
  // 绿的时候报告要说清「判的是哪几份」,否则红起来时没人知道漏了谁。
  expect(clean.output, clean.output).toContain("基准产物门禁:绿(3 份");

  try {
    // 只改最后一行的缩进:编译产物的内容不变而字节变了——正是「手改过」与「编译出来的」的分界。
    writeFileSync(product, committed.toString("utf8").replace(/\n$/, "\n\n"), "utf8");
    const drifted = script("check:bench");
    expect(drifted.status, "入库的产物与源码分叉了,门禁必须非零退出").not.toBe(0);
    expect(drifted.output, drifted.output).toContain("cell-c-claim-no-harvest");
    expect(drifted.output, drifted.output).toContain("与重新编译的结果不一致");
    expect(drifted.output, drifted.output).toContain("基准产物门禁:红");
  } finally {
    writeFileSync(product, committed);
  }

  const restored = script("check:bench");
  expect(restored.status, `按字节还原后没有回到绿:\n${restored.output}`).toBe(0);
});

it("基准产物门禁挂在全量门禁末尾,且不进快门禁", () => {
  // 与漂移检查同一位置纪律:提交内容对不对的那几道复核都在末尾(清单见上)。
  expect(tailSteps(), "基准产物门禁不在全量门禁末尾那一组复核里").toContain("pnpm run check:bench");

  // 它要 spawn 一次 tsc,与快门禁的零构建性质不相容(理由同 check:drift)。
  expect(manifest().scripts["check:quick"]).not.toContain("check:bench");
  expect(manifest().scripts["check:types"]).not.toContain("check:bench");
});

// ── runtime bundle 门禁反例:手改入库产物一个字节即红 ─────────────────────────

/**
 * 反例手法:改入库产物里的**一个字节**,不改源码。
 *
 * 选产物而不是源码:改源码那一步,任何「产物是构建出来的」机制都会跟着变红,
 * 证明不了「入库的产物没人再动过」这一件——而那正是产物入库的理由(第三方凭存档复算)。
 */
it("runtime bundle 门禁:手改入库产物一个字节 → 红,按字节还原 → 绿", () => {
  const product = `${repoRoot}${SANDBOX_RUNTIME_ARTIFACT_PATH}`;
  const committed = readFileSync(product);

  const clean = script("check:runtime");
  expect(clean.status, clean.output).toBe(0);
  expect(clean.output, clean.output).toContain("runtime bundle 门禁:绿");

  try {
    // 只多一个换行:内容看着没变而字节变了——正是「手改过」与「构建出来的」的分界。
    writeFileSync(product, `${committed.toString("utf8")}\n`, "utf8");
    const drifted = script("check:runtime");
    expect(drifted.status, "入库的产物被手改了,门禁必须非零退出").not.toBe(0);
    expect(drifted.output, drifted.output).toContain("与重新构建的结果不一致");
    expect(drifted.output, drifted.output).toContain("runtime bundle 门禁:红");
  } finally {
    writeFileSync(product, committed);
  }

  const restored = script("check:runtime");
  expect(restored.status, `按字节还原后没有回到绿:\n${restored.output}`).toBe(0);
});

it("runtime bundle 门禁挂在全量门禁末尾,且不进快门禁", () => {
  // 与漂移检查、基准产物门禁同一位置纪律:提交内容对不对的那几道复核都在末尾。
  expect(tailSteps(), "runtime bundle 门禁不在全量门禁末尾那一组复核里").toContain(
    "pnpm run check:runtime",
  );

  // 它要 spawn 一次 esbuild,与快门禁的零构建性质不相容(理由同 check:drift)。
  expect(manifest().scripts["check:quick"]).not.toContain("check:runtime");
  expect(manifest().scripts["check:types"]).not.toContain("check:runtime");
});

// ── 契约自证门禁:按需,不在 check 里 ────────────────────────────────────────
//
// 四问的退出码与三个反例在 `gates-slow.test.ts`(要跑矩阵,单次约 85s,合计约 350s)。
// 留在这一份文件里的只有它的**位置纪律**——那一条不跑任何命令,只读 manifest,耗时可忽略。
//
// 为什么它**不进 `check`**:它要真跑 64 场对局(6 路并行,8 核机上墙钟约 80s),
// 而那是全量门禁其余七步加起来(约 9s)的九倍。挂着它的 `check` 名义上是「提交前跑一遍」,
// 实际上八成时间花在一道与提交内容无关的重测算上——**命令名与它真实的时间代价对不上,
// 人就会开始不跑它,或者每次都跳过它**,两种都等价于没有这道门禁。
// 诚实的做法是把它标成按需:它有自己的脚本(`pnpm run check:selfproof`),有自己的反例
// (`test:slow`),改契约 / 改 `rulesets/` / 改自证桩时手工敲。
//
// **代价要说清楚**:它从「每次 check 都拦」退化成「想跑才拦」,而它是 srs 那条机器防线的唯一执行者。
// 这条退化是**自觉换来的**,不是漏掉的;下面两条断言盯着的正是它换来的东西——
// 「不在 check 里」与「有独立入口 + 有反例覆盖」,少任何一半,这个决定就没有代价交换。

it("契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖", () => {
  const scripts = manifest().scripts;
  // 缺席:它不在全量门禁的任何一个 project 里(含末尾那一组)。
  expect(scripts["check"] ?? "", "契约自证门禁还在 check 里").not.toContain("check:selfproof");
  expect(tailSteps(), "契约自证门禁还在全量门禁末尾那一组复核里").not.toContain("check:selfproof");
  // 也不在快门禁与类型门禁里——那两处它从来就不该在,留着这条是为了挡住「顺手挪进去」。
  expect(scripts["check:quick"], "契约自证门禁被挪进了快门禁").not.toContain("check:selfproof");
  expect(scripts["check:types"], "契约自证门禁被挪进了类型门禁").not.toContain("check:selfproof");
  // 在场:按需入口还在(它是这件事的全部意义),且测试侧的反例由 test:slow 承载。
  expect(scripts["check:selfproof"] ?? "", "按需入口没了,这道门禁从此没人跑").toContain(
    "run-selfproof-gate.ts",
  );
  expect(scripts["test:slow"] ?? "", "契约自证的反例没有落进可手工调用的入口").toContain(
    "--project slow",
  );
  // 慢检查只保留独立入口,快速验证命令不能把它们隐式带入。
  for (const entry of ["check", "check:quick", "check:types", "test", "verify:fast"] as const) {
    expect(scripts[entry] ?? "", `慢门禁被放进快速入口 ${entry}`).not.toContain("test:slow");
    expect(scripts[entry] ?? "", `慢门禁被放进快速入口 ${entry}`).not.toContain("check:selfproof");
  }
  // 与基准产物门禁同侧:末尾那一组仍然全是「提交内容对不对」的复核。
  expect(tailSteps(), "基准产物门禁被挤出了末尾那一组").toContain("pnpm run check:bench");
});

// ── 跨进程一致性门禁:按需,不在 check 里 ────────────────────────────────────
//
// 正例与反例(真沙箱跑一局,单次约 11s)在 `gates-slow.test.ts`。留在这里的只有它的**位置纪律**
// ——那一条只读 manifest,耗时可忽略。它不进 `check` / 快门禁的理由与契约自证门禁同源:它要 spawn
// 一次 `tsc -b` + esbuild 再真跑一局真沙箱,与快门禁的零构建性质不相容(spec §3 与用户故事 19)。

it("跨进程一致性门禁按需跑:不在快链里,但有独立入口", () => {
  const scripts = manifest().scripts;
  // 缺席:它不在任何一个常跑入口里。
  for (const entry of ["check", "check:quick", "check:types", "test", "verify:fast"] as const) {
    expect(scripts[entry] ?? "", `跨进程门禁被放进快速入口 ${entry}`).not.toContain(
      "check:cross-process",
    );
  }
  // 也不在末尾那一组复核里——它按需跑,不是「提交内容对不对」的复核。
  expect(tailSteps(), "跨进程门禁混进了末尾那一组").not.toContain("check:cross-process");
  // 在场:按需入口还在(它是这件事的全部意义)。
  expect(scripts["check:cross-process"] ?? "", "按需入口没了,这道门禁从此没人跑").toContain(
    "run-cross-process-gate.ts",
  );
});

// ── 反递归不变量 ─────────────────────────────────────────────────────────────

it("gates 不在 unit 的拾取范围里(否则 check 会套娃成叉炸弹)", () => {
  // 现状一旦破掉,后果是 check → 本文件 → check → 本文件 的无限套娃,
  // 而且它只在有人手工跑 check 时才发作,前面所有门禁全绿也拦不住。
  // 所以在这里显式断言一次:拿 vitest 自己的拾取结果当证据,不去猜 include 的匹配语义。
  const listed = run("pnpm", ["exec", "vitest", "list", "--project", "unit"]);
  expect(listed.status, listed.output).toBe(0);
  expect(listed.output, "gates.test.ts 被 unit 收进去了,check 会无限套娃").not.toContain(
    "gates.test.ts",
  );

  // 顺带确认另一侧真的收进去了:排除过头和没排除是同一种失败。
  const gatesListed = run("pnpm", ["exec", "vitest", "list", "--project", "gates"]);
  expect(gatesListed.status, gatesListed.output).toBe(0);
  expect(gatesListed.output, gatesListed.output).toContain("gates.test.ts");
});

it("慢的那一半(slow project)不被任何常跑入口拾取", () => {
  // `gates-slow.test.ts` 会 spawn `check`,所以它对 unit 的禁令与 gates.test.ts 完全同源:
  // 一旦被 `check` 里的 `vitest run --project unit` 收进去,后果同样是套娃,而且同样
  // 只在有人手工跑 check 时才发作。所以这里对三个常跑 project 各断言一次。
  for (const project of ["unit", "property", "gates"] as const) {
    const listed = run("pnpm", ["exec", "vitest", "list", "--project", project]);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output, `gates-slow.test.ts 被 ${project} 收进去了`).not.toContain(
      "gates-slow.test.ts",
    );
  }
  // 反面证据:它确实被自己的 project 收着(排除过头与没排除是同一种失败)。
  const slowListed = run("pnpm", ["exec", "vitest", "list", "--project", "slow"]);
  expect(slowListed.status, slowListed.output).toBe(0);
  expect(slowListed.output, slowListed.output).toContain("gates-slow.test.ts");

  // 默认 `test` 只跑快速的 unit + property;门禁自测与慢 project 都有独立入口。
  // 用显式 `--project` 列举而不是靠默认拾取规则,所以这里断言列举本身。
  const test = manifest().scripts["test"] ?? "";
  expect(test, "默认 test 不该跑 slow project").not.toContain("--project slow");
  for (const project of ["unit", "property"]) {
    expect(test, `快速 test 显式漏掉了 ${project}`).toContain(`--project ${project}`);
  }
  expect(test, "默认 test 不应包含门禁自测").not.toContain("--project gates");
  // 按需入口得在:它被拆出来是为了「有需要时手工跑」,没有脚本这件事就没做完。
  expect(manifest().scripts["test:slow"], "慢门禁自测没有落进可手工调用的脚本").toContain(
    "--project slow",
  );
});
