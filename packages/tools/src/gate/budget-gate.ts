/**
 * 预算键结构门禁(`check:budget`)的**纯函数层**。
 *
 * ── 它断言什么,不断言什么 ──
 *
 * 只承担**结构性**断言:已定稿的预算键满足它们各自的形状约束(事件计数上限是中断粒度的
 * 整数倍(票 05),内存两键的夹逼与软阈下界(票 06)),以及中断粒度这个常量与它在文档里的三处
 * 副本逐字一致。它**不做**「取值是否贴边」这类结论性判断——那是动态失配断言(默认 `test` 项目)
 * 的活。重活(真引擎失配)留在那边。
 *
 * ── 为什么零 import、为什么读源码文本 ──
 *
 * 快门禁必须**零构建**(hld §2.2.1 / §2.2.7):它挂在 `check:quick`,`check:quick` 里不能出现
 * 「需要一次 `tsc -b`」的依赖。所以本模块不 import 真源包(`@model-war/schema`),改用两条既有缝:
 *
 * - 「每个预算键的标定状态」从 `packages/schema/src/ruleset-keys.ts` 的**源码文本**里读(与
 *   `gate/run-quickjs-coupling-gate.ts` 读冻结常量同族)。判据是键自己身上那个 `calibration.state`,
 *   **不是「值是不是 0」**。
 * - 「中断粒度」从 `packages/engine/src/runner/quickjs.ts` 的源码文本里抽(`packages/tools` 不得
 *   import 引擎,hld §3.2);探针侧的冻结副本由薄壳以相对 import 取来(`../sandbox-probes/constants.ts`)。
 *
 * ── 防假绿 ──
 *
 * 读到 0 个预算键、或 0 个已定稿的预算键,门禁**按失败处理**(与 `run-no-float-gate.ts` 的
 * 「一个文件都没读到」、`run-drift-gate.ts` 的「注册表空」同一条纪律):此时报「干净」是一条会
 * 一直绿的假门禁,比红更危险。
 */

/**
 * 八个预算键的名字。真源是 `packages/schema/src/ruleset-keys.ts` 的 `RULESET_KEY_CATALOG`;
 * 本门禁零构建、不能 import 真源包,故按名字去源码文本里取各自的标定状态。顺序即键清单的书写序。
 */
export const BUDGET_KEYS = [
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
  "scriptSizeLimit",
] as const;

/** `docs/hld.md` 里「中断粒度」副本的期望处数(§5.0 表 + §5.0 预算可复现段 + §5.3 机制表)。 */
export const HLD_GRANULARITY_COPIES = 3;

export type BudgetGateInput = {
  /** `rulesets/v1.json` 解析出来的取值(只用到预算键那几项)。 */
  readonly budgetValues: Readonly<Record<string, number | undefined>>;
  /** `packages/schema/src/ruleset-keys.ts` 的源码文本。 */
  readonly rulesetKeysSource: string;
  /** `packages/schema/src/ruleset.ts` 的源码文本(读软阈系数 `MEMORY_SOFT_THRESHOLD_RATIO`)。 */
  readonly rulesetSource: string;
  /** `packages/engine/src/runner/quickjs.ts` 的源码文本。 */
  readonly quickjsSource: string;
  /** `docs/hld.md` 的文本。 */
  readonly hldSource: string;
  /** 探针侧冻结常量 `INTERRUPT_EVERY_EVENTS`(由薄壳相对 import 传入)。 */
  readonly interruptEveryEvents: number;
  /**
   * 诚实侧基准脚本的存活堆峰值(bytes,探针侧冻结常量 `HONEST_ALIVE_HEAP_PEAK_BYTES`,由薄壳传入)。
   * 软阈(推导项)必须严格高于它,否则正常脚本会开始产内存压力观测。
   */
  readonly honestAliveHeapPeakBytes: number;
};

/** 一条已经查清原因的不通过。`check` 是判据名,`detail` 指名键名 / 常量与期望。 */
export type BudgetGateViolation = { readonly check: string; readonly detail: string };

export type BudgetGateReport = {
  /** 从源码文本里读到的预算键个数(防假绿的计数口之一)。 */
  readonly budgetKeys: number;
  /** 其中标定状态为已定稿的个数(防假绿的计数口之二)。 */
  readonly finalizedKeys: number;
  readonly violations: readonly BudgetGateViolation[];
};

type CalibrationState = "final" | "undetermined" | "missing";

/**
 * 从键清单源码文本里读一个键的 `calibration.state`。
 *
 * 定位手法:先按行首锚点找到 `<key>:` 的定义(`^\s*<key>\s*:`),再从那里向后找第一处
 * `calibration: { state: "..." }`。键名与 `calibration` 在同一个对象里,且键定义与它的标定行之间
 * 不会再出现别的键定义,所以这个「从定义处向后取第一处」是准的。读不到 → `"missing"`。
 */
const calibrationStateOf = (source: string, key: string): CalibrationState => {
  const keyIndex = new RegExp(String.raw`^\s*${key}\s*:`, "m").exec(source)?.index;
  if (keyIndex === undefined) {
    return "missing";
  }
  const match = /calibration\s*:\s*\{\s*state\s*:\s*"(final|undetermined)"/.exec(
    source.slice(keyIndex),
  );
  return match === null ? "missing" : (match[1] as "final" | "undetermined");
};

/** 引擎源码里 `INTERRUPT_EVENT_GRANULARITY = <n>` 的取值;读不到返回 `null`。 */
const quickjsGranularityOf = (source: string): number | null => {
  const match = /INTERRUPT_EVENT_GRANULARITY\s*=\s*(\d+)/.exec(source);
  return match === null ? null : Number(match[1]);
};

/** 真源包源码里 `MEMORY_SOFT_THRESHOLD_RATIO = <n>` 的取值;读不到返回 `null`。 */
const softThresholdRatioOf = (source: string): number | null => {
  const match = /MEMORY_SOFT_THRESHOLD_RATIO\s*=\s*(\d+(?:\.\d+)?)/.exec(source);
  return match === null ? null : Number(match[1]);
};

/** 文档里每一处「<n> 次控制流事件」的 n(三处副本靠这个模式定位)。 */
const granularityCopiesIn = (source: string): readonly number[] =>
  [...source.matchAll(/(\d+)\s*次控制流事件/g)].map((match) => Number(match[1]));

/**
 * 跑一次结构门禁,收集全部不通过项;空 `violations` 即通过。
 *
 * 结构上只对**已定稿**的预算键做形状断言;未定键整段跳过(它们的轨本就未启用)。票 07 要加的
 * 硬下界/夹逼(体积上限、墙钟)在这里追加一段即可,不必改上面的骨架。
 */
export const checkBudget = (input: BudgetGateInput): BudgetGateReport => {
  const violations: BudgetGateViolation[] = [];

  const states = new Map<string, CalibrationState>();
  for (const key of BUDGET_KEYS) {
    states.set(key, calibrationStateOf(input.rulesetKeysSource, key));
  }
  const budgetKeys = [...states.values()].filter((state) => state !== "missing").length;
  const finalizedKeys = [...states.values()].filter((state) => state === "final").length;

  for (const key of BUDGET_KEYS) {
    if (states.get(key) === "missing") {
      violations.push({
        check: "键清单",
        detail: `读不到 ${key} 的 calibration.state(键清单挪了窝或改了形态)`,
      });
    }
  }

  // ── 中断粒度:引擎宿主真源 ⇄ 探针冻结常量 ⇄ 文档三处副本(逐字一致)──

  const granularity = quickjsGranularityOf(input.quickjsSource);
  const copies = granularityCopiesIn(input.hldSource);

  if (granularity === null) {
    violations.push({
      check: "中断粒度",
      detail: "quickjs.ts 里读不到 INTERRUPT_EVENT_GRANULARITY",
    });
  }
  if (copies.length !== HLD_GRANULARITY_COPIES) {
    violations.push({
      check: "中断粒度副本",
      detail: `docs/hld.md 里「<n> 次控制流事件」有 ${copies.length} 处,期望 ${HLD_GRANULARITY_COPIES} 处`,
    });
  }
  if (granularity !== null) {
    if (input.interruptEveryEvents !== granularity) {
      violations.push({
        check: "中断粒度常量",
        detail:
          `探针侧 INTERRUPT_EVERY_EVENTS=${input.interruptEveryEvents} 与引擎 ` +
          `INTERRUPT_EVENT_GRANULARITY=${granularity} 不一致`,
      });
    }
    for (const copy of copies) {
      if (copy !== granularity) {
        violations.push({
          check: "中断粒度副本",
          detail: `docs/hld.md 的副本 ${copy} 与引擎常量 ${granularity} 不一致`,
        });
      }
    }
  }

  // ── 已定稿预算键的形状(值类型 + 各自的硬约束)──

  for (const key of BUDGET_KEYS) {
    if (states.get(key) !== "final") {
      continue;
    }
    const value = input.budgetValues[key];
    if (value === undefined) {
      violations.push({ check: "取值", detail: `已定稿的 ${key} 在规则集取值文件里缺席` });
      continue;
    }
    if (!Number.isInteger(value)) {
      violations.push({ check: "取值", detail: `已定稿的 ${key} 不是整数:${value}` });
    }
  }

  // 结构断言 #1(票 05):eventTickLimit 必须是中断粒度的整数倍——它的有效分辨率是一整格,
  // 小于一格的取值彼此等价。
  if (states.get("eventTickLimit") === "final" && granularity !== null) {
    const limit = input.budgetValues.eventTickLimit;
    if (limit !== undefined && Number.isInteger(limit)) {
      if (limit <= 0) {
        violations.push({ check: "整数倍", detail: `eventTickLimit=${limit} 必须是正数` });
      } else if (limit % granularity !== 0) {
        violations.push({
          check: "整数倍",
          detail:
            `eventTickLimit=${limit} 不是中断粒度 ${granularity} 的整数倍` +
            "(有效分辨率是一整格,小于一格的取值彼此等价)",
        });
      }
    }
  }

  // 结构断言 #2(票 06):内存两键的夹逼与软阈下界。
  //
  // 两个「未定」不是一件事,写在这里以区别于「值域约束」:**分配上限未定 = VM 不设任何上限;
  // 判罚线未定 = 该轨不启用**。两种「无保护」的形态不同,键落定后才各归其位。
  //
  // 上界换形态:原式「`memoryLimit` − 最大单次分配」不可执行(封顶依分配形态从约 96% 到
  // 「上限 − 请求量」都有,「最大单次分配」没有可代入定值),改成与分配形态无关的
  // 「判罚线 ≤ 分配上限的一半」。
  const softRatio = softThresholdRatioOf(input.rulesetSource);
  if (softRatio === null) {
    violations.push({
      check: "软阈系数",
      detail: "ruleset.ts 里读不到 MEMORY_SOFT_THRESHOLD_RATIO",
    });
  }
  if (states.get("memoryLimit") === "final" && states.get("memoryTickCeiling") === "final") {
    const limit = input.budgetValues.memoryLimit;
    const ceiling = input.budgetValues.memoryTickCeiling;
    if (
      limit !== undefined &&
      ceiling !== undefined &&
      Number.isInteger(limit) &&
      Number.isInteger(ceiling) &&
      limit > 0 &&
      ceiling > 0
    ) {
      // 上界:判罚线 ≤ 分配上限的一半(与分配形态无关,无探针时也站得住)。
      if (ceiling * 2 > limit) {
        violations.push({
          check: "内存夹逼",
          detail:
            `memoryTickCeiling=${ceiling} 超过 memoryLimit=${limit} 的一半` +
            "(上界:判罚线 ≤ 分配上限的一半)",
        });
      }
      // 下界:分配上限 ≥ 8 × 判罚线(粗保护,不是判罚线)。
      if (limit < 8 * ceiling) {
        violations.push({
          check: "内存夹逼",
          detail: `memoryLimit=${limit} 小于 8 × memoryTickCeiling=${ceiling}`,
        });
      }
      // 软阈(由系数推出的那个数,**不是键**)必须严格高于诚实存活堆峰值——否则正常脚本会开始
      // 产内存压力观测(噪声)。它与引擎的取整口径一致:向下取整到字节。
      if (softRatio !== null) {
        const softThreshold = Math.floor(softRatio * ceiling);
        if (softThreshold <= input.honestAliveHeapPeakBytes) {
          violations.push({
            check: "软阈下界",
            detail:
              `软阈 floor(${softRatio} × memoryTickCeiling=${ceiling})=${softThreshold} 未严格高于` +
              `诚实存活堆峰值 ${input.honestAliveHeapPeakBytes}`,
          });
        }
      }
    }
  }

  // ── 防假绿 ──

  if (budgetKeys === 0) {
    violations.push({ check: "防假绿", detail: "一个预算键都没读到,门禁目标失效" });
  }
  if (finalizedKeys === 0) {
    violations.push({
      check: "防假绿",
      detail: "没有已定稿的预算键,这道门禁什么也没断言",
    });
  }

  return { budgetKeys, finalizedKeys, violations };
};
