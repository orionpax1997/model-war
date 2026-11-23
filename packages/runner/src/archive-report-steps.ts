/**
 * 档案 v3（agent 形态）的报告读模型：过程记录、步级度量与受污染分层（ADR-0035 / ADR-0036）。
 *
 * ── 这里为什么是一份独立的读模型，而不是塞进 `archive-report.ts` ──
 *
 * 那个文件已经是「逐候选 / 逐轮 / 观测 / 分数」四件事的落点，再塞三件事会让「v3 与旧档按版本
 * 分派」这条线淹没在别的分支里。本文件只回答三个新问题，且每个都写成**纯函数**（不读盘、不碰
 * gen）：
 *
 * 1. `steps` 怎么读、`round == step` 的左连接成不成立（ADR-0035：不匹配要**显式数出来**，
 *    不许静默通过——静默会把「证据缺失」渲染成「这一步没有失败原因」）；
 * 2. 步级耗时 / prompt 大小 / 增长怎么算（ADR-0035：`stepMs = sendMs + harnessMs`，
 *    总墙钟由 `max(atMs + sendMs + harnessMs)` 跨步聚合，不往 `meta` 顶层另放一份）；
 * 3. 受污染会话怎么判（ADR-0036：判据落在**报告侧**，阈值写在报告脚注）。
 *
 * ── 缺数据一律 null，不是 0 ──
 *
 * 三个「没有」是三种事实，形状上也分得开：`steps: null` = 这一档没有过程记录（v1 / v2）；
 * `entries: []` = 零步会话（合法形状，ADR-0031）；`null` 字段 = 这一步这一格没记到。
 * `errorCodes: []` 与 `result` 缺席也不混用——前者是「跑过了，没有错误」，后者是「没有结果」。
 */

import {
  ARCHIVE_TERMINATIONS,
  type ArchiveShapeVersion,
  type ArchiveTermination,
} from "@model-war/schema";

import type { ArchiveReport, ArchiveReportRound } from "./archive-report.js";
import { numberOf, objectOf } from "./archive-report-evidence.js";

/**
 * 分位读数。`count` 是参与计算的值个数——它是「这些分位由几个数得来」的唯一凭据：
 * `count: 0` 时三格全 `null`，渲染成「不适用」，不写 0（缺数据与真实零耗时是两件事）。
 */
export type ReportPercentiles = {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly count: number;
};

/** v3 档的形状事实（ADR-0029 / ADR-0031）：旧档一律 `null`，不迁移、不回填。 */
export type ReportArchiveShape = {
  /** `"legacy"` = 没有 `archiveSchemaVersion` 的历史档；报告按它分派整张表。 */
  readonly archiveSchemaVersion: ArchiveShapeVersion;
  readonly harnessVersion: string | null;
  /** harness 行为清单的摘要。与 `modelVersion` 一起构成步级分位的**分组维度**。 */
  readonly harnessDigest: string | null;
  /** 模型席位的上下文窗口：档案自足，历史报告不用今天的配置解释昨天的行为。 */
  readonly contextLength: number | null;
  /** 这次会话怎么停的。与落档判据正交：`done` 与 `max-steps` 都可能产出成功档。 */
  readonly termination: ArchiveTermination | null;
  /** 终止发生在第几步（0 = 一次模型调用都没有成功）。 */
  readonly atStep: number | null;
};

/**
 * 过程记录里那一步的**动作**（ADR-0031 的闭集，v4 起六档）。`null` = 档案里的取值不在闭集里。
 *
 * 下标数组（`actions`）与这份类型是**同一件事的两份写法**：新增一档要两处都改，否则步级表那一格
 * 会渲染成 `null`（看起来像「档案里没这一项」而不是「这一项没被认识」）。这条纪律归票 05 收口，
 * 本票只保证 `check` / `probe` 两档两处都在。
 */
export type ReportStepAction = "bash" | "check" | "probe" | "evaluate" | "done" | "none";

/** 结果侧证据（`steps[i].result`）：这一轮被什么驱动、编译错误码。 */
export type ReportStepResult = {
  readonly kind: "tsc" | "contract";
  /** 空数组 = 跑过了、没有错误；`result` 整体缺席才是「没有结果」。 */
  readonly errorCodes: readonly string[];
};

/** 过程记录条目在报告侧的投影：**只搬字段，不搬判定**。 */
export type ReportStep = {
  readonly step: number;
  readonly action: ReportStepAction | null;
  /** 步起点相对会话起点的毫秒偏移（不比绝对时钟：绝对时钟会破坏档案的确定性）。 */
  readonly atMs: number | null;
  /** 沙箱执行加观测回填；与 `sendMs` 互补，相加即整步。 */
  readonly harnessMs: number | null;
  /** 左连接自 `generationLog` 的同一轮（`round == step`）：一个事实一个家，不复制进步记录。 */
  readonly sendMs: number | null;
  /** `sendMs + harnessMs`；缺一项即 `null`（不拿半边冒充整步）。 */
  readonly stepMs: number | null;
  /** 这一步的 prompt 大小 = 那一轮的 `usage.input`（撞窗口的预测器）。 */
  readonly inputTokens: number | null;
  /** `input[i] − input[i−1]`；**首步 `null`**，不是 0。 */
  readonly inputGrowth: number | null;
  /** 逐步命中率：**回归哨兵**（前缀被打断的信号），不是效率指标。 */
  readonly cacheHitRate: number | null;
  readonly result: ReportStepResult | null;
  readonly exitCode: number | null;
  /**
   * 这一步发起的那一次工具调用（v4 才有）：`name` 与**逐字**的 `argumentsJson`。
   *
   * 它是 ADR-0031「模型看到的字节 = 落盘的字节」在读侧的落点：发回历史的
   * `tool_calls[0].function.arguments` 就是这串字节。所以报告只搬它、**不按 `action.command`
   * 重编码**——两者可以不同形（转义写法、空格），而重编码等于悄悄换掉发回去的东西。
   * v3 档（那时还没有工具调用信封）与 `action.kind === "none"` 的步都是 `null`。
   */
  readonly toolCall: ReportStepToolCall | null;
  /** 这一行日志关联上了没有（`round == step`）。 */
  readonly roundLinked: boolean;
};

/** 一次工具调用的报告投影：名字 + 参数原文（不解析、不重编码）。 */
export type ReportStepToolCall = {
  readonly name: string;
  readonly argumentsJson: string;
};

/**
 * 「轮号 = 步号」这条左连接的体检（ADR-0035「报告必须显式数不匹配的次数」）。
 *
 * `stepsWithoutRound` 是**真会出现**的那一侧：日志行缺一条（截断重试被当成独立一步、或某行
 * 解析不过被剔掉），步号就找不到它的发送侧证据。`roundsWithoutStep` 是另一侧；传输末行
 * （`responseConverged: false`）**不算**不匹配——它本来就不占步（ADR-0031）。
 */
export type ReportStepJoin = {
  readonly state: "complete" | "mismatched";
  readonly matched: number;
  readonly stepsWithoutRound: readonly number[];
  readonly roundsWithoutStep: readonly number[];
};

/** 步级统计：分位 + 两个跨步聚合（ADR-0035：会话级读数由聚合得出，不另立字段）。 */
export type ReportStepStats = {
  readonly steps: number;
  readonly stepMs: ReportPercentiles;
  readonly sendMs: ReportPercentiles;
  /** 会话级中位数 = 本档各步 `stepMs` 的中位数。 */
  readonly sessionMedianStepMs: number | null;
  /** 会话总墙钟 = `max(atMs + sendMs + harnessMs)`；三项齐备的步才参与。 */
  readonly sessionWallClockMs: number | null;
  /** 每步 prompt 大小的分布（离窗口多近由它与 `contextLength` 相除回答）。 */
  readonly inputTokens: ReportPercentiles;
  /** 增长量里最大的那一格；一步都没有增长时 `null`。 */
  readonly maxInputGrowth: number | null;
};

export type ReportSteps = {
  readonly entries: readonly ReportStep[];
  readonly join: ReportStepJoin;
  readonly stats: ReportStepStats;
};

/**
 * 受污染会话的判定阈值（ADR-0036）。
 *
 * **它在这里是命名的，不是藏起来的**：报告脚注由这两个数渲染，读者不必猜「60 s 是哪来的」。
 * 两个数都是估值而不是实测（ADR-0036 残余风险 4），回第一季数据时改的只是这里。
 */
export const CONTAMINATION_THRESHOLDS = {
  /** 累计退避超过它 = 不是抖动。 */
  backoffMs: 60_000,
  /** 429 次数达到它 = 被反复挡住。 */
  rateLimitedAttempts: 3,
} as const;

export type ReportContaminationReason = "rate-limited>=3" | "backoff>60s";

/**
 * 「这个会话撞过限流」——数据的分层，不是数据的注解（ADR-0036）。
 *
 * 成绩不因此作废：受污染会话照常进报告（成绩、步数、被挡几次、等了多少秒都在），只是单列。
 * one-shot 档这一格恒 `null`：`readFailureRecords` 刻意跳过参赛模型，本报告不为封存的历史榜
 * 改那条口径（ADR-0036 的代价条款）。
 */
export type ReportContamination = {
  readonly state: "clean" | "contaminated";
  /** `failureKind: "rate-limited"` 的尝试次数；`0` 是真实零次，不是缺数据。 */
  readonly rateLimitedAttempts: number;
  /**
   * 累计退避毫秒。真源是日志行的 `backoffMs`：生成侧按**实测**等待写，没有退避写 `0`。
   * `null` = 旧档的日志行没有这一格（不知道），不是“没等”：缺数据不补零，也不会被当成 0 秒。
   */
  readonly backoffMs: number | null;
  readonly reasons: readonly ReportContaminationReason[];
};

/** 步级分位的一个分组：键是 `modelVersion + harnessDigest`（与榜键同一套维度）。 */
export type ReportStepGroup = {
  readonly modelVersion: string | null;
  readonly harnessDigest: string | null;
  /** 参与分位的会话数（**干净**会话）。 */
  readonly sessions: number;
  readonly steps: number;
  readonly stepMs: ReportPercentiles;
  readonly sendMs: ReportPercentiles;
  /** 会话级中位数：先取每个会话的中位数，再取这些中位数的中位数。 */
  readonly sessionMedianStepMs: number | null;
  /** 同一分组里被单列的受污染会话数：排除是**可见**的，不是静默的。 */
  readonly contaminatedSessions: number;
};

const EMPTY_PERCENTILES: ReportPercentiles = { p50: null, p95: null, max: null, count: 0 };

/**
 * 最近秩分位（**不插值**）。插值会把整数毫秒读成小数，而这个仓库的读数按整数看；
 * `p = 0.5` 时取 `ceil(0.5n)` 那一格，两值时为较低的那个中位数——口径写在这里一处。
 */
const percentilesOf = (values: readonly number[]): ReportPercentiles => {
  if (values.length === 0) return EMPTY_PERCENTILES;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length))) - 1]!;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, count: sorted.length };
};

/** 允许负数的整数读数（退出码）。`numberOf` 只收非负，别把它用在这两处。 */
const integerOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const stringOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * `steps[i].toolCall` 的读入。
 *
 * **缺席是合法的**（v3 档、以及没有动作的步），而在场就必须两个键都是字符串：把它降级成
 * `null` 会让「读不出」与「没有过这次调用」同形——那正是 ADR-0031 那一格要防的事。
 */
const toolCallOf = (raw: unknown): ReportStepToolCall | null => {
  if (raw === undefined) return null;
  const value = objectOf(raw);
  const name = stringOf(value.name);
  const argumentsJson = stringOf(value.argumentsJson);
  if (name === null || argumentsJson === null)
    throw new Error("过程记录的工具调用必须是 {name, argumentsJson} 两个字符串");
  return { name, argumentsJson };
};

const actions: readonly ReportStepAction[] = ["bash", "check", "probe", "evaluate", "done", "none"];

const actionOf = (raw: unknown): ReportStepAction | null => {
  const kind = objectOf(raw).kind;
  return typeof kind === "string" && (actions as readonly string[]).includes(kind)
    ? (kind as ReportStepAction)
    : null;
};

/**
 * 结果侧证据的读入。
 *
 * `undefined` = 这一步没有结果（超时、被杀、配额在动作执行前就切断），是**合法**的缺席；
 * 而**在场但形状不对**必须拒读：把它降级成「没有结果」会让「读不出」与「没跑过」同形，
 * 那正是 ADR-0035 把结果包一层要防的事。
 */
const resultOf = (raw: unknown): ReportStepResult | null => {
  if (raw === undefined) return null;
  const value = objectOf(raw);
  const kind = value.kind;
  if (kind !== "tsc" && kind !== "contract")
    throw new Error("过程记录的结果侧证据 kind 只能是 tsc / contract");
  if (!Array.isArray(value.errorCodes) || value.errorCodes.some((code) => typeof code !== "string"))
    throw new Error("过程记录的结果侧证据 errorCodes 必须是字符串数组");
  return { kind, errorCodes: value.errorCodes as readonly string[] };
};

/** v3 档的形状事实。旧档没有这几格：一律 `null`，不按今天的配置兜底。 */
export const archiveShapeOf = (
  record: Record<string, unknown>,
  shape: ArchiveShapeVersion,
): ReportArchiveShape => {
  if (shape === "legacy")
    return {
      archiveSchemaVersion: "legacy",
      harnessVersion: null,
      harnessDigest: null,
      contextLength: null,
      termination: null,
      atStep: null,
    };
  const termination = record.termination;
  if (
    termination !== undefined &&
    !(ARCHIVE_TERMINATIONS as readonly unknown[]).includes(termination)
  )
    throw new Error("终止原因不在 ADR-0032 的闭集里：拒读，不猜");
  return {
    archiveSchemaVersion: shape,
    harnessVersion: stringOf(record.harnessVersion),
    harnessDigest: stringOf(record.harnessDigest),
    contextLength: numberOf(record.contextLength),
    termination: termination === undefined ? null : (termination as ArchiveTermination),
    atStep: numberOf(record.atStep),
  };
};

/**
 * 过程记录 → 报告读模型（v3 才有；旧档返回 `null` = 这一档没有步）。
 *
 * 步号的规则是 ADR-0031 的「步号 1 起、与轮号同义」：`1..n` 连续、`n` 等于协议轮数。
 * 不连续就拒读——那意味着某一步丢了或者号编错了，无论哪种，按号数的左连接都不再成立。
 */
export const stepsOf = (input: {
  readonly record: Record<string, unknown>;
  readonly shape: ArchiveShapeVersion;
  readonly rounds: readonly ArchiveReportRound[];
  readonly protocolRounds: number;
}): ReportSteps | null => {
  if (input.shape === "legacy") return null;
  const raw = input.record.steps;
  if (!Array.isArray(raw)) throw new Error("v3 档案缺过程记录 steps：形状版本 3 要求它，拒读");
  const numbers = raw.map((item) => numberOf(objectOf(item).step));
  if (numbers.length !== input.protocolRounds || numbers.some((step, index) => step !== index + 1))
    throw new Error("v3 档案的过程记录步号不是 1..协议轮数 的连续序列：拒读");

  // 传输末行不占步（ADR-0031）：它没有过程记录条目，也不该被数成「轮号多余」。
  const converged = input.rounds.filter((round) => round.responseConverged);
  const byStep = new Map(converged.map((round) => [round.round, round]));
  let previousInput: number | null = null;
  const entries: ReportStep[] = raw.map((item, index) => {
    const value = objectOf(item);
    const step = index + 1;
    const round = byStep.get(step);
    const sendMs = round?.sendMs ?? null;
    const harnessMs = numberOf(value.harnessMs);
    const inputTokens = round?.usage.input.value ?? null;
    const entry: ReportStep = {
      step,
      action: actionOf(value.action),
      atMs: numberOf(value.atMs),
      harnessMs,
      sendMs,
      stepMs: sendMs === null || harnessMs === null ? null : sendMs + harnessMs,
      inputTokens,
      inputGrowth:
        index === 0 || previousInput === null || inputTokens === null
          ? null
          : inputTokens - previousInput,
      cacheHitRate: round?.cacheHitRate ?? null,
      result: resultOf(value.result),
      exitCode: integerOf(value.exitCode),
      toolCall: toolCallOf(value.toolCall),
      roundLinked: round !== undefined,
    };
    previousInput = inputTokens;
    return entry;
  });

  const stepsWithoutRound = entries.filter((entry) => !entry.roundLinked).map((e) => e.step);
  const linked = new Set(entries.map((entry) => entry.step));
  const roundsWithoutStep = converged
    .filter((round) => !linked.has(round.round))
    .map((round) => round.round);
  const stepMs = entries.flatMap((entry) => (entry.stepMs === null ? [] : [entry.stepMs]));
  const sendMs = entries.flatMap((entry) => (entry.sendMs === null ? [] : [entry.sendMs]));
  const inputTokens = entries.flatMap((entry) =>
    entry.inputTokens === null ? [] : [entry.inputTokens],
  );
  const growth = entries.flatMap((entry) =>
    entry.inputGrowth === null ? [] : [entry.inputGrowth],
  );
  const wallClocks = entries.flatMap((entry) =>
    entry.atMs === null || entry.stepMs === null ? [] : [entry.atMs + entry.stepMs],
  );
  const stepMsPercentiles = percentilesOf(stepMs);
  return {
    entries,
    join: {
      state:
        stepsWithoutRound.length === 0 && roundsWithoutStep.length === 0
          ? "complete"
          : "mismatched",
      matched: entries.length - stepsWithoutRound.length,
      stepsWithoutRound,
      roundsWithoutStep,
    },
    stats: {
      steps: entries.length,
      stepMs: stepMsPercentiles,
      sendMs: percentilesOf(sendMs),
      sessionMedianStepMs: stepMsPercentiles.p50,
      sessionWallClockMs: wallClocks.length === 0 ? null : Math.max(...wallClocks),
      inputTokens: percentilesOf(inputTokens),
      maxInputGrowth: growth.length === 0 ? null : Math.max(...growth),
    },
  };
};

/**
 * 受污染判定（ADR-0036）。判据在**报告侧**，采集侧只负责把 `failureKind` 写进尝试证据。
 *
 * `null` = 这一档不属本口径：one-shot 档读不到「不完整会话」（`readFailureRecords` 跳过参赛
 * 模型），所以这一列在历史档上恒为 `null`，不是「没有撞过限流」。
 */
export const contaminationOf = (input: {
  readonly shape: ArchiveShapeVersion;
  readonly rounds: readonly ArchiveReportRound[];
}): ReportContamination | null => {
  if (input.shape === "legacy") return null;
  let rateLimitedAttempts = 0;
  let backoffMs: number | null = null;
  for (const round of input.rounds) {
    for (const attempt of round.attempts)
      if (attempt.failureKind === "rate-limited") rateLimitedAttempts += 1;
    if (round.backoffMs !== null) backoffMs = (backoffMs ?? 0) + round.backoffMs;
  }
  const reasons: ReportContaminationReason[] = [];
  if (rateLimitedAttempts >= CONTAMINATION_THRESHOLDS.rateLimitedAttempts)
    reasons.push("rate-limited>=3");
  if (backoffMs !== null && backoffMs > CONTAMINATION_THRESHOLDS.backoffMs)
    reasons.push("backoff>60s");
  return {
    state: reasons.length === 0 ? "clean" : "contaminated",
    rateLimitedAttempts,
    backoffMs,
    reasons,
  };
};

/**
 * 步级分位按 `modelVersion + harnessDigest` 分组（ADR-0035：与榜键同一套维度）。
 *
 * **受污染会话不参与分位**（ADR-0036「主排名只放干净会话」），但分组里仍报出被单列了几场——
 * 把排除做可见，而不是让读者以为这一组就只有这么多会话。没有步的档（v1 / v2）不进任何分组。
 */
export const stepGroupsOf = (reports: readonly ArchiveReport[]): readonly ReportStepGroup[] => {
  const groups = new Map<string, ArchiveReport[]>();
  for (const report of reports) {
    if (report.steps === null) continue;
    const key = JSON.stringify([report.modelVersion, report.shape.harnessDigest]);
    const bucket = groups.get(key) ?? [];
    bucket.push(report);
    groups.set(key, bucket);
  }
  const entriesOf = (report: ArchiveReport): readonly ReportStep[] => report.steps?.entries ?? [];
  const result: ReportStepGroup[] = [];
  for (const bucket of groups.values()) {
    const clean = bucket.filter((report) => report.contamination?.state !== "contaminated");
    const valuesOf = (
      reportsIn: readonly ArchiveReport[],
      pick: (entry: ReportStep) => number | null,
    ): readonly number[] =>
      reportsIn.flatMap((report) =>
        entriesOf(report).flatMap((entry) => {
          const value = pick(entry);
          return value === null ? [] : [value];
        }),
      );
    const sessionMedians = clean.flatMap((report) => {
      const median = report.steps?.stats.sessionMedianStepMs ?? null;
      return median === null ? [] : [median];
    });
    const first = bucket[0]!;
    result.push({
      modelVersion: first.modelVersion,
      harnessDigest: first.shape.harnessDigest,
      sessions: clean.length,
      steps: clean.reduce((sum, report) => sum + entriesOf(report).length, 0),
      stepMs: percentilesOf(valuesOf(clean, (entry) => entry.stepMs)),
      sendMs: percentilesOf(valuesOf(clean, (entry) => entry.sendMs)),
      sessionMedianStepMs: percentilesOf(sessionMedians).p50,
      contaminatedSessions: bucket.length - clean.length,
    });
  }
  return result.sort(
    (a, b) =>
      (a.modelVersion ?? "").localeCompare(b.modelVersion ?? "") ||
      (a.harnessDigest ?? "").localeCompare(b.harnessDigest ?? ""),
  );
};
