/**
 * 变异分数棘轮门禁的入口:读本分片的当前报告与入库基线,跑一遍纯函数,打印判定并按结果设退出码。
 *
 * 用法(**只在分片的变异入口里被调用**,不是一条独立的常跑入口):
 *
 *     node packages/tools/src/mutation/run-mutation-ratchet-gate.ts --shard=<name>
 *          [--report=<path>] [--baseline=<path>]
 *
 * `package.json` 的 12 条变异入口都是 `stryker run stryker/<config>.mjs && node … --shard=<name>`:
 * 变异跑完就地比,不另立一条「回头再比」的链——那正是观测项退化成装饰的路径。
 * `--report` / `--baseline` 存在的理由只有一个:门禁自测要能喂夹具(与 `check:selfproof --probe`
 * 同一个形状)。正跑时不带它们,读的是分片清单里的默认路径。
 *
 * ── 三种判决与各自的退出码 ─────────────────────────────────────────────────
 * - 报告缺失 → 红:`stryker run` 没产出报告说明这次变异没跑成,判不了就是红。
 * - 报告里 `valid === 0` → 红:空转(共享件 `gate/vacuous.ts`),一条没有变异体的报告不算「干净」。
 * - 基线缺失 → **首次**:不判红,打印「首次」,退 0。这与上一条是两件事:「这次没东西可比」
 *   是红,「这个分片还没有可比的上一次」不是红。
 * - 低于基线 → 红:打印当前/基线/差值(差值只给读的人看,判决是整数交叉相乘)。
 * - 等于或高于基线 → 绿。
 *
 * 每次输出都带「分片之间不可横向比较」那条提示(理由见 `ratchet.ts` 的 `SHARD_INCOMPARABLE_NOTE`)。
 *
 * 本文件只做四件事:解析参数、读文件、调纯函数、设退出码。判决与文案全在 `ratchet.ts`,
 * 清单与默认路径全在 `shards.ts`。它**不写任何文件**——抬基线是另一条显式命令的事(ADR-0026)。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净或首次,1 = 退化 / 判不了 / 空转。
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { vacuousReason } from "../gate/vacuous.ts";
import {
  SHARD_INCOMPARABLE_NOTE,
  compareToBaseline,
  countsFromReport,
  coverageBasedScore,
  isShardBaseline,
  mutationScore,
  scoreGapPercent,
  type MutationCounts,
  type MutationRatio,
  type StrykerJsonReport,
} from "./ratchet.ts";
import { shardByName, shardNames } from "./shards.ts";

/** 本文件在 `<repo>/packages/tools/src/mutation/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const USAGE =
  "用法:node packages/tools/src/mutation/run-mutation-ratchet-gate.ts " +
  "--shard=<name> [--report=<path>] [--baseline=<path>]";

/** 仓库根相对路径(打印用):绝对路径不该出现在输出里,也不该出现在基线文件里。 */
const display = (path: string): string => relative(repoRoot, path);

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const fail = (line: string): number => {
  process.stderr.write(`${line}\n`);
  return 1;
};

/** `--name=value` 形态。返回 `undefined` 表示没给;给了空值算用法错(返回 `null`)。 */
const flagOf = (args: readonly string[], name: string): string | undefined | null => {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (hit === undefined) {
    return undefined;
  }
  return hit.startsWith(prefix) && hit.length > prefix.length ? hit.slice(prefix.length) : null;
};

/** 打印一行「这个分片这一次是多少」。 */
const summary = (name: string, counts: MutationCounts): string => {
  const score = mutationScore(counts).toFixed(2);
  const coverage = coverageBasedScore(counts).toFixed(2);
  return (
    `变异棘轮 [${name}]:原始分 ${score}%(detected ${String(counts.detected)} / valid ${String(counts.valid)}),` +
    `覆盖内分 ${coverage}%(参考)。`
  );
};

const parseJson = (path: string): { readonly data: unknown } | { readonly error: string } => {
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const main = (): number => {
  const args = process.argv.slice(2);
  // 参数一律白名单:拼错的开关(`--baselin=...`)如果被静默忽略,门禁会去读默认路径并可能绿,
  // 而调用者以为自己在测别的东西。
  const unknown = args.filter((arg) => !/^--(shard|report|baseline)(=|$)/.test(arg));
  if (unknown.length > 0) {
    return fail(`${USAGE}\n不认识的参数:${unknown.join(" ")}`);
  }
  const shardName = flagOf(args, "shard");
  if (shardName === undefined || shardName === null) {
    return fail(`${USAGE}\n缺少 --shard=<name>,分片是这条门禁唯一的比较单位。`);
  }
  const shard = shardByName(shardName);
  if (shard === undefined) {
    // 拼错的分片名不能落进「首次」:那会让一条永远绿的门禁看起来像刚上线。
    return fail(
      `变异棘轮:未知分片「${shardName}」。清单在 packages/tools/src/mutation/shards.ts,` +
        `现有:${shardNames().join("、")}。`,
    );
  }

  const reportFlag = flagOf(args, "report");
  const baselineFlag = flagOf(args, "baseline");
  if (reportFlag === null || baselineFlag === null) {
    return fail(`${USAGE}\n--report / --baseline 给了空值。`);
  }
  const reportPath = resolve(repoRoot, reportFlag ?? shard.report);
  const baselinePath = resolve(repoRoot, baselineFlag ?? shard.baseline);

  // ① 报告缺失:这次变异没跑成,判不了就是红。
  if (!existsSync(reportPath)) {
    return fail(
      `变异棘轮 [${shard.name}]:报告缺失(${display(reportPath)})。` +
        `先跑 pnpm run ${shard.script} 产出报告——判不了就是红。`,
    );
  }
  const report = parseJson(reportPath);
  if ("error" in report) {
    return fail(`变异棘轮 [${shard.name}]:报告读不出来(${display(reportPath)}):${report.error}`);
  }
  const current = countsFromReport(report.data as StrykerJsonReport);

  // ② 报告里一个有效变异体也没有:空转(共享件),不是「干净」。
  const vacuous = vacuousReason(current.valid, {
    subject: "有效变异体",
    scope: `${display(reportPath)}(只计 Killed/Timeout/Survived/NoCoverage)`,
  });
  if (vacuous !== "") {
    return fail(`变异棘轮 [${shard.name}]:${vacuous}`);
  }

  out(summary(shard.name, current));

  // ③ 基线缺失:首次。不判红,也不写任何文件——抬基线是另一条显式命令的事。
  if (!existsSync(baselinePath)) {
    out(
      `判定:首次 —— 没有入库基线(${display(baselinePath)}),本分片还不存在「上一次」,不判红。` +
        `这次跑出来的数字就是下一次的比较对象,等显式的基线抬升把它入库。`,
    );
    out(SHARD_INCOMPARABLE_NOTE);
    return 0;
  }
  const baseline = parseJson(baselinePath);
  if ("error" in baseline) {
    return fail(
      `变异棘轮 [${shard.name}]:基线读不出来(${display(baselinePath)}):${baseline.error}`,
    );
  }
  if (!isShardBaseline(baseline.data)) {
    return fail(
      `变异棘轮 [${shard.name}]:基线文件坏了(${display(baselinePath)}),` +
        `需要 shard / detected / valid / score / coverageBased 五个字段且前两个是非负整数。`,
    );
  }
  const stored = baseline.data;
  out(
    `基线 [${shard.name}]:原始分 ${stored.score.toFixed(2)}%` +
      `(detected ${String(stored.detected)} / valid ${String(stored.valid)}),` +
      `覆盖内分 ${stored.coverageBased.toFixed(2)}%(参考)。`,
  );
  if (stored.source !== undefined) {
    out(`基线来源:${stored.source}`);
  }
  if (stored.note !== undefined) {
    out(`基线附注:${stored.note}`);
  }

  // ④ 判决。差值只给读的人看,判决本身是整数交叉相乘(`ratchet.ts` 头注)。
  const verdict = compareToBaseline(current, stored);
  const baselineRatio: MutationRatio = { detected: stored.detected, valid: stored.valid };
  if (verdict.kind === "regressed") {
    const gap = scoreGapPercent(current, baselineRatio);
    fail(
      `判定:regressed —— 比基线低 ${Math.abs(gap).toFixed(2)} 个百分点` +
        `(当前 ${mutationScore(current).toFixed(2)}% < 基线 ${mutationScore(baselineRatio).toFixed(2)}%)。` +
        `修测试让分数回去;抬基线是另一条显式的命令,不在任何常跑入口上。`,
    );
    out(SHARD_INCOMPARABLE_NOTE);
    return 1;
  }
  const gap = scoreGapPercent(current, baselineRatio);
  out(
    gap === 0
      ? "判定:ok —— 与基线持平(棘轮只拦退化,不设绝对红线)。"
      : `判定:ok —— 高于基线 ${gap.toFixed(2)} 个百分点(棘轮只拦退化,不设绝对红线)。`,
  );
  out(SHARD_INCOMPARABLE_NOTE);
  return 0;
};

process.exitCode = main();
