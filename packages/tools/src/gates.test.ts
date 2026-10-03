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
 *   - **落进真源与生成物**(生成器那一节):先改真源、不重跑生成器,规则层读到的还是上一版——
 *     这本身是漂移检查(票 04)要抓的形态,但在本票里它有个更直接的后果可测:
 *     真源改了 + 重跑生成器,门禁判决必须跟着变。
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
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = here("../../../");
const bin = (name: string): string => here(`../../../node_modules/.bin/${name}`);

type Outcome = { status: number; output: string };

const run = (command: string, args: readonly string[]): Outcome => {
  const result = spawnSync(command, [...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

/** 跑一条根脚本。`pnpm` 走 PATH 上的 corepack shim;可用 GATE_PNPM 覆盖。 */
const script = (name: string, args: readonly string[] = []): Outcome =>
  run(process.env["GATE_PNPM"] ?? "pnpm", ["run", name, ...args]);

/**
 * 漂移检查那一节用的三个探针路径(常量提到这里,好让 `afterAll` 的兜底清理能引用它们):
 * 一件是「登记进注册表但没进版本库」的生成物,同一件的两种藏法(普通未跟踪 / 被 `.gitignore`
 * 命中),以及一个「与生成物无关的未跟踪文件」。
 */
const EXTRA_ARTIFACT_PATH = "packages/tools/src/generated/__drift-probe.ts";
const IGNORED_ARTIFACT_PATH = "packages/tools/dist/__drift-probe.ts";
const UNRELATED_NOISE_PATH = "docs/__drift-noise-probe.md";

/** 本文件用过的全部探针路径。 */
const PROBES = [
  "packages/schema/src/__fmt-probe.js",
  "packages/schema/src/__lint-probe.js",
  "packages/schema/src/__lint-probe.ts",
  "packages/engine/src/__nofloat-probe.ts",
  "packages/tools/src/__declared-deps-probe.ts",
  "packages/runner/dist/__gate-probe.js",
  "packages/engine/dist/__gate-probe.js",
  EXTRA_ARTIFACT_PATH,
  IGNORED_ARTIFACT_PATH,
  UNRELATED_NOISE_PATH,
] as const;

/** 放一个探针进去,跑 `body`,无论成败都把它撤掉。 */
const withProbeFile = (path: string, contents: string, body: () => Outcome): Outcome => {
  writeFileSync(`${repoRoot}${path}`, contents, "utf8");
  try {
    return body();
  } finally {
    rmSync(`${repoRoot}${path}`, { force: true });
  }
};

afterAll(() => {
  for (const probe of PROBES) {
    rmSync(`${repoRoot}${probe}`, { force: true });
  }
});

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

it("check(全量门禁)退出 0", () => {
  const result = script("check");
  expect(result.status, result.output).toBe(0);
});

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

// ── 禁浮点门禁反例 ───────────────────────────────────────────────────────────

it("禁浮点门禁:engine 源码里出现浮点字面量就红,撤掉即绿", () => {
  const clean = script("check:no-float");
  expect(clean.status, clean.output).toBe(0);

  // 探针落在 engine 的运行时代码里,而且是 .ts 而非 .js:这道门禁读的是**源码**
  // (自建校验器建在 oxc-parser 上,不经 tsc 产物),所以在 dist 里丢文件它根本看不见。
  // 位置与扩展名合起来才是「它真的在读该读的那片源码」的证据。
  const violated = withProbeFile(
    "packages/engine/src/__nofloat-probe.ts",
    "export const speed = 1.5;\n",
    () => script("check:no-float"),
  );
  expect(violated.status, "浮点字面量必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("__nofloat-probe.ts");

  // 同一路径换成整数:判决跟着内容走,不是跟着文件名走。
  const fixed = withProbeFile(
    "packages/engine/src/__nofloat-probe.ts",
    "export const speed = 3;\n",
    () => script("check:no-float"),
  );
  expect(fixed.status, `整数仍被拦下:\n${fixed.output}`).toBe(0);

  expect(script("check:no-float").status).toBe(0);
});

// ── 生成器:改真源 → 重跑 → 门禁的判决跟着变 ───────────────────────────────────

/** 白名单的真源与它的生成物。规则层读的是后者,所以只改前者不会有任何效果——必须重跑。 */
const SCHEMA_ALLOWLIST = "packages/schema/src/builtin-globals.ts";
const GENERATED_ALLOWLIST = "packages/tools/src/generated/builtin-globals.ts";

/** 探针:一条用到 `Math.abs` 的运行时代码。 */
const MATH_ABS_PROBE = "export const probe = Math.abs(-1);\n";

/**
 * 改真源 →(可选地跑根脚本 `generate`)→ 跑 `body`,无论成败都把真源与生成物**按字节**还原。
 *
 * 还原走字节而不是「再跑一次生成器」,是为了让「本用例有没有留下副作用」与生成器是否正确无关:
 * 生成器坏了也不该由还原路径顺手把它修好,那样这条用例的判决就永远绿。
 *
 * `regenerate: false` 是漂移检查那一节要的反例形态:改了真源**故意不重跑**,留下的正是
 * 「生成物停在上一版」那个状态。两条用例共用这一条还原路径,免得仓库里有两份。
 */
const withPatchedTruth = (
  patch: (source: string) => string,
  options: { readonly regenerate: boolean },
  body: () => Outcome,
): Outcome => {
  const truth = `${repoRoot}${SCHEMA_ALLOWLIST}`;
  const generated = `${repoRoot}${GENERATED_ALLOWLIST}`;
  const originalTruth = readFileSync(truth, "utf8");
  const originalGenerated = readFileSync(generated, "utf8");

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
    writeFileSync(truth, originalTruth, "utf8");
    writeFileSync(generated, originalGenerated, "utf8");
    // 真源还原之后,`packages/schema/dist` 可能停在被改过的源码上。补一次构建,
    // 让后续用例(尤其依赖已就位产物的 check:deps 与漂移检查)看到一致状态;结果不额外断言,
    // 断言留给那些真正依赖构建产物的用例,免得它盖掉 body 原本的失败信息。
    script("build");
  }
};

/** `withPatchedTruth` 的「改了真源并重跑生成器」那一档。 */
const withRegeneratedAllowlist = (
  patch: (source: string) => string,
  body: () => Outcome,
): Outcome => withPatchedTruth(patch, { regenerate: true }, body);

it("生成器:改真源重跑后,禁浮点门禁的白名单判决随之改变", () => {
  // 基线:`abs` 在名单里,用到它的脚本放行。没有它,后面那个「变红」可能只是探针本身写得不对。
  const allowed = withProbeFile("packages/engine/src/__nofloat-probe.ts", MATH_ABS_PROBE, () =>
    script("check:no-float"),
  );
  expect(allowed.status, `名单内的成员被拦下:\n${allowed.output}`).toBe(0);

  // 从真源里摘掉 `abs` 并重跑生成器:同一条探针,从通过变拒绝。这就是「改真源 → 门禁行为改变」
  // 这条链的正面证据,断言落在门禁的退出码与报告文本上,不碰任何内部函数。
  const removed = withRegeneratedAllowlist(
    (source) => source.replace('  "abs",\n', ""),
    () =>
      withProbeFile("packages/engine/src/__nofloat-probe.ts", MATH_ABS_PROBE, () =>
        script("check:no-float"),
      ),
  );
  expect(removed.status, "真源摘掉成员后,用到它的脚本必须被拒绝").toBe(1);
  expect(removed.output, removed.output).toContain("Math.abs");

  // 同一时刻仍在名单里的成员照旧放行:变红的是「白名单」,不是整道门禁——
  // 少了这一条,「生成器把规则层弄坏了」也会被算作通过。
  const stillAllowed = withRegeneratedAllowlist(
    (source) => source.replace('  "abs",\n', ""),
    () =>
      withProbeFile(
        "packages/engine/src/__nofloat-probe.ts",
        "export const probe = Math.sign(-1);\n",
        () => script("check:no-float"),
      ),
  );
  expect(stillAllowed.status, `名单内的其他成员被连坐:\n${stillAllowed.output}`).toBe(0);

  // 链路的另一头:还原后门禁回到绿。少了它,一条「红到底」的假实现也能满足上面三条。
  expect(script("check:no-float").status, "还原后禁浮点门禁没有回到绿").toBe(0);
});

// ── 生成物漂移检查反例 ────────────────────────────────────────────────────────

/** 漂移检查的命名脚本。它需要构建前置(生产函数 import 真源包),所以只挂在全量门禁末尾。 */
const driftCheck = (): Outcome => script("check:drift");

it("生成物漂移检查:改真源不重跑 → 变红,重跑并提交 → 变绿", () => {
  const clean = driftCheck();
  expect(clean.status, clean.output).toBe(0);

  // 反例①:真源加一个成员,生成器不跑。生成物路径上的内容一字未动,所以**只有**「重生成后无差异」
  // 那一段能抓住它——这正是这道检查不能只做 git 两刀的理由。
  const stale = withPatchedTruth(
    (source) => source.replace('  "abs",\n', '  "abs",\n  "sign2",\n'),
    { regenerate: false },
    () => driftCheck(),
  );
  expect(stale.status, "改了真源不重跑,漂移检查必须非零退出").toBe(1);
  expect(stale.output, stale.output).toContain(GENERATED_ALLOWLIST);

  // 同一处真源改动 + 重跑生成器:内容回到一致,剩下「未提交」那一刀,红的原因跟着变。
  // 少了这条,「它只会报那句生成器提示」也能满足上面两条。
  const regenerated = withPatchedTruth(
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
  const registry = `${repoRoot}packages/tools/src/generate/registry.ts`;
  const original = readFileSync(registry, "utf8");
  const anchor =
    "export const GENERATED_ARTIFACTS: readonly GeneratedArtifact[] = [builtinGlobalsAllowlist];";
  expect(original, "注册表的锚点变了,这条反例不成立").toContain(anchor);

  /**
   * 把第二件生成物登记进注册表(内容与生产函数逐字节一致,所以一致性那一段是绿的),
   * 按 `path` 写出它的文件,跑 `body`,无论成败都把注册表与文件按字节还原。
   *
   * 切掉的是锚点末尾的 `];` 两个字符,不是最后一个——只切一个会把数组提前闭合,
   * 而一个漏掉的逗号会让它变成语法错误:两份错法都会被门禁报成「注册表坏了」,
   * 不是「生成物没入库」,于是这条反例测的根本不是它要测的那件事。
   */
  const withRegisteredArtifact = (path: string, body: () => Outcome): Outcome => {
    writeFileSync(
      registry,
      original.replace(
        anchor,
        `${anchor.slice(0, -2)},\n  {\n    id: "drift-probe",\n    path: "${path}",\n` +
          `    produce: () => "export const driftProbe: readonly string[] = [];\\n",\n  },\n];`,
      ),
      "utf8",
    );
    mkdirSync(dirname(`${repoRoot}${path}`), { recursive: true });
    writeFileSync(
      `${repoRoot}${path}`,
      "export const driftProbe: readonly string[] = [];\n",
      "utf8",
    );

    try {
      return body();
    } finally {
      writeFileSync(registry, original, "utf8");
      rmSync(`${repoRoot}${path}`, { force: true });
    }
  };

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
  const manifest = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
    scripts: Record<string, string>;
  };

  // 挂在末尾而不是中间:前面几道各自独立,漂移检查是最后一道「提交内容对不对」的复核。
  expect(manifest.scripts["check"]?.trimEnd().endsWith("pnpm run check:drift")).toBe(true);

  // 不进快门禁的理由是它需要一次 `tsc -b`,而快门禁的零构建性质不能破(ADR-0003 的混合传输)。
  // 「零构建」没法直接断言,能断言的是它没被挂进快门禁这条链里。
  expect(manifest.scripts["check:quick"]).not.toContain("check:drift");
  expect(manifest.scripts["check:types"]).not.toContain("check:drift");
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
