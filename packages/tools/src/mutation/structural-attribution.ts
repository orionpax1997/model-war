/**
 * 结构归因表:**哪些文件的变异体测不到,以及为什么**。
 *
 * ── 这张表补的是哪一个洞 ────────────────────────────────────────────────────
 *
 * 变异分数低有两种完全不同的成因:
 *
 * - **测试弱**:这个文件的行为没有被断言钉住 → 该补测试;
 * - **测不到**:这个文件的行为根本没法在 Stryker 的夹具里被观察 → 补测试也白搭,
 *   要动的是范围(移出 `mutate`)或夹具(让它可测)。
 *
 * 两者混在一起,低分片就会被误判成「测试弱」,于是人去买不该买的测试;反过来,
 * 真正该补测试的那部分被「不可测」的名目吞掉,于是永远没人补。
 * `stryker/base.mjs` 的头注把这些成因写在散文里(散文是给人读的,机器读不到),
 * 这张表是同一批事实的**机器可读形态**——诊断脚本靠它把 `NoCoverage` 分成两桶。
 *
 * ── 散文与表的关系 ──────────────────────────────────────────────────────────
 *
 * 散文解释「为什么」(机制、实测数字),表登记「哪些文件」(可执行的名单)。
 * 两边是同一批事实的两种形态,不是两个家:**表是名单的家,散文是理由的家**。
 * 改动时两处一起改;只改一边,机器读到的与散文讲的对不上。
 *
 * ── 归因只有三类,每一类都有可观察的判据 ────────────────────────────────────
 *
 * | 归因 | 判据 | 处置 |
 * |---|---|---|
 * | `string-embedded` | 该文件以**字符串源**形式被载入(编译期拼成字符串再 eval),从不进 ES 模块图 → 覆盖归因不了 | 移出 mutate 范围,或改成真 import |
 * | `spawn-only` | 该文件只被**spawn 子进程**的门禁自测观察(真实门禁跑它、断言它的退出码与输出),不在 Stryker 的 dry-run 集里 → 它的行为在沙箱里从没被跑到 | 移出 mutate 范围;它的有效性由门禁自测的反例保证 |
 * | `drift-only` | 该文件只被**漂移门禁**(`check:drift`)观察,没有单元测试 → 同上 | 移出 mutate 范围 |
 *
 * 三类都不该记成「测试弱」。它们的量级见 `reports/mutation/diagnosis.md`。
 */

/** 一条归因。 */
export type AttributionEntry = {
  /** 归因类别。 */
  readonly kind: "string-embedded" | "spawn-only" | "drift-only";
  /** 文件 glob(仓库根相对)。支持 `*` 与 `**`。 */
  readonly pattern: string;
  /** 为什么这个文件测不到。 */
  readonly reason: string;
};

/**
 * 归因表。
 *
 * 条目只登记**机器要判**的东西:文件 glob + 类别 + 一句理由。
 * 具体的数字(多少个变异体、占多少)不在这里——它们由诊断脚本从报告里算出来,
 * 写进表就会变成第二份会过期的事实。
 */
export const ATTRIBUTION_ENTRIES: readonly AttributionEntry[] = [
  {
    kind: "string-embedded",
    pattern: "packages/engine/src/sandbox-runtime/**",
    reason:
      "runtime bundle 由 esbuild 打成 IIFE 字符串再丢进 QuickJS 跑,从不进 ES 模块图," +
      "vitest 的 per-test 覆盖拿不到属主 → 覆盖归因不了(实测 241 个变异体全 NoCoverage)。",
  },
  {
    kind: "string-embedded",
    pattern: "packages/engine/src/runner/array-search-shim.ts",
    reason:
      "同样以字符串源形式载入;它的 58 个变异体 100% 以超时收场,零信息量," +
      "已从 mutate 范围剔除。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/**/run-*-gate.ts",
    reason:
      "一次性门禁入口:真实门禁跑它、断言它的退出码与报告文本,那种观察方式是 spawn 子进程," +
      "进不了 Stryker 的 dry-run 集 → 在沙箱里从没被跑到。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/gate/budget-gate.ts",
    reason: "预算结构门禁的判定逻辑:只在 spawn 层被观察(门禁自测用反例钉它),没有单元测试。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/toolchain-coupling.ts",
    reason: "工具版本耦合断言:由 `pnpm run coupling` 跑,由门禁自测 spawn 观察,没有单元测试。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/validate/run-validate-script.ts",
    reason: "校验入口:脚本经 spawn 才被驱动,沙箱里的 dry-run 集里没有它的观察者。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/limits/**",
    reason: "单局平均墙钟上限的探针与复算:按需跑的脚本,只在 spawn 层被观察。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/cross-process/**",
    reason: "跨进程复算门禁:两进程对跑,观察方式是 spawn,进不了 dry-run 集。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/budget-recheck/**",
    reason: "预算复算门禁:带篡改开关的探针复算,按需 spawn 跑。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/selfproof/**",
    reason: "契约自证门禁:真沙箱跑 64 场对局,观察方式是 spawn。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/benchmarks/**",
    reason: "基准脚本与基准门禁:按需 spawn 跑。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/sandbox-probes/**",
    reason: "沙箱行为探针:真 VM 里跑,观察方式是 spawn。",
  },
  {
    kind: "spawn-only",
    pattern: "packages/tools/src/sandbox-runtime/**",
    reason: "runtime bundle 产物漂移门禁:与产物比对,观察方式是 spawn。",
  },
  {
    kind: "drift-only",
    pattern: "packages/tools/src/generate/**",
    reason: "生成器:只被漂移门禁 `check:drift` 观察(改真源不重跑必须红),没有单元测试。",
  },
];

/**
 * **机制级**归因:影响面无法按文件判定,只能整体声明。
 *
 * 这一条是本仓库变异测试最要紧的一条结构事实:**跨包 import 在 Stryker 沙箱里指向仓库外**
 * (`packages/<任意>/node_modules/@model-war/<任意>` 的 pnpm 相对软链经 Stryker 的 junction 落到原仓库,
 * 而工作区包的 `exports` 指向 `dist/`),于是真正的消费者路径(engine 取 replay 的 stateHash、
 * cli 走 runner 取名次)覆盖归因不了,且**丢成 NoCoverage 或 Survived 而不是「测试弱」**。
 *
 * 它不能进文件表:同一个文件里的变异体,「本包内的」可归因,「跨包的」不可归因,
 * 而报告里没有这个区分的标记。量级上它体现在各分片的 `unobservable` 桶里(能归因的部分),
 * 真正的规模要靠「修好跨包解析」才知道——那是另开 ADR 的事。
 */
export const MECHANISM_ATTRIBUTION = {
  kind: "cross-package-sandbox",
  reason:
    "跨包 import 在沙箱里指向仓库外的原仓库 dist:真正的消费者路径覆盖归因不了," +
    "且丢成 NoCoverage / Survived,不会伪装成「测试弱」——它伪装成「没测」。",
  remedy:
    "给 vitest 加 resolve.alias,把 `@model-war/*` 指到 `packages/*/src/index.ts`" +
    "(packages/tools 已是源码形态),让被测包与它的消费者在同一个模块图里。",
} as const;

/** 双星加斜杠的占位符:它匹配「零层或多层目录」。 */
const DIR_PLACEHOLDER = "\u0000DIR\u0000";

/** 双星的占位符:它匹配「任意字符(含路径分隔符)」。 */
const ANY_PLACEHOLDER = "\u0000ANY\u0000";

/**
 * 把 glob 翻成正则:支持双星、单星与问号。
 *
 * 双星加斜杠匹配零层或多层目录(形如 `a/<任意层>/b`,它同时匹配 `a/b` 与 `a/x/y/b`),
 * 双星匹配任意字符;单星匹配单层内的任意字符,不跨斜杠。
 */
export const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DIR_PLACEHOLDER)
    .replace(/\*\*/g, ANY_PLACEHOLDER)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  const body = escaped.split(DIR_PLACEHOLDER).join("(?:.*/)?").split(ANY_PLACEHOLDER).join(".*");
  return new RegExp(`^${body}$`);
};

/** 表 + 编译好的匹配器。 */
export type CompiledAttributions = {
  readonly entries: readonly AttributionEntry[];
  readonly matches: (file: string) => boolean;
  readonly reasonOf: (file: string) => string | undefined;
};

/** 把归因表编译成可用的匹配器。 */
export const compileAttributions = (
  entries: readonly AttributionEntry[] = ATTRIBUTION_ENTRIES,
): CompiledAttributions => {
  const compiled = entries.map((entry) => ({ entry, regex: globToRegExp(entry.pattern) }));
  return {
    entries,
    matches: (file) => compiled.some((c) => c.regex.test(file)),
    reasonOf: (file) => compiled.find((c) => c.regex.test(file))?.entry.reason,
  };
};
