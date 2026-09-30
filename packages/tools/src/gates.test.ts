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
 *   - **落进产物树**(各包 dist 目录下的 `__gate-probe.js`):给 dependency-cruiser 用。
 *     它巡航的是 dist(见 .dependency-cruiser.js 顶部:本仓库的 TypeScript 7 没有 JS 编程 API,
 *     depcruise 认不了 `.ts`),而 dist 不入库,所以这个反例既走真实配置与真实规则,
 *     又不会在失败时脏工作区。
 *
 * `withProbeFile` 的 `finally` 保证成败都撤掉探针;`afterAll` 再兜一次底,
 * 覆盖进程被硬杀、`finally` 根本没机会跑的那种情况。
 *
 * 与 unit / property 分成不同的 vitest project 是为了不递归:全量门禁 `check` 里含
 * `vitest run`,而这里会 spawn `check`。见 vitest.config.ts 的 GATES_TEST 常量,
 * 以及本文件末尾那条盯着该不变量的用例。
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
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

/** 本文件用过的全部探针路径。 */
const PROBES = [
  "packages/schema/src/__fmt-probe.js",
  "packages/schema/src/__lint-probe.js",
  "packages/schema/src/__lint-probe.ts",
  "packages/runner/dist/__gate-probe.js",
  "packages/engine/dist/__gate-probe.js",
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

// ── 依赖门禁反例:注入违规,确认规则真的挂在图上 ────────────────────────────────

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
