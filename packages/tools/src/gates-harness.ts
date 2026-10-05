/**
 * 门禁自测共用的那一层外部观察手段(`gates.test.ts` 与 `gates-slow.test.ts` 各取所需)。
 *
 * 这里只有两样东西:**跑一条真实命令并读它的退出码与输出**,以及**读根 `package.json` 里那几条
 * 命名脚本的清单**。两者都不含断言,也不 import vitest——断言归各自的文件,分层由 vitest 的
 * project 划分(见 vitest.config.ts)。
 *
 * 单独成模块而不是在两个文件里各抄一份:这一层的事实只有一份家。抄一份的代价不是行数,
 * 而是 `GATE_PNPM` 这个逃生口、`tailSteps` 的 `slice(-CONTENT_RECHECKS.length)` 那种算术,
 * 以及「末尾复核清单」这份可枚举列表——它们分叉的后果是**一道门禁悄悄既不在末尾又被断言在末尾**,
 * 而两处断言都会绿。
 *
 * 注意这里**不含** `PROBES` 与 `afterAll` 兜底清理:探针路径清单是「本文件用过的全部探针」,
 * 属于文件自己的账,把它提到共享层会让两个文件的清理各管一半、各漏一半。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 把相对本文件的位置解析成绝对路径。仓库根 = 上溯三级。 */
export const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const repoRoot = here("../../../");

export type Outcome = { status: number; output: string };

export const run = (command: string, args: readonly string[]): Outcome => {
  const result = spawnSync(command, [...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

/** 跑一条根脚本。`pnpm` 走 PATH 上的 corepack shim;可用 GATE_PNPM 覆盖。 */
export const script = (name: string, args: readonly string[] = []): Outcome =>
  run(process.env["GATE_PNPM"] ?? "pnpm", ["run", name, ...args]);

/**
 * 契约自证门禁反例①用的违规脚本探针(路径落到 `packages/tools/src` 下)。
 *
 * 落点与别的探针同一形态:`.js` 而非 `.ts`——各包 tsconfig 的 `include` 只收 `.ts`
 * 且不开 `allowJs`,所以它进得了桩的装载、进不了 `tsc -b`,反例只证明它该证明的那一件事。
 * 它**刻意不含 `import` / `export`**:那两条虽然也违规,但会让桩在装载产物时抛异常,
 * 门禁读到的是「跑批崩了」,而不是「静态校验器判它红」——那证明不了①这一问。
 */
export const VIOLATING_SCRIPT_PROBE_PATH = "packages/tools/src/selfproof/__selfproof-probe.js";

/** 放一个探针进去,跑 `body`,无论成败都把它撤掉。 */
export const withProbeFile = (path: string, contents: string, body: () => Outcome): Outcome => {
  writeFileSync(`${repoRoot}${path}`, contents, "utf8");
  try {
    return body();
  } finally {
    rmSync(`${repoRoot}${path}`, { force: true });
  }
};

export type Manifest = { scripts: Record<string, string> };

export const manifest = (): Manifest =>
  JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as Manifest;

/**
 * 挂在 `check` 末尾的提交内容复核(逐条写出来,顺序不钉死)。
 *
 * 为什么是清单而不是「最后 N 步」:纪律是「末尾那几道都是复核」,不是「末尾恰好 N 道」。
 * 清单可枚举,N 会漂——多一道或少一道,前者让断言变红,后者让它安静地放过一道混进末尾的新检查。
 *
 * 契约自证门禁**不在**这份清单里:它按需跑(自己的脚本 + `test:slow` 的反例),
 * 理由与断言见 `gates.test.ts` 的 `契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖`。
 */
export const CONTENT_RECHECKS = ["pnpm run check:drift", "pnpm run check:bench"] as const;

/** 全量门禁末尾那一组(取与复核清单等长的一段)。 */
export const tailSteps = (): readonly string[] =>
  (manifest().scripts["check"] ?? "")
    .split("&&")
    .map((step) => step.trim())
    .slice(-CONTENT_RECHECKS.length);
