/**
 * 门禁本身的退出码——本 feature 的主缝(spec《Testing Decisions》)。
 *
 * 断言对象是 CI 将来会敲的那几条命名脚本与门禁脚本自己的退出码;
 * 断言的东西全部是外部可观察的:进程的退出码与报告文本。没有任何一处断言内部函数形状。
 *
 * 每道门禁都配了**现做现验的反例**:往仓库里放一处违规,确认非零退出,再撤掉确认回到 0。
 * 反例刻意不用「临时目录 + 另一份配置」,而是让真实的门禁脚本在真实的仓库状态上红一次——
 * 一条只在夹具里才成立的规则,和没有规则是同一种东西。
 *
 * 探针一律落在 **构建产物**(`dist/`)或 **`.js`** 上,不落在 `src/` 的 `.ts` 上:
 * dist 不入库、tsc -b 也不清它,而 `.js` 落在 src 里 oxfmt/oxlint 看得见、tsc 的 include 看不见。
 * 这样反例既完整地走一遍真实门禁,又不会把工作区弄脏、也不会打断并行的类型闸门。
 *
 * 与 unit / property 分成不同的 vitest project 是为了不递归:全量门禁 `check` 里含
 * `vitest run`,而这里会 spawn `check`。因此 `check` 显式只跑 unit 与 property。
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = here("../../../");

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
  "packages/runner/dist/__gate-probe.js",
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

// 兜底:withProbeFile 的 finally 已经撤干净,这里是防止进程被强杀时留下半个探针。
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

  // 反面证据:必须真的巡航到了图。depcruise 缺 TypeScript 编译器时的行为是**静默跳过 .ts**,
  // 报告写着「0 modules, 0 dependencies」并且 exit 0——那是一条永远全绿、什么也没断言的假门禁。
  // 所以这一条不是装饰:它是让「check:deps 退出 0」这句话能被当真的那道防线。
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

// ── 依赖门禁反例:注入一处方向违规,确认规则真的挂在图上 ────────────────────────

it("依赖门禁:runner 一旦 import engine 就红,撤掉即绿", () => {
  const clean = script("check:deps");
  expect(clean.status, clean.output).toBe(0);

  // 注入点选 runner 而不是 engine:engine 里有一份 dependency-boundary.test.ts 正在跑
  // depcruise,往 engine 目录里塞违规会与它抢同一片图(那个反例现做现验地跑,不参与本文件)。
  // 探针落在 dist/ 而非 src/:dist 是构建产物、不入库,tsc -b 也不会清掉它。
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

// ── 格式门禁反例 ─────────────────────────────────────────────────────────────

it("格式门禁:未格式化的文件被拦下,格式化后放行", () => {
  const clean = script("fmt");
  expect(clean.status, clean.output).toBe(0);

  const violated = withProbeFile(
    "packages/schema/src/__fmt-probe.js",
    "export const   fmtProbe   =    {a:1,   b:2}\n",
    () => script("fmt"),
  );
  expect(violated.status, "未格式化文件必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("__fmt-probe.js");

  expect(script("fmt").status).toBe(0);
});

// ── lint 门禁反例 ────────────────────────────────────────────────────────────

it("lint 门禁:被禁写法被拦下,改正后放行", () => {
  const clean = script("lint");
  expect(clean.status, clean.output).toBe(0);

  const violated = withProbeFile(
    "packages/schema/src/__lint-probe.js",
    "const declaredButNeverUsed = 41 + 1;\nexport const kept = 1;\n",
    () => script("lint"),
  );
  expect(violated.status, "被禁写法必须非零退出").toBe(1);
  expect(violated.output, violated.output).toContain("no-unused-vars");

  expect(script("lint").status).toBe(0);
});
