/**
 * vitest 插件规则的诊断(纯函数层):扫描结果 → 结论与建议。
 *
 * ── 这层回答的是「oxlint 那条规则到底在说什么」 ──────────────────────────────────
 *
 * oxlint 的 `vitest/no-conditional-expect` 只报「`expect` 写在 `if` / 三元里」的位置。
 * 位置本身不含风险:仓库里这类命中绝大多数是「有就查」——条件为假时那件事压根没发生,
 * 不查是对的。于是「命中 100 处」既不能判缺陷,也不能判无害,只能等人逐处看。
 *
 * 这一层把「风险」拆成**可复算的判定**:
 *   · `all-conditional` —— 该用例的**全部** `expect` 都在守卫里。条件为假时,这条用例
 *     一条断言都没跑,却仍然是绿的。这才是那条规则真正该抓的东西,而 `vitest/expect-expect`
 *     抓不到它(那条看的是静态上有没有 `expect`,不是运行时跑了没有)。
 *   · `partly-conditional` —— 部分在守卫里:某些分支没有断言(盲区)。
 *   · `loop-only` —— 断言都在循环体里:逐元素检查的常规写法(property test 对每个生成值断言),
 *     风险另计(「循环可能一次都不跑」),不算守卫。
 *   · 早退(`if (...) return;`)—— 规则看不见的那一类:`if` 体里没有 `expect`,所以规则不报,
 *     但条件不满足时那部分一样不查。
 *
 * ── 结论的形状:数出来的,不是看出来的 ───────────────────────────────────────────
 *
 * 每条结论都带一个**可复跑的命令**与**可核对的数**:同一份源码永远得到同一份结论,
 * 所以「有没有零断言用例」这类问题从此是查出来的,不是回忆出来的。
 *
 * 不碰文件系统、不读时钟:判定逻辑全在这一层,入口只负责读文件与落盘。
 */

import {
  scanConditionalExpects,
  GUARD_SHAPES,
  type ConditionalExpectScan,
  type ExpectShape,
  type ExpectSite,
  type SilentSkipKind,
  type SilentSkipSite,
  type TestCaseVerdict,
} from "./conditional-expect.ts";

/** 一份测试文件的扫描结论。 */
export type FileDiagnosis = {
  readonly path: string;
  readonly scan: ConditionalExpectScan;
};

/** 全仓的诊断结论。 */
export type VitestRulesDiagnosis = {
  readonly files: readonly FileDiagnosis[];
  /** 守卫形态的 `expect` 落点总数(对应 oxlint 那条规则的命中面)。 */
  readonly guardSites: number;
  /** 循环形态的 `expect` 落点总数。 */
  readonly loopSites: number;
  /** 无守卫的 `expect` 落点总数。 */
  readonly plainSites: number;
  /** 用例级判定统计。 */
  readonly caseVerdicts: Readonly<Record<TestCaseVerdict["verdict"], number>>;
  /** 早退按形态的统计。 */
  readonly skipKinds: Readonly<Record<SilentSkipKind, number>>;
  /** 早退总数。 */
  readonly silentSkips: number;
  /** 「整条用例可能零断言执行」的用例(高危)。 */
  readonly zeroAssertionCases: readonly TestCaseVerdict[];
  /** 用例级早退(整条用例被跳过)。 */
  readonly caseLevelSkips: readonly SilentSkipSite[];
  /** 解析不过的文件。 */
  readonly parseErrors: readonly (readonly [string, string])[];
};

const emptyVerdictCounts = (): Record<TestCaseVerdict["verdict"], number> => ({
  "all-conditional": 0,
  "partly-conditional": 0,
  none: 0,
  "no-expect": 0,
  "loop-only": 0,
});

const emptySkipCounts = (): Record<SilentSkipKind, number> => ({
  narrowing: 0,
  "catch-filter": 0,
  precondition: 0,
  "branch-filter": 0,
});

/**
 * 汇总一份仓库的扫描结果。
 *
 * 参数是「路径 → 源码」的映射(入口负责读文件);本函数不碰文件系统。
 */
export const diagnoseVitestRules = (sources: ReadonlyMap<string, string>): VitestRulesDiagnosis => {
  const files: FileDiagnosis[] = [];
  const caseVerdicts = emptyVerdictCounts();
  const skipKinds = emptySkipCounts();
  const parseErrors: (readonly [string, string])[] = [];
  const zeroAssertionCases: TestCaseVerdict[] = [];
  const caseLevelSkips: SilentSkipSite[] = [];
  let guardSites = 0;
  let loopSites = 0;
  let plainSites = 0;
  let silentSkips = 0;

  for (const [path, source] of [...sources.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const scan = scanConditionalExpects(source);
    files.push({ path, scan });
    if (scan.parseErrors.length > 0) {
      parseErrors.push([path, scan.parseErrors.join("; ") ?? ""]);
      continue;
    }
    for (const site of scan.sites) {
      if (site.shape === "plain") {
        plainSites += 1;
      } else if (site.shape === "loop-body") {
        loopSites += 1;
      } else {
        guardSites += 1;
      }
    }
    for (const verdict of scan.cases) {
      caseVerdicts[verdict.verdict] += 1;
      if (verdict.verdict === "all-conditional") {
        zeroAssertionCases.push(verdict);
      }
    }
    for (const skip of scan.silentSkips) {
      silentSkips += 1;
      skipKinds[skip.kind] += 1;
      if (skip.scope === "case") {
        caseLevelSkips.push(skip);
      }
    }
  }

  return {
    files,
    guardSites,
    loopSites,
    plainSites,
    caseVerdicts,
    skipKinds,
    silentSkips,
    zeroAssertionCases,
    caseLevelSkips,
    parseErrors,
  };
};

/** 守卫形态的中文名(报告用)。 */
export const shapeLabel = (shape: ExpectShape): string => {
  switch (shape) {
    case "plain":
      return "无守卫";
    case "if-guard":
      return "if 分支";
    case "loop-body":
      return "循环体";
    case "ternary":
      return "三元表达式";
    case "logical":
      return "逻辑表达式";
    case "switch-case":
      return "switch 分支";
    case "catch-body":
      return "catch 块";
    default:
      return shape;
  }
};

/** 早退形态的中文名(报告用)。 */
export const skipKindLabel = (kind: SilentSkipKind): string => {
  switch (kind) {
    case "narrowing":
      return "类型收窄";
    case "catch-filter":
      return "catch 分流";
    case "precondition":
      return "前置条件";
    case "branch-filter":
      return "分支过滤";
    default:
      return kind;
  }
};

/** 守卫形态清单(报告与文档引用同一份,别处不许自己抄一遍)。 */
export const guardShapeList = (): readonly string[] => [...GUARD_SHAPES];

/** 从诊断里抽出「守卫形态的落点」,按文件分组(报告用)。 */
export const guardSitesByFile = (
  diagnosis: VitestRulesDiagnosis,
): readonly (readonly [string, readonly ExpectSite[]])[] =>
  diagnosis.files
    .map((file) => {
      const sites = file.scan.sites.filter(
        (site) => site.shape !== "plain" && site.shape !== "loop-body",
      );
      return [file.path, sites] as const;
    })
    .filter(([, sites]) => sites.length > 0);
