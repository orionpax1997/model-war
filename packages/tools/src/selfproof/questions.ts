/**
 * 四问的判定:纯函数,进是跑批读数,出是四个「过 / 不过」加各自的读数。
 *
 * ── 断言对象只有外部可观察行为 ────────────────────────────────────────────────
 * 这一层吃的是桩跑完一场之后**引擎侧**的读数(终局原因、每席的采获/交付/峰值/名次、
 * 全图储量的消耗),以及静态校验器对产物的判决(退出码 + 报告文本)。
 * 它不读生成器排版、不读区块抽取、不读规则表任何一行——换 marker 语法、换区块抽取方式、
 * 改错误码的呈现形态,这一层一个字都不会变;改一个 API 名字或删一段判据,这一层会立刻红。
 *
 * ── 每问的判据与它的反例 ────────────────────────────────────────────────────
 * | 问 | 判据 | 能把它弄红的反例 |
 * |---|---|---|
 * | ① 零静态违规 | 静态校验器对三份产物各自退出码 0 | 把一份产物换成违规脚本 |
 * | ② 正常终局 | 每席 `exceptionTicks` 为 0,且终局原因属正常三种 | 让某份脚本整 tick 抛异常 |
 * | ③ 消耗 ≤ 1/4 | 每份脚本每席位消耗的中位与最坏单场都 ≤ 配额 | 把配额改小 |
 * | ④ 取策略互不相同 | 每一对脚本在行为指标上至少 3 项相对差 ≥ 25% | 三份换成同一份 |
 *
 * ② 的判据为什么落在 `exceptionTicks` 上:「被判负出局」在终稿契约里的唯一形态就是
 * 累计异常达 `exceptionTickLimit`(规则集文件里那一键当前是未定值占位 0,而 0 的含义是
 * 「一个异常 tick 都容不下」)。桩本身没有这一条裁决——它的三种终局原因只有
 * `victory` / `shortcut` / `timeout`——所以「有没有被判负」在桩这一侧只能由**异常 tick 数**
 * 与**终局原因**两项一起回答:异常数为 0,就不可能被任何 `exceptionTickLimit` 判负。
 * 被战斗打光单位与基地而淘汰是**正常终局**(那是淘汰条款,不是判负),不在这条判据里。
 */

/** 脚本标签:三份基准脚本各一个。索引对着 `benchmarks/` 的登记册顺序。 */
export const SCRIPT_LABELS = ["A", "B", "C"] as const;

export type ScriptLabel = (typeof SCRIPT_LABELS)[number];

/** 一场对局里**一个席位**的读数(全部由桩的引擎侧给出,见文件头注)。 */
export type SeatRow = {
  readonly label: ScriptLabel;
  /** 该席位整局的采获量。消耗按席位归因就用它:桩逐场验证过「消耗 ≡ 全场采获」。 */
  readonly harvests: number;
  /** 送到自家基地的量(实测吞吐的字面口径)。 */
  readonly delivered: number;
  readonly workerPeak: number;
  readonly unitPeak: number;
  /** 该席位驱动过的占领次数。 */
  readonly captures: number;
  readonly finalRank: number;
  readonly endWorker: number;
  readonly endMelee: number;
  readonly endRanged: number;
  readonly endCavalry: number;
  /** 全程农民占比,整数百分点。 */
  readonly workerSharePercent: number;
  readonly eliminated: boolean;
  readonly exceptionTicks: number;
};

/** 一场对局的读数(跑批时已裁剪过,不保留 `series` 那种逐帧大对象)。 */
export type MatchRow = {
  readonly id: string;
  /** 臂:无墙夹具对照 + 三张真图。 */
  readonly arm: string;
  readonly seed: number;
  readonly seats: readonly SeatRow[];
  readonly outcomeReason: string;
  readonly outcomeTick: number;
  /** 全图总储量(资源点数 × `resourcePerSite`)。 */
  readonly total: number;
  readonly remainingEnd: number;
  /** 消耗 = 总储量 − 终局剩余。 */
  readonly consumed: number;
  /** 自洽校验:消耗是否逐场等于全场采获之和。 */
  readonly harvestEqualsConsumed: boolean;
  readonly spawnOrders: number;
  readonly spawnOrdersRejectedBusyBase: number;
  readonly refunds: number;
};

/** 桩只有这三种终局原因(`engine.mjs` 的 evaluate / finishByTimeout),别的都算不正常。 */
export const NORMAL_OUTCOME_REASONS: readonly string[] = ["victory", "shortcut", "timeout"];

// ── ① 零静态违规 ────────────────────────────────────────────────────────────

export type StaticVerdict = {
  readonly name: string;
  /** 静态校验器的退出码:0 = 放行。 */
  readonly status: number;
  readonly output: string;
};

export type StaticCheck = {
  /** 判据用掉的体积上限(字节),以及它是从哪一条规则取的。 */
  readonly maxBytes: number;
  readonly maxBytesSource: string;
  readonly verdicts: readonly StaticVerdict[];
  readonly pass: boolean;
};

/**
 * ①的判定:三份产物**逐一**过静态校验器,退出码全 0 才算过。
 *
 * 判据问的是「契约没有把合规脚本判死」,所以它必须是**逐份**的:一份被判死就是红,
 * 哪怕另外两份干净。`maxBytes` 由调用方按规则取好传进来(取值理由在跑批入口),
 * 这一层不替它决定——体积上限是数值,归规则集文件那一侧。
 */
export const checkStatic = (
  verdicts: readonly StaticVerdict[],
  maxBytes: number,
  maxBytesSource: string,
): StaticCheck => ({
  maxBytes,
  maxBytesSource,
  verdicts,
  pass: verdicts.length > 0 && verdicts.every((verdict) => verdict.status === 0),
});

// ── ② 正常终局 ──────────────────────────────────────────────────────────────

export type OutcomeCheck = {
  readonly matches: number;
  readonly seats: number;
  readonly exceptionTicks: number;
  /** 异常 tick 最多的那一场(读数用,过不过由 `pass` 判)。 */
  readonly worstMatch: { readonly id: string; readonly exceptionTicks: number } | null;
  readonly reasons: Readonly<Record<string, number>>;
  /** 每个标签的异常 tick 合计,便于报告指出是哪一份在抛。 */
  readonly exceptionTicksByLabel: Readonly<Record<string, number>>;
  readonly abnormalOutcomes: readonly string[];
  readonly pass: boolean;
};

/** ②的判定:每席异常 tick 为 0,且每场终局原因属正常三种。 */
export const checkOutcomes = (matches: readonly MatchRow[]): OutcomeCheck => {
  const reasons: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  let exceptionTicks = 0;
  let seats = 0;
  let worst: { id: string; exceptionTicks: number } | null = null;
  const abnormalOutcomes: string[] = [];

  for (const match of matches) {
    reasons[match.outcomeReason] = (reasons[match.outcomeReason] ?? 0) + 1;
    if (!NORMAL_OUTCOME_REASONS.includes(match.outcomeReason)) {
      abnormalOutcomes.push(`${match.id}:${match.outcomeReason}`);
    }
    let perMatch = 0;
    for (const seat of match.seats) {
      seats += 1;
      perMatch += seat.exceptionTicks;
      byLabel[seat.label] = (byLabel[seat.label] ?? 0) + seat.exceptionTicks;
    }
    exceptionTicks += perMatch;
    if (worst === null || perMatch > worst.exceptionTicks) {
      worst = { id: match.id, exceptionTicks: perMatch };
    }
  }

  return {
    matches: matches.length,
    seats,
    exceptionTicks,
    worstMatch: worst,
    reasons,
    exceptionTicksByLabel: byLabel,
    abnormalOutcomes,
    pass: matches.length > 0 && exceptionTicks === 0 && abnormalOutcomes.length === 0,
  };
};

// ── ③ 消耗不超过总储量的 1/4(等效命题 ② 的复验) ─────────────────────────────

/** 消耗判据的默认配额:总储量的 1/4。 */
export const DEFAULT_QUOTA_PERCENT = 25;

export type ConsumptionStat = {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
};

export type ConsumptionCheck = {
  readonly quotaPercent: number;
  /** 各臂的总储量与配额(绝对量)。三张真图与无墙对照的点位数相同,取值应当一致——不一致即报出来。 */
  readonly totals: Readonly<Record<string, number>>;
  readonly quotaAbsolute: Readonly<Record<string, number>>;
  /** 每份脚本每席位的消耗(采获)中位与最坏单席。 */
  readonly byLabel: readonly {
    readonly label: ScriptLabel;
    readonly seats: number;
    readonly consumed: ConsumptionStat;
    /** 百分数的十分位整数(129 = 12.9%),分母是该臂的总储量。 */
    readonly medianTenthsPercent: number;
    readonly maxTenthsPercent: number;
    readonly medianPass: boolean;
    readonly maxPass: boolean;
  }[];
  /** 每臂整场的消耗中位与最坏单场(#13 那一轮的可比读数)。 */
  readonly byArm: readonly { readonly arm: string; readonly consumed: ConsumptionStat }[];
  /** 逐场「消耗 ≡ 全场采获」的自洽校验。 */
  readonly harvestEqualsConsumedEveryMatch: boolean;
  readonly batch: { readonly consumed: ConsumptionStat; readonly overQuota: number };
  readonly pass: boolean;
};

/**
 * ③的判定:每份脚本**每席位**消耗的中位与最坏单席都落在配额以内。
 *
 * 口径(必须随引用一起带,理由在文件头注与报告里):
 *   - **消耗** = 全图储量 − 终局剩余;桩逐场验证它**恒等于**全场采获之和,
 *     而采获是逐席位归因的,所以「某份脚本消耗多少」= 该脚本名下席位的采获之和。
 *   - 分母是**总储量**(资源点数 × `resourcePerSite`),不是单矿储量。
 *   - 每份脚本的读数按**每席位**取中位与最坏单席,而不是把一场里该脚本的两个席位合并——
 *     合并会让「占两个席位」这件事在读数上放大一份脚本的消耗,而判据问的是这份脚本的打法。
 */
export const checkConsumption = (
  matches: readonly MatchRow[],
  quotaPercent: number,
): ConsumptionCheck => {
  const totals: Record<string, number> = {};
  const quotaAbsolute: Record<string, number> = {};
  for (const match of matches) {
    totals[match.arm] = match.total;
    quotaAbsolute[match.arm] = Math.floor((match.total * quotaPercent) / 100);
  }

  const byLabel = SCRIPT_LABELS.map((label) => {
    const values = matches.flatMap((match) =>
      match.seats.filter((seat) => seat.label === label).map((seat) => seat.harvests),
    );
    const stat = consumptionStat(values);
    const total = totals[matches[0]?.arm ?? ""] ?? 0;
    const medianTenthsPercent = tenthsOfPercent(stat.median, total);
    const maxTenthsPercent = tenthsOfPercent(stat.max, total);
    const quota = quotaAbsolute[matches[0]?.arm ?? ""] ?? 0;
    return {
      label,
      seats: values.length,
      consumed: stat,
      medianTenthsPercent,
      maxTenthsPercent,
      medianPass: stat.median <= quota,
      maxPass: stat.max <= quota,
    };
  });

  const armNames = [...new Set(matches.map((match) => match.arm))].sort();
  const byArm = armNames.map((arm) => ({
    arm,
    consumed: consumptionStat(
      matches.filter((match) => match.arm === arm).map((match) => match.consumed),
    ),
  }));

  const batchValues = matches.map((match) => match.consumed);
  const overQuota = matches.filter(
    (match) => match.consumed > (quotaAbsolute[match.arm] ?? 0),
  ).length;

  return {
    quotaPercent,
    totals,
    quotaAbsolute,
    byLabel,
    byArm,
    harvestEqualsConsumedEveryMatch: matches.every((match) => match.harvestEqualsConsumed),
    batch: { consumed: consumptionStat(batchValues), overQuota },
    pass:
      matches.length > 0 &&
      byLabel.every((entry) => entry.medianPass && entry.maxPass) &&
      byArm.every((entry) => {
        const quota = quotaAbsolute[entry.arm] ?? 0;
        return entry.consumed.median <= quota && entry.consumed.max <= quota;
      }) &&
      matches.every((match) => match.harvestEqualsConsumed),
  };
};

// ── ④ 三份的取策略互不相同(区分度的可观测代理) ───────────────────────────────

/** 行为指标的一项:名字、人读标签,以及取它的口径。 */
export type BehaviorMetric = {
  readonly key: string;
  readonly label: string;
  /** 越大越「经济」还是越大越「军事」由标签写明;判据只看两两相对差。 */
  readonly of: (seats: readonly SeatRow[]) => number;
};

/** 相对差 ≥ 这个百分数,才算两项读数「不在同一档」。 */
export const DISTINCTNESS_GAP_PERCENT = 25;

/** 每一对脚本至少要有这么多项指标拉开到这个档,才判它们打法不同。 */
export const DISTINCTNESS_MIN_METRICS = 3;

/**
 * 行为指标表:每项都是「这份脚本在规则下实际做了什么」的直接读数,没有一项是排版或实现细节。
 *
 * 选这几项的理由:区分度问的是**打法**,所以每一项都要么是经济投入(采获/交付/农民),
 * 要么是军事投入(单位峰值/终局近战数),要么是这两者的比例(农民占比),要么是打法的结果
 * (占点次数/终局名次/淘汰率)。指标全部是整数:两个占比在读数阶段就乘 100 成了百分点。
 */
export const BEHAVIOR_METRICS: readonly BehaviorMetric[] = [
  { key: "harvests", label: "每席位采获中位", of: (seats) => median(seats.map((s) => s.harvests)) },
  {
    key: "delivered",
    label: "每席位交付中位",
    of: (seats) => median(seats.map((s) => s.delivered)),
  },
  {
    key: "workerPeak",
    label: "农民峰值中位",
    of: (seats) => median(seats.map((s) => s.workerPeak)),
  },
  { key: "unitPeak", label: "单位峰值中位", of: (seats) => median(seats.map((s) => s.unitPeak)) },
  { key: "endMelee", label: "终局近战数中位", of: (seats) => median(seats.map((s) => s.endMelee)) },
  {
    key: "workerSharePercent",
    label: "全程农民占比中位(百分点)",
    of: (seats) => median(seats.map((s) => s.workerSharePercent)),
  },
  {
    key: "captures",
    label: "占点驱动次数中位",
    of: (seats) => median(seats.map((s) => s.captures)),
  },
  { key: "finalRank", label: "终局名次中位", of: (seats) => median(seats.map((s) => s.finalRank)) },
  {
    key: "eliminationPercent",
    label: "被淘汰席位占比(百分点)",
    of: (seats) =>
      seats.length > 0
        ? Math.round((seats.filter((seat) => seat.eliminated).length * 100) / seats.length)
        : 0,
  },
];

export type PairGap = {
  readonly left: ScriptLabel;
  readonly right: ScriptLabel;
  /** 每一项指标上的相对差(百分点)。 */
  readonly gaps: readonly {
    readonly key: string;
    readonly left: number;
    readonly right: number;
    readonly gap: number;
  }[];
  /** 拉开到档的项数。 */
  readonly separated: number;
  readonly pass: boolean;
};

export type DistinctnessCheck = {
  /** 每个标签在每项指标上的读数。 */
  readonly fingerprints: readonly {
    readonly label: ScriptLabel;
    readonly seats: number;
    readonly values: readonly number[];
  }[];
  readonly pairs: readonly PairGap[];
  readonly separatedNeeded: number;
  readonly pass: boolean;
};

/**
 * ④的判定:每一对脚本在行为指标上至少有 `DISTINCTNESS_MIN_METRICS` 项的相对差
 * 达到 `DISTINCTNESS_GAP_PERCENT`,且三份脚本的指纹两两不同。
 *
 * 相对差取 `|x−y| / max(|x|,|y|)` 而不是差值:指标量纲差着三四个数量级
 * (采获是几百、农民占比是几十),只有归一化之后的差距才说明「读数不在同一档」。
 * 两项都是 0 时相对差记 0——「都没有」不算一种打法。
 *
 * 判据是**逐对**的,所以把三份换成同一份时每一对的分开项数都掉到 0,当场红;
 * 而「三份里只有两分得开」这种形态同样红:那正是「规则集还没被证明有区分度」的样子。
 */
export const checkDistinctness = (matches: readonly MatchRow[]): DistinctnessCheck => {
  const fingerprints = SCRIPT_LABELS.map((label) => {
    const seats = matches.flatMap((match) => match.seats.filter((seat) => seat.label === label));
    return {
      label,
      seats: seats.length,
      values: BEHAVIOR_METRICS.map((metric) => metric.of(seats)),
    };
  });

  const pairs: PairGap[] = [];
  for (let i = 0; i < SCRIPT_LABELS.length; i += 1) {
    for (let j = i + 1; j < SCRIPT_LABELS.length; j += 1) {
      const left = fingerprints[i];
      const right = fingerprints[j];
      if (left === undefined || right === undefined) continue;
      const gaps = BEHAVIOR_METRICS.map((metric, index) => ({
        key: metric.key,
        left: left.values[index] ?? 0,
        right: right.values[index] ?? 0,
        gap: gapPercent(left.values[index] ?? 0, right.values[index] ?? 0),
      }));
      const separated = gaps.filter((entry) => entry.gap >= DISTINCTNESS_GAP_PERCENT).length;
      pairs.push({
        left: left.label,
        right: right.label,
        gaps,
        separated,
        pass: separated >= DISTINCTNESS_MIN_METRICS,
      });
    }
  }

  return {
    fingerprints,
    pairs,
    separatedNeeded: DISTINCTNESS_MIN_METRICS,
    pass: matches.length > 0 && pairs.length === 3 && pairs.every((pair) => pair.pass),
  };
};

// ── 小工具(整数口径:百分比一律取整,中位一半时向下取整) ───────────────────────

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.floor(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

export const consumptionStat = (values: readonly number[]): ConsumptionStat => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    median: median(sorted),
    max: sorted[sorted.length - 1] ?? 0,
  };
};

/**
 * 百分数的**十分位**整数(129 = 12.9%)。不用整数百分:12.9% 与 12.94% 在这一层会被
 * 抹成同一个数,而消耗读数恰恰落在同一位数上,抹掉一位小数就抹掉了判读要用的那点差别。
 */
export const tenthsOfPercent = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part * 1000) / whole) : 0;

/** 相对差百分点。 */
export const gapPercent = (left: number, right: number): number => {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 ? Math.round((Math.abs(left - right) * 100) / scale) : 0;
};
