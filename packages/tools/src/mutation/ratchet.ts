/**
 * 变异分数棘轮的判定层:两份 JSON(本次报告、入库基线)进,三种判定出。
 *
 * 归属:hld §2.2.7 门禁表「按需 → 夜间」层的 `mutate*`;裁决记录见
 * `docs/adr/0026-mutation-score-is-a-ratchet.md`。
 *
 * ── 只有三种判定 ────────────────────────────────────────────────────────────
 * `regressed`(红)、`ok`(绿)、`first-run`(本分片没有入库基线:不判红,报「首次」)。
 * 没有第四种,也**没有绝对阈值**:绝对阈值会同时产生两种不可见失效——低于阈值的分片永远红
 * (于是被学会忽略),高于阈值的分片永远绿(于是退化了也不报警)。棘轮只回答一个问题:
 * 「同一分片这一次是否比入库的上一次低」。
 *
 * ── 比较口径:整数交叉相乘,不用浮点分数 ────────────────────────────────────
 * 从 Stryker JSON 的 `files[].mutants[].status` 数出两个整数:
 *
 *   - `detected` = `Killed` + `Timeout`
 *   - `valid`    = `detected` + `Survived` + `NoCoverage`
 *
 * 这与 `mutation-testing-metrics` 的 `mutationScore = totalDetected / totalValid` 同源
 * (该包的 `toMetrics`:`totalDetected = timeout + killed`、`totalUndetected = survived + noCoverage`)。
 * `RuntimeError` / `CompileError` / `Ignored` / `Pending` **不进 valid**,也不进 detected:
 * 它们既不证明测试杀掉了变异体,也不证明变异体活到了被测代码里。
 *
 * 判决用交叉相乘的原式而不是两个百分比:
 *
 *     current.detected * baseline.valid < baseline.detected * current.valid  →  regressed
 *
 * 于是「低」这件事由整数决定,与 `score` 字段怎么四舍五入、打印成几位小数都无关。
 * 报告与基线里的人类可读 `score` / `coverageBased` 是**参考字段**,不参与判决。
 *
 * ── 分片之间不可横向比较(读这一行的人必须知道)──────────────────────────────
 * 比较粒度是**分片**,而分片的物理依据写在 `stryker/base.mjs` 的头注里:Stryker 一次进程
 * 只有一份 `mutate` scope 与一份 `testFiles`,跨包 import 在沙箱里指向仓库外,于是跨包覆盖
 * 会被静默记成 `Survived` / `NoCoverage`。同一段话的结论是:「分片之间只能比趋势,不能比分数」。
 * 所以本文件里没有任何把分片汇总成一个数的函数——那等于制造一个不存在的可比性。
 * 打印时必须带上这条提示,见 `SHARD_INCOMPARABLE_NOTE`。
 *
 * ── 为什么它是纯函数 ────────────────────────────────────────────────────────
 * 用命名脚本缝测棘轮需要跑一次真实变异(分钟到整夜),而且会让门禁的测试依赖它所守的那次运行,
 * 构成循环。所以读文件留在薄壳(`run-mutation-ratchet-gate.ts`),判定与文案全在这里,
 * 反例只需喂两份 JSON。
 */

/** 判定的两个整数。`valid` 为 0 时不可比——这是空转那一侧的事,由门禁入口判红。 */
export type MutationRatio = {
  /** `Killed` + `Timeout`。 */
  readonly detected: number;
  /** `detected` + `Survived` + `NoCoverage`。 */
  readonly valid: number;
};

/** 报告里数出来的三个整数。`survived` 只服务于覆盖内分(参考字段),不参与判决。 */
export type MutationCounts = MutationRatio & {
  /** `Survived`,不含 `NoCoverage`(后者是「没被测到」,不是「活下来了」)。 */
  readonly survived: number;
};

/** Stryker JSON 报告里我们真的会读的那两列(其余字段一概不看,也不校验)。 */
export type StrykerMutant = { readonly status?: string };

export type StrykerJsonReport = {
  readonly files?: Readonly<Record<string, { readonly mutants?: readonly StrykerMutant[] }>>;
};

/** 入库基线文件的形状。`score` / `coverageBased` / `source` / `note` 全是参考字段。 */
export type ShardBaseline = MutationRatio & {
  /** 这份基线属于哪个分片。只用于打印与自证合理性,不参与判决。 */
  readonly shard: string;
  /** `mutationScore` 的人类可读副本(百分比)。**不参与判决**。 */
  readonly score: number;
  /** 覆盖内分 `detected / (detected + survived)` 的人类可读副本。**不参与判决**。 */
  readonly coverageBased: number;
  /** 这份基线是从哪份报告算出来的(仓库根相对路径)。留着是为了「这个数字打哪来」有据可查。 */
  readonly source?: string;
  /** 需要额外说明的事(例如来源报告并不覆盖本分片的 mutate 范围)。 */
  readonly note?: string;
};

/** 三种判定。`first-run` 不是「绿」也不是「红」:它只说明这个分片还没有可比的上一次。 */
export type RatchetVerdict =
  | { readonly kind: "first-run"; readonly current: MutationRatio }
  | { readonly kind: "ok"; readonly current: MutationRatio; readonly baseline: MutationRatio }
  | {
      readonly kind: "regressed";
      readonly current: MutationRatio;
      readonly baseline: MutationRatio;
    };

/** 判红的两种状态:超时被 Stryker 算进「已检测」,口径与 `mutation-testing-metrics` 一致。 */
const DETECTED_STATUSES: ReadonlySet<string> = new Set(["Killed", "Timeout"]);

/** 进分母的「未被检测」两种状态。`RuntimeError` / `CompileError` / `Ignored` / `Pending` 不在其中。 */
const UNDETECTED_STATUSES: ReadonlySet<string> = new Set(["Survived", "NoCoverage"]);

/**
 * 从一份 Stryker JSON 报告数出 `detected` / `valid` / `survived`。
 *
 * 只读 `files[].mutants[].status`。缺 `files`、缺 `mutants`、状态是没见过的字符串,都不算数
 * ——不认识的形态宁可数少(进而被空转检测判红),也不猜。
 */
export const countsFromReport = (report: StrykerJsonReport): MutationCounts => {
  let detected = 0;
  let survived = 0;
  let undetected = 0;
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      const status = mutant.status ?? "";
      if (DETECTED_STATUSES.has(status)) {
        detected += 1;
      } else if (UNDETECTED_STATUSES.has(status)) {
        undetected += 1;
        if (status === "Survived") {
          survived += 1;
        }
      }
    }
  }
  return { detected, valid: detected + undetected, survived };
};

/** 原始分(百分比),与 Stryker / `mutation-testing-metrics` 的 `mutationScore` 同式。0 个有效变异体时取 0。 */
export const mutationScore = (ratio: MutationRatio): number =>
  ratio.valid > 0 ? (ratio.detected / ratio.valid) * 100 : 0;

/** 覆盖内分(百分比):只把「被测到过」的算进分母。参考字段,不参与判决。 */
export const coverageBasedScore = (counts: MutationCounts): number => {
  const covered = counts.detected + counts.survived;
  return covered > 0 ? (counts.detected / covered) * 100 : 0;
};

/**
 * 判定:同一分片的这一次 vs 入库的上一次。
 *
 * `baseline === null` 表示没有基线文件——**首次**。首次不判红:没有可比的上一次时判红,
 * 等于把「还没跑过」当成「退化了」,而那种红只有抬基线能消,抬基线又会变成刷分的入口。
 *
 * 低于基线 → `regressed`;等于或高于 → `ok`。相等判绿是刻意的:棘轮只拦退化。
 */
export const compareToBaseline = (
  current: MutationRatio,
  baseline: MutationRatio | null,
): RatchetVerdict => {
  if (baseline === null) {
    return { kind: "first-run", current };
  }
  // 交叉相乘:current < baseline ⇔ current.detected * baseline.valid < baseline.detected * current.valid。
  // 两边都是整数(最大量级 10^4 × 10^4,远在 double 的精确整数区间内),所以判决不受小数位影响。
  return current.detected * baseline.valid < baseline.detected * current.valid
    ? { kind: "regressed", current, baseline }
    : { kind: "ok", current, baseline };
};

/**
 * 当前与基线的分数差(百分点;正数 = 高于基线)。
 *
 * **只给打印用**,判决一律走 `compareToBaseline` 的整数比较。写成同一个交叉相乘的差,
 * 是为了让打印出来的「低了几分」与判决口径同源,而不是另一段浮点算术。
 */
export const scoreGapPercent = (current: MutationRatio, baseline: MutationRatio): number =>
  current.valid > 0 && baseline.valid > 0
    ? ((current.detected * baseline.valid - baseline.detected * current.valid) /
        (current.valid * baseline.valid)) *
      100
    : 0;

/**
 * 分片之间不可横向比较的理由,来自 `stryker/base.mjs` 头注里那条结论(同一段事实的家在那里)。
 *
 * 门禁的每一次输出都带它:一对并排放着的分片数字会被读成结论,而它们本来不可比
 * (schema 的 231 个是名单字符串、tools 有 43% 的 NoCoverage、engine-runtime 的超时比真杀还多)。
 */
export const SHARD_INCOMPARABLE_NOTE =
  "分片之间不可横向比较:跨包覆盖会被静默记成 Survived/NoCoverage(stryker/base.mjs 头注)," +
  "所以每个分片的分数只能与同一个分片的入库基线比,不能与别的分片并排读。";

/** 基线文件的形状守卫:字段缺失或不是数字时按「基线坏了」判红,而不是让 `NaN` 把判决悄悄变成 ok。 */
export const isShardBaseline = (value: unknown): value is ShardBaseline => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const numeric = (key: string): boolean =>
    Number.isInteger(candidate[key]) && (candidate[key] as number) >= 0;
  if (!numeric("detected") || !numeric("valid")) {
    return false;
  }
  if (typeof candidate["shard"] !== "string") {
    return false;
  }
  return ["score", "coverageBased"].every((key) => typeof candidate[key] === "number");
};
