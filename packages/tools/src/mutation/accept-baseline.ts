/**
 * 抬升分片基线的**唯一**入口:显式、只写被点名的那一个分片、不调用就什么都不发生。
 *
 * 用法:
 *
 *     node packages/tools/src/mutation/accept-baseline.ts --shard=<name>
 *          [--report=<path>] [--baseline=<path>]
 *
 * `--report` / `--baseline` 存在的理由只有一个:门禁自测要能把它指到临时路径上
 * (与 `check:selfproof --probe` 同一个形状)。人正跑时不带它们,读报告、写入库基线,
 * 两条路径都来自分片清单(`shards.ts`)。
 *
 * ── 为什么它必须是一条独立命令,而不是某个入口的一步 ────────────────────────
 * ADR-0026 的三条 Consequences 落在同一条轴上:基线入版本库、抬升只能显式为之、
 * 抬升的命令不得出现在任何流水线 / 默认链 / 常跑入口。第三条与「`check:selfproof --probe`
 * 只准用于反例」是同一个形状:**能改判据的开关,不能出现在判据自己的正常路径上**。
 * 棘轮的判据是「这一片不许比入库基线低」,而抬基线正好能把它变绿——于是这一步必须是
 * 人显式做的一步,且不可能顺手发生在任何自动路径上。门禁自测守着两件事:
 * 这条命令在场(否则「显式为之」无处可为之)、且它不在任何链上。
 *
 * ── 三个必须 ────────────────────────────────────────────────────────────────
 * 1. **必须带 `--shard=<name>`**。无参数、分片名拼错、开关拼错,一律非零退出且一个字节都不写。
 *    「不带参数就全量重写」会让一次手滑把 12 个分片一起抹平,而那在 diff 里只表现为
 *    一次平平无奇的「基线更新」。分片名从清单查,与门禁入口同源。
 * 2. **只写一份文件**:`--baseline=<path>`,缺省则是该分片的入库基线。写口只有这一个——
 *    不碰 `reports/`(那是产物),不碰别的分片的基线(指到别人那份上直接非零退出:
 *    一个分片只能抬自己那一份)。
 * 3. **不调用就没有任何副作用**。本文件只在被显式执行时跑 `main()`,没有别处会引用它。
 *
 * ── 它打印「旧 → 新」 ──────────────────────────────────────────────────────
 * 抬升在 diff 里只表现为数字变了,读 diff 的人分不清哪边是新值、从多少来。所以命令自己打印
 * 一行 `旧 → 新`,并且在新基线**更低**时显式提示:下降同样是合法的显式动作(收紧一个写错的旧基线),
 * 但它必须被看见——它正是「把红刷成绿」的那条路。
 *
 * ── 它不解释「为什么抬」 ────────────────────────────────────────────────────
 * 基线里的 `note` 是给人读的、随情形变化的说明(例如「来源报告只覆盖了一个文件」),由人写;
 * 抬升命令只把这一次的数字记下来,旧附注留在 git 历史里。`source` 是例外:它指回「这个数字打哪来」,
 * 由命令如实填写。
 *
 * ── 空转的报告不许入基线 ────────────────────────────────────────────────────
 * 一份没有一个有效变异体(`valid === 0`)的报告若被写进基线,棘轮从此对任何真实报告都判绿
 * (交叉相乘两边都乘 0)。与门禁入口同一口径(共享件 `gate/vacuous.ts`):空转按失败处理,
 * 所以这里拒绝写入。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { vacuousReason } from "../gate/vacuous.ts";
import {
  SHARD_INCOMPARABLE_NOTE,
  baselineFromCounts,
  countsFromReport,
  isShardBaseline,
  mutationScore,
  scoreGapPercent,
  type MutationCounts,
  type MutationRatio,
  type ShardBaseline,
  type StrykerJsonReport,
} from "./ratchet.ts";
import { shardByName, shardNames } from "./shards.ts";

/** 本文件在 `<repo>/packages/tools/src/mutation/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 入库基线所在的目录。它同时是「只能抬自己那一份」这条守卫的判据。 */
const BASELINE_DIR = resolve(repoRoot, "stryker/baseline");

const USAGE =
  "用法:node packages/tools/src/mutation/accept-baseline.ts " +
  "--shard=<name> [--report=<path>] [--baseline=<path>]";

/** 仓库根相对路径(打印用)。仓库外的路径(测试的临时目录)原样打印。 */
const display = (path: string): string => {
  const inside = relative(repoRoot, path);
  return inside === "" || inside.startsWith("..") ? path : inside;
};

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

/** 旧基线:缺席 / 读得出 / 读不出(读不出不挡抬升,否则一份坏掉的基线就没法就地修回来)。 */
type PreviousBaseline =
  | { readonly kind: "absent" }
  | { readonly kind: "stored"; readonly baseline: ShardBaseline }
  | { readonly kind: "unreadable"; readonly why: string };

const readPrevious = (path: string): PreviousBaseline => {
  if (!existsSync(path)) {
    return { kind: "absent" };
  }
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isShardBaseline(data)
      ? { kind: "stored", baseline: data }
      : { kind: "unreadable", why: "字段不合规(shard / detected / valid / score / coverageBased)" };
  } catch (error) {
    return { kind: "unreadable", why: error instanceof Error ? error.message : String(error) };
  }
};

/** 一行「原始分 69.82%(detected 236 / valid 338)」——旧的与新的用同一个格式,好并排读。 */
const ratioText = (score: number, ratio: MutationRatio): string =>
  `${score.toFixed(2)}%(detected ${String(ratio.detected)} / valid ${String(ratio.valid)})`;

const main = (): number => {
  const args = process.argv.slice(2);
  // 参数一律白名单:拼错的开关(`--baselin=...`)如果被静默忽略,命令会去写默认路径,
  // 而调用者以为自己在写别处——这条命令写的是入库基线,静默是最不能容忍的失效。
  const unknown = args.filter((arg) => !/^--(shard|report|baseline)(=|$)/.test(arg));
  if (unknown.length > 0) {
    return fail(`${USAGE}\n不认识的参数:${unknown.join(" ")}`);
  }
  const shardName = flagOf(args, "shard");
  if (shardName === undefined || shardName === null) {
    return fail(`${USAGE}\n缺少 --shard=<name>:抬基线只抬被点名的那一个分片,不存在「全量重写」。`);
  }
  const shard = shardByName(shardName);
  if (shard === undefined) {
    // 拼错的分片名不能落进「抬一个默认分片」:那会用错误的报告覆盖正确的基线。
    return fail(
      `抬基线:未知分片「${shardName}」。清单在 packages/tools/src/mutation/shards.ts,` +
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

  // 一个分片只能抬自己那一份:指向别的分片时当场非零,而不是把别人的基线改成自己的数字。
  const sibling = relative(BASELINE_DIR, baselinePath);
  if (!sibling.startsWith("..") && sibling !== `${shard.name}.json`) {
    return fail(
      `抬基线 [${shard.name}]:--baseline 指向的不是本分片的基线(${display(baselinePath)})。` +
        `一个分片只能抬自己那一份 stryker/baseline/${shard.name}.json。`,
    );
  }

  // ① 报告必须在:没有报告就没有「这一次的数字」,抬升不是在猜。
  if (!existsSync(reportPath)) {
    return fail(
      `抬基线 [${shard.name}]:报告缺失(${display(reportPath)})。` +
        `先跑 pnpm run ${shard.script} 产出报告——没有报告就没有可抬的数字。`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    return fail(
      `抬基线 [${shard.name}]:报告读不出来(${display(reportPath)}):` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const counts: MutationCounts = countsFromReport(report as StrykerJsonReport);

  // ② 空转的报告不许入基线(见头注最后一段)。
  const vacuous = vacuousReason(counts.valid, {
    subject: "有效变异体",
    scope: `${display(reportPath)}(只计 Killed/Timeout/Survived/NoCoverage)`,
  });
  if (vacuous !== "") {
    return fail(`抬基线 [${shard.name}]:${vacuous}空转的报告不能当基线。`);
  }

  // ③ 造新基线并写盘。写只发生在这一处,且只在参数齐全、报告可用之后。
  const next = baselineFromCounts(shard.name, counts, display(reportPath));
  const previous = readPrevious(baselinePath);
  const gaps =
    previous.kind === "stored"
      ? scoreGapPercent(counts, {
          detected: previous.baseline.detected,
          valid: previous.baseline.valid,
        })
      : 0;
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  // ④ 打印:抬了哪一片、旧 → 新、写到了哪。
  const previousText =
    previous.kind === "stored"
      ? ratioText(previous.baseline.score, previous.baseline)
      : previous.kind === "unreadable"
        ? `读不出来(${previous.why})`
        : "无";
  out(`抬升 [${shard.name}]:报告 ${display(reportPath)} → 基线 ${display(baselinePath)}`);
  out(`旧 → 新:${previousText} → ${ratioText(mutationScore(counts), counts)}`);
  out(
    `覆盖内分(参考):${
      previous.kind === "stored" ? `${previous.baseline.coverageBased.toFixed(2)}%` : "无"
    } → ${next.coverageBased.toFixed(2)}%`,
  );
  if (previous.kind === "stored" && gaps < 0) {
    out(
      `注意:新基线比旧基线低 ${Math.abs(gaps).toFixed(2)} 个百分点 —— 棘轮从此更松。` +
        `确认这是有意的收紧/纠错,不是为了把一条红刷成绿。`,
    );
  } else if (previous.kind === "stored" && gaps > 0) {
    out(`新基线比旧基线高 ${gaps.toFixed(2)} 个百分点 —— 棘轮收紧了。`);
  }
  out(`已写入 ${display(baselinePath)}。`);
  out(
    "这是显式动作:它不在任何流水线、默认链或常跑入口上,agent 不得运行它" +
      "(AGENTS.md《门禁纪律》)——修测试让分数回去才是 agent 的活。",
  );
  out(SHARD_INCOMPARABLE_NOTE);
  return 0;
};

process.exitCode = main();
