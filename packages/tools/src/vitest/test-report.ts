/**
 * 测试观测:慢测试长尾与不稳定用例的判定(纯函数层)。
 *
 * ── 这层回答两个问题 ────────────────────────────────────────────────────────
 *
 * ① **哪些测试慢?** —— 不是「哪次构建慢」,而是「哪条用例慢」。用例级的耗时是
 *    长尾的唯一可操作单位:文件级耗时只能说「这个文件慢」,而文件里往往有十几条用例。
 * ② **哪些用例不稳定?** —— 「偶发红」要能被指认,才能修。
 *
 * ── 为什么不靠 vitest 的 `retry` ────────────────────────────────────────────
 *
 * `retry` 会把偶发红**藏起来**:重试过就绿,报告上什么都看不见。仓库对假绿敏感,
 * 而「先重跑一次、再记账」的语义已经存在(引擎故障轨:hld §2.2.4),所以这里照它:
 * **同一个用例跑两遍,拿两次的状态对比**。两次状态不同 = 不稳定;两次都红 = 稳定失败
 * (那是真缺陷,不是不稳定);两次都绿 = 这次没抓到它(两遍不够定论,报告里如实写)。
 *
 * 「两遍不够」这件事必须写在结论里:判定 flaky 的金标准是「同一用例在不同 run 里
 * 状态不同」,一次重跑只是**下限**——它能证明「它不稳定」,不能证明「它稳定」。
 *
 * 不碰文件系统、不跑测试、不读时钟:同一份输入永远得到同一份结论。
 */

/** 一条用例的一次执行结果。 */
export type TestOutcome = {
  /** 用例全名(不含文件路径)。 */
  readonly fullName: string;
  /** 所在文件(相对仓库根)。 */
  readonly file: string;
  /** 状态:`passed` / `failed` / `pending` / `skipped`。 */
  readonly status: string;
  /** 耗时(毫秒)。 */
  readonly durationMs: number;
};

/** 一次运行的结果。 */
export type TestRun = {
  readonly outcomes: readonly TestOutcome[];
  readonly totalTests: number;
  readonly passedTests: number;
  readonly failedTests: number;
  readonly pendingTests: number;
  /** 这次运行花了多久(毫秒)。 */
  readonly wallClockMs: number;
};

/** 慢用例的一条。 */
export type SlowTest = {
  readonly file: string;
  readonly fullName: string;
  readonly durationMs: number;
  /** 它占这次运行总测试耗时的比例。 */
  readonly shareOfTotal: number;
};

/** 不稳定用例的一条。 */
export type FlakyFinding = {
  readonly file: string;
  readonly fullName: string;
  readonly firstStatus: string;
  readonly secondStatus: string;
  /** 两次的耗时(毫秒),用来区分「慢而偶发」与「快而偶发」。 */
  readonly firstDurationMs: number;
  readonly secondDurationMs: number;
  /** 判据:两次状态不同即判不稳定。 */
  readonly reason: string;
};

/** 解析失败(报告形状不对)时的结论。 */
export type ParseProblem = {
  readonly message: string;
};

/** 解析 vitest 的 json reporter 输出。 */
export const parseVitestResults = (raw: unknown): TestRun | ParseProblem => {
  if (typeof raw !== "object" || raw === null) {
    return { message: "json reporter 的输出不是对象" };
  }
  const report = raw as Record<string, unknown>;
  const testResults = report["testResults"];
  if (!Array.isArray(testResults)) {
    return { message: "json reporter 的输出里没有 testResults 数组" };
  }
  const outcomes: TestOutcome[] = [];
  for (const entry of testResults) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const file = entry as Record<string, unknown>;
    const name = typeof file["name"] === "string" ? file["name"] : "";
    const assertions = file["assertionResults"];
    if (!Array.isArray(assertions)) {
      continue;
    }
    for (const assertion of assertions) {
      if (typeof assertion !== "object" || assertion === null) {
        continue;
      }
      const item = assertion as Record<string, unknown>;
      outcomes.push({
        fullName: typeof item["fullName"] === "string" ? item["fullName"] : "",
        file: name,
        status: typeof item["status"] === "string" ? item["status"] : "unknown",
        durationMs: typeof item["duration"] === "number" ? item["duration"] : 0,
      });
    }
  }
  const number = (key: string): number => {
    const value = report[key];
    return typeof value === "number" ? value : 0;
  };
  const started = number("startTime");
  return {
    outcomes,
    totalTests: number("numTotalTests"),
    passedTests: number("numPassedTests"),
    failedTests: number("numFailedTests"),
    pendingTests: number("numPendingTests"),
    wallClockMs: started,
  };
};

/** 判定解析结果。 */
export const isParseProblem = (value: TestRun | ParseProblem): value is ParseProblem =>
  "message" in value;

/** 取分位(输入已排序)。 */
const quantile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
};

/** 慢用例长尾:按耗时倒序取前 N 条,附分位统计。 */
export const slowTail = (
  run: TestRun,
  limit: number,
): readonly [
  readonly SlowTest[],
  { readonly p50: number; readonly p90: number; readonly p99: number; readonly max: number },
] => {
  const durations = run.outcomes
    .map((outcome) => outcome.durationMs)
    .sort((left, right) => left - right);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const sorted = [...run.outcomes].sort((left, right) => right.durationMs - left.durationMs);
  const top = sorted.slice(0, limit).map((outcome) => ({
    file: outcome.file,
    fullName: outcome.fullName,
    durationMs: outcome.durationMs,
    shareOfTotal: total > 0 ? outcome.durationMs / total : 0,
  }));
  return [
    top,
    {
      p50: quantile(durations, 0.5),
      p90: quantile(durations, 0.9),
      p99: quantile(durations, 0.99),
      max: durations[durations.length - 1] ?? 0,
    },
  ];
};

/** 用例的身份:文件 + 全名。 */
const identity = (outcome: TestOutcome): string => `${outcome.file}::${outcome.fullName}`;

/**
 * 对比两次运行,找出状态不一致的用例。
 *
 * 只在两次都出现该用例时才比(某次没跑到它,不算它稳定)。
 * 判据:两次状态不同 → 不稳定。
 */
export const compareRuns = (first: TestRun, second: TestRun): readonly FlakyFinding[] => {
  const firstById = new Map<string, TestOutcome>();
  for (const outcome of first.outcomes) {
    firstById.set(identity(outcome), outcome);
  }
  const secondById = new Map<string, TestOutcome>();
  for (const outcome of second.outcomes) {
    secondById.set(identity(outcome), outcome);
  }
  const findings: FlakyFinding[] = [];
  for (const [id, firstOutcome] of firstById) {
    const secondOutcome = secondById.get(id);
    if (secondOutcome === undefined) {
      continue;
    }
    if (firstOutcome.status === secondOutcome.status) {
      continue;
    }
    findings.push({
      file: firstOutcome.file,
      fullName: firstOutcome.fullName,
      firstStatus: firstOutcome.status,
      secondStatus: secondOutcome.status,
      firstDurationMs: firstOutcome.durationMs,
      secondDurationMs: secondOutcome.durationMs,
      reason:
        firstOutcome.status === "passed" && secondOutcome.status === "failed"
          ? "第一次通过、第二次失败"
          : firstOutcome.status === "failed" && secondOutcome.status === "passed"
            ? "第一次失败、第二次通过"
            : `两次状态不同(${firstOutcome.status} → ${secondOutcome.status})`,
    });
  }
  findings.sort(
    (left, right) =>
      right.firstDurationMs +
      right.secondDurationMs -
      (left.firstDurationMs + left.secondDurationMs),
  );
  return findings;
};

/** 两次都失败的用例(真缺陷,不是不稳定)。 */
export const consistentlyFailing = (first: TestRun, second: TestRun): readonly TestOutcome[] => {
  const firstById = new Map<string, TestOutcome>();
  for (const outcome of first.outcomes) {
    firstById.set(identity(outcome), outcome);
  }
  const secondById = new Map<string, TestOutcome>();
  for (const outcome of second.outcomes) {
    secondById.set(identity(outcome), outcome);
  }
  const failing: TestOutcome[] = [];
  for (const [id, firstOutcome] of firstById) {
    const secondOutcome = secondById.get(id);
    if (secondOutcome === undefined) {
      continue;
    }
    if (firstOutcome.status === "failed" && secondOutcome.status === "failed") {
      failing.push(firstOutcome);
    }
  }
  return failing;
};
