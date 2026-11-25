/**
 * 门禁:**测试不许依赖 git 忽略的本机状态**(`gate:ignored-inputs`,由 `gate:static` 快链组合)。
 *
 * 用法:`node --run gate:ignored-inputs`(或 `node packages/tools/src/scope/run-ignored-inputs-gate.ts`)
 *
 * ── 四条判据(判据层在 `ignored-inputs.ts`,纯函数) ──
 * ① 把 `test-inputs/inputs.json` 的每一条观测输入过一遍 `git check-ignore --stdin --no-index`;
 * ② 忽略集合里,**派生前缀**下的放行(`dist/`、`node_modules/`、`*.tsbuildinfo`、工具临时目录
 *    ——它们能从入库源码重算);
 * ③ 剩下的每一条都必须被 `test-inputs/ignored-inputs.json` 的一条登记覆盖,否则红,并点名
 *    「测试文件 ← 忽略路径」;
 * ④ 登记表自身:白名单不能空、每条都真的还会被忽略、不能吞掉本机状态类;每条登记都要能在
 *    源码里定位到(行号 + 路径末段字面量)、都还要真覆盖一条命中、都写了理由。
 *
 * ── 为什么这道门禁是「可计算」的,而不是一份校对过的快照 ──
 * 输入是**入库的观测 map**,不是某次跑出来的结论。map 是 recorder 记的「谁真读了什么」
 * (ADR-0038 第三条),所以判据跟着行为走:以后有人新写一个读 `archive/` 的测试,他那一跑
 * 会往 map 里落一条,这道门禁下一次就点名——不需要谁记得回来加名单。
 *
 * ── 为什么有 `gate:ignored-inputs` 这个名字,为什么挂在 `gate:static` 上 ──
 * 零构建、不 spawn 测试:一次 `git check-ignore`(全部路径一次过 stdin)+ 读两份入库 JSON
 * (外加每条登记那一行源码),1s 级。与「入库事实的漂移」同一族(cf. `gate:rootfs`),PR 上就能拦住。
 *
 * ── 已知盲区:未 hook ≠ 没读 ──
 * 判据的上游是观测 map,map 看不见的东西这里也看不见。逐条写在 `ignored-inputs.ts` 的头注里,
 * 摘要:
 *
 * - **子进程内部读盘**:`git` / `tsc` / `depcruise` / `pnpm` / `bwrap` 这类非 node 执行体,
 *   recorder 进不去;
 * - **只探不读**:`existsSync` / `readdirSync` 只报告「有什么」,不报告内容,因此不在 hook 内
 *   ——而 `skipIf(existsSync(...))` 探的往往正是本机状态;
 * - **人先手工摆现场**:`node_modules/.bin/*`、`stryker/baseline/` 这类「先装好、先跑一次」
 *   才有东西可读的依赖。
 *
 * 这不是「所以算了」,是「红在哪里说清楚」:这道门禁保证 map 里说出来的东西没有一条是本机
 * 状态;map 说全不说全是 `observe:inputs` 与 recorder 的判据,不在这里重复一遍。
 *
 * 退出码:0 = 干净;1 = 有命中没登记 / 登记表坏了 / 这道门禁自己判不了(空转、git 报错、
 * 登记表文件不在)。**判不了也是红**:读不出结论时报绿,等于一条永远绿的门禁。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { vacuousReason } from "../gate/vacuous.ts";
import {
  DERIVED_RULES,
  type Judgment,
  LOCAL_STATE_PROBES,
  type RegistryEntry,
  REGISTRY_PATH,
  REGISTRY_SCHEMA,
  isDerived,
  judgeIgnoredInputs,
  observedInputs,
  swallowedLocalState,
} from "./ignored-inputs.ts";
import { INPUTS_MAP_PATH, loadInputsMap } from "./test-inputs.ts";

/** 本文件在 `<repo>/packages/tools/src/scope/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const fail = (line: string): number => {
  process.stderr.write(`${line}\n`);
  return 1;
};

/**
 * 读登记表。**文件不在、或形状不对,一律抛**:判不了就是红(见文件头的最后一条)。
 *
 * 不做宽容解析(对照 `loadInputsMap` 的宽容):map 的宽容是为了让「过期」在拿它当判据的那一刻
 * 才红,而登记表没有「过期」这一态——少一个字段就是少一条判据,读不出来只能停。
 */
const readRegistry = (): readonly RegistryEntry[] => {
  const path = join(repoRoot, REGISTRY_PATH);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    version?: number;
    entries?: readonly Partial<RegistryEntry>[];
  };
  if (parsed.version !== REGISTRY_SCHEMA) {
    throw new Error(
      `登记表 version 是 ${String(parsed.version)},本门禁认 ${String(REGISTRY_SCHEMA)}:${REGISTRY_PATH}`,
    );
  }
  return (parsed.entries ?? []).map((entry, index) => {
    const where = `${REGISTRY_PATH} 第 ${String(index + 1)} 条`;
    if (typeof entry.test !== "string" || entry.test === "") {
      throw new Error(`${where} 缺 test(测试文件路径)`);
    }
    if (typeof entry.line !== "number" || !Number.isInteger(entry.line) || entry.line < 1) {
      throw new Error(`${where} 的 line 必须是 1 起的整数`);
    }
    if (typeof entry.path !== "string" || entry.path === "") {
      throw new Error(`${where} 缺 path(被忽略的路径前缀)`);
    }
    if (typeof entry.reason !== "string") {
      throw new Error(`${where} 缺 reason。空理由请写空串,由判据点名,不要在解析期糊过去`);
    }
    return { test: entry.test, line: entry.line, path: entry.path, reason: entry.reason };
  });
};

/** 取源文件第 `line` 行(1 起)。文件不在 / 行号越界 → `undefined`(判据会把它记成幽灵)。 */
const sourceLine = (file: string, line: number): string | undefined => {
  const path = join(repoRoot, file);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  const index = line - 1;
  return index < 0 || index >= lines.length ? undefined : lines[index];
};

/**
 * 一次 `git check-ignore --stdin --no-index`,回传「被忽略的那些路径」。
 *
 * `--no-index`:断言的是忽略规则本身,不是索引里的状态——否则一个已被跟踪的占位符会永远
 * 「看起来没被忽略」。退出码 0 = 有命中,1 = 一条都没有,其它一律当作**判不了**(抛出):
 * 静默折算成「没被忽略」会让这道门禁在最该红的地方变绿(比如路径穿过符号链接时 git 会直接
 * 报 fatal,而那一批路径里有 node_modules 链接)。
 */
const gitIgnored = (paths: readonly string[]): ReadonlySet<string> => {
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin", "--no-index"], {
    cwd: repoRoot,
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore 退出码 ${String(result.status)},判不了:${result.stderr.trim()}`,
    );
  }
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
};

const main = (): number => {
  const observed = observedInputs(loadInputsMap(repoRoot));

  // 空转检测:map 读不出来时「无违规」与「无判据」长得一样(共享件 `gate/vacuous.ts`)。
  const vacuous = vacuousReason(observed.length, {
    subject: "被观测到的测试输入",
    scope: INPUTS_MAP_PATH,
  });
  if (vacuous !== "") return fail(`测试不依赖本机状态门禁:${vacuous}`);

  if (!existsSync(join(repoRoot, REGISTRY_PATH))) {
    return fail(
      `测试不依赖本机状态门禁:登记表不在(${REGISTRY_PATH})。缺少它不是「没有例外」,而是这条判据没了:先提交一份空的 {"version":${String(REGISTRY_SCHEMA)},"entries":[]}`,
    );
  }
  const registry = readRegistry();

  // 绝对路径过不了 `git check-ignore`(它按仓库相对路径解释),而 map 的口径是仓库相对路径。
  // 出现绝对路径说明录制口径坏了,此时一条都不能假装判过。
  const absolute = [...new Set(observed.map((hit) => hit.path))].filter((path) =>
    path.startsWith("/"),
  );
  if (absolute.length > 0) {
    return fail(
      `测试不依赖本机状态门禁:map 里有 ${String(absolute.length)} 条绝对路径,判不了(录制口径是仓库相对路径):\n` +
        absolute
          .slice(0, 5)
          .map((path) => `  ${path}`)
          .join("\n"),
    );
  }

  const candidates = [
    ...new Set(observed.filter((hit) => !isDerived(hit.path)).map((hit) => hit.path)),
  ].sort();

  // 白名单的探针与候选路径**一次**过 git:探针是「必须仍在被忽略」的正向断言,
  // 候选是「哪些真的被忽略」的求解对象。
  const probes = DERIVED_RULES.map((rule) => rule.probe);
  const ignored = gitIgnored([...probes, ...candidates]);

  const brokenRules = DERIVED_RULES.filter((rule) => !ignored.has(rule.probe));
  const swallowed = swallowedLocalState(DERIVED_RULES);
  const hits = observed.filter((hit) => ignored.has(hit.path));
  const { uncovered, problems }: Judgment = judgeIgnoredInputs({
    hits,
    registry,
    sourceLine,
  });

  for (const rule of brokenRules) {
    process.stderr.write(
      `白名单失效:派生类 \`${rule.value}\`(${rule.kind})声明「能被入库源码重算」,但探针 ${rule.probe} 已经不被 git 忽略了。\n` +
        "  `.gitignore` 改了却没跟着改这张表:白名单在替一个已入库的路径开豁免,先修表。\n",
    );
  }
  for (const probe of swallowed) {
    process.stderr.write(
      `白名单吞掉了本机状态:${probe} 被判成派生,但它不在任何 clone 里、也没有命令能重算。\n` +
        "  派生白名单只收 `dist/` / `node_modules/` / `*.tsbuildinfo` 这类;本机状态类一条都不许进。\n",
    );
  }
  for (const hit of uncovered) {
    process.stderr.write(
      `${hit.test} ← ${hit.path}\n` +
        "  这条路径被 git 忽略,又不属于任何派生前缀。测试读到它 = 作者机器上绿、别人机器上少一块事实,\n" +
        "  而少一块事实的那次也是绿的。\n" +
        `  出路:改成入库 fixture;确实无法避免的,在 ${REGISTRY_PATH} 登记一条\n` +
        "  (测试文件 + 行号 + 路径 + 为什么只能这样),行号要指到源码里写着这条路径的那一行。\n",
    );
  }
  for (const problem of problems) {
    process.stderr.write(
      `登记表${problem.kind === "ghost" ? "有幽灵条目" : problem.kind === "stale" ? "有条目过期了" : "有条目缺理由"}:${problem.entry.test}:${String(problem.entry.line)} ← ${problem.entry.path}\n  ${problem.detail}\n`,
    );
  }

  const violations = uncovered.length + problems.length + brokenRules.length + swallowed.length;
  if (violations === 0) {
    write(
      `测试不依赖本机状态门禁:${String(observed.length)} 条观测输入,` +
        `忽略且非派生 ${String(hits.length)} 条,全部落在登记表 ${String(registry.length)} 条之内;` +
        `派生白名单 ${String(DERIVED_RULES.length)} 条(探针仍被忽略,未吞本机状态 ${String(LOCAL_STATE_PROBES.length)} 类)。`,
    );
    return 0;
  }
  process.stderr.write(
    `测试不依赖本机状态门禁:${String(violations)} 处违规` +
      `(未登记命中 ${String(uncovered.length)} / 登记表问题 ${String(problems.length)} / 白名单失效 ${String(brokenRules.length + swallowed.length)})。\n`,
  );
  return 1;
};

try {
  process.exitCode = main();
} catch (error) {
  // **判不了也是红**:登记表解析不了、git 起不来,都是「这道门禁没给出结论」而
  // 不是「没有违规」。堆栈噪声对读数没帮助,原因那一句才是。
  process.exitCode = fail(
    `测试不依赖本机状态门禁:判不了——${error instanceof Error ? error.message : String(error)}`,
  );
}
