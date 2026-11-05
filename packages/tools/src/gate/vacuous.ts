/**
 * 空转检测的共享件:**被检数量为 0 时,这次检查什么也没断言**(CONTEXT.md《空转检测》)。
 *
 * ── 它收的是哪一种直觉 ──────────────────────────────────────────────────────
 * 「读到 0 个文件」「抽不出区块」「扫到 0 个符号」「比对集合为空」是同一条直觉的四种外壳:
 * 一项判据在自己的主语上什么都没看见时,报「干净」是一条会一直绿的假门禁,比红更危险。
 * 从前这条直觉由每道门禁各写一遍(带上各自的措辞与退出码),于是「写新门禁时记不记得它」
 * 全靠人。这里把它收成一处,并由 `vacuous.test.ts` 的元断言盯着「每道门禁都用了它」。
 *
 * ── 为什么是纯函数、返回理由而不是抛错 ──────────────────────────────────────
 * 与 `gates-harness.ts` 同一条分层纪律:门禁工具层只负责跑命令与读清单,不含断言、
 * 不 import 测试框架。所以这里**不 import vitest、不抛错**,只把「为什么这次是空转」写成
 * 一条中文理由字符串返回给调用方,空串表示「这次不是空转」:
 *
 *   - 调用方要非零退出,就 `if (reason !== "")` 报出去并退 1;
 *   - 调用方要把它记成一条违规,就把这条理由当 `detail`——与仓库现有的违规消息形态一致。
 *
 * 返回字符串而不是布尔,是因为**理由文案本身是可断言对象**:元断言与门禁自测都能直接读它,
 * 而不必去猜某道门禁把话说成了什么样。
 */

/** 一次判定的上下文:被检对象是什么、去哪里找过。 */
export type VacuousContext = {
  /** 被检对象的中文名词短语(可数),例如「引擎运行时源码文件」。 */
  readonly subject: string;
  /** 去哪里找过:路径、目录、注册表或采样计划,用来解释「为什么这里会是 0」。 */
  readonly scope: string;
};

/**
 * 空转检测:被检数量 ≤ 0 时返回「这次为什么是空转」的中文理由,否则返回空串。
 *
 * 阈值是 `> 0` 而不是 `=== 0`:负数是调用方的算错(集合被减出负数),与 0 同一种判决——
 * 都不能当作「有东西被查过」。
 */
export const vacuousReason = (count: number, context: VacuousContext): string =>
  count > 0
    ? ""
    : `读到 ${String(count)} 个${context.subject}(${context.scope}):这次检查什么也没断言,按失败处理。`;

/**
 * 门禁入口的路径形态:仓库里每一道门禁入口都叫 `run-*-gate.ts`。
 *
 * 元断言按这条路径规则**枚举真实源码树**,不写名单——所以本批后续新增的门禁入口
 * (以及任何将来新增的)自动进入它的视野。
 */
const GATE_ENTRY_PATTERN = /(^|\/)run-[a-z0-9-]+-gate\.ts$/;

/** 一个待判的源码:仓库根相对路径 + 文本。元断言因此不依赖文件系统就能被反例喂假源码。 */
export type GateSource = {
  readonly path: string;
  readonly text: string;
};

/** 免检入口:不是「可有可无」,而是**结构上不存在可数为 0 的被检集合**。每一条都写清理由。 */
export type VacuousExemption = {
  /** 仓库根相对路径(元断言会顺带断言它仍然存在,免得改名后豁免悄悄跟过去)。 */
  readonly path: string;
  /** 为什么它没有空转检测口。 */
  readonly reason: string;
};

/**
 * 免检清单。**只收结构上没有集合可数的入口**,不收「暂时不想改」的入口:
 *
 * - `run-scan-gate.ts` 是**观测**不是门禁(它自己的头注写着「这不是门禁,是一条观测」,
 *   CONTEXT.md《门禁》把门禁定义为「一条命名脚本断言」)。观测没有断言,也就没有可空转的判定;
 *   它的判决是「scc 装没装」,而 scc 缺失时写 `skipped` 标记正是它要的诚实结果。
 * - `run-quickjs-coupling-gate.ts` 比对的是两个版本号字符串(根依赖 ⇄ 冻结常量),
 *   判据没有「被检集合」这一维,凑一个计数口只会得到一行永远为 1 的死代码。
 * - `toolchain-coupling.ts` 是唯一不叫 `run-*-gate.ts` 的命名门禁入口(`pnpm run coupling`),
 *   形状与上一条同族(两个版本号比对),所以同样没有可数为 0 的集合。
 */
export const VACUOUS_EXEMPT_ENTRIES: readonly VacuousExemption[] = [
  {
    path: "packages/tools/src/gate/run-scan-gate.ts",
    reason: "观测不是门禁:没有断言,也就没有可空转的判定",
  },
  {
    path: "packages/tools/src/gate/run-quickjs-coupling-gate.ts",
    reason: "判据是两个版本号字符串的比对,没有可数为 0 的被检集合",
  },
  {
    path: "packages/tools/src/toolchain-coupling.ts",
    reason: "唯一不叫 run-*-gate.ts 的命名门禁入口,同样是两个版本号字符串的比对",
  },
] as const;

/** 入口路径是不是「必须做空转检测」的那一类(排除测试文件与免检入口)。 */
export const isAssertingGateEntry = (path: string): boolean =>
  GATE_ENTRY_PATTERN.test(path) && !path.endsWith(".test.ts");

/**
 * 去掉整行注释后再看调用点:头注里写到 `vacuousReason(...)` 不算「用了它」。
 *
 * 只去掉以 `//`、`*`、`/*` 开头的行(本仓库的行尾注释不写函数调用),够挡住「抄一段文档
 * 进头注就冒充调用」这条最省事的绕过。
 */
const codeLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");

/** 一个入口「真的用了共享件」= 从 `vacuous.ts` import 了它,且在代码行里调用了它。 */
const usesVacuousReason = (text: string): boolean => {
  const code = codeLines(text);
  const imported =
    /import\s*\{[^}]*\bvacuousReason\b[^}]*\}\s*from\s*["'][^"']*vacuous\.ts["']/s.test(code);
  const called = /\bvacuousReason\s*\(/.test(code);
  return imported && called;
};

/**
 * 元断言的判决:**返回「该有空转检测却没有」的入口路径**;空数组即全仓库都做了。
 *
 * 纯函数,输入是源码清单——反例因此不必改真实文件,喂一份「删掉 `vacuousReason` 调用」的
 * 篡改文本就够了。真实源码树那一侧由 `vacuous.test.ts` 读目录后喂进来。
 */
export const gatesMissingVacuousDetection = (sources: readonly GateSource[]): readonly string[] =>
  sources
    .filter((source) => isAssertingGateEntry(source.path))
    .filter(
      (source) => !VACUOUS_EXEMPT_ENTRIES.some((exemption) => source.path.endsWith(exemption.path)),
    )
    .filter((source) => !usesVacuousReason(source.text))
    .map((source) => source.path);
