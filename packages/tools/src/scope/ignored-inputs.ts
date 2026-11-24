/**
 * 「测试读的东西,必须能从入库源码重算」的判据层(纯函数:不读盘、不 spawn、不看时钟)。
 *
 * ── 它守的是什么 ──
 * `test-inputs/inputs.json` 记着每个测试文件运行时**真读过**的盘上文件。其中一部分被
 * `.gitignore` 忽略,而「忽略」本身不是判据——方向才是:
 *
 * - **派生**:由入库源码重算得到(`dist/`、`*.tsbuildinfo`、`node_modules/`、工具临时目录)。
 *   换一台机器、`pnpm install && tsc -b` 之后它就在。**允许**。
 * - **本机状态 / 产物 / 配置**:`archive/`、`reports/`、`runs/`、`models.yaml`、`season.yaml`、
 *   `.env`、`.scratch/`。它们不在任何 clone 里,也没有命令能重算出来。测试读它,结果是
 *   **作者机器上绿、别人机器上少一块事实**,而少一块事实的那一次也是绿的。
 *
 * 所以判据不是「忽略即禁」,而是:**被忽略 ∧ 不属于任何派生前缀 ⇒ 必须被登记**。
 *
 * ── 白名单自己也要被断言 ──
 * 前缀表只收派生类。它有三件事必须成立,否则「白名单」会变成一条把门悄悄撑开的通道:
 *
 * 1. **不是空的**(空表 = 每条命中都红,那是另一种形状,见 `DERIVED_RULES` 的断言);
 * 2. **每条都真的还会被 git 忽略**(`probe` 过一遍 `git check-ignore`,规则随 `.gitignore`
 *    一起腐烂时这里先红——不然白名单会开始替一个已经入库的路径开豁免);
 * 3. **不能吞掉本机状态类**:`LOCAL_STATE_PROBES` 里每一条都必须被判成「非派生」。把 `archive`
 *    塞进前缀表,`swallowedLocalState` 立刻点名,而不是让本机状态从旁边走过去。
 *
 * ── 登记表的口径 ──
 * `test-inputs/ignored-inputs.json` 每条形如「测试文件:行号 ← 忽略路径 + 为什么只能这样」。
 * 三条同时成立才算数:
 *
 * 1. **定位得到**:那一行真的写着这条路径**末段**的字面量(带引号)。行号漂了、代码删了
 *    = 幽灵条目 → 红。
 * 2. **还用得上**:那条登记必须真的覆盖 map 里的一条命中。命中没了 = 过期豁免 → 红
 *    (过期豁免比没有更坏:它继续允许那个测试文件读那一类路径,而没人会再看它)。
 * 3. **说了为什么**:空理由等于没登记 → 红。
 *
 * 空登记表**不是**全过:没有任何条目时,每一条命中都自己红(见
 * `ignored-inputs.test.ts` 里那条「空清单不许当全过」)。
 *
 * ── 测试自己造的产物为什么不用登记 ──
 * `reports/`、`runs/`、`.scratch/` 这些**落点**(测试写它们、报告落它们)在录制层就被
 * `classifyInput` 排除了(`test-inputs.ts` 的 `OUTPUT_ROOTS`);派生形状(`node_modules/`、
 * `*.tsbuildinfo`、`.vitest/`、`.stryker-tmp/`,以及背后没有源码的 `dist/` 产物)同样排除——
 * 两者用**同一张派生形状表**,就是本文件的 `DERIVED_RULES`(`observation` 字段说明观测口径
 * 拿它怎么办)。它们在 map 里根本不出现,所以本门禁看不见它们,也就不需要豁免。
 *
 * ── 已知盲区:未 hook ≠ 没读 ──
 * 判据的输入是观测 map,map 的盲区一处都不假装没有:
 *
 * - **子进程内部读盘**:`git` / `tsc` / `depcruise` / `pnpm` / `bwrap` 这类非 node 执行体,
 *   recorder 进不去;能记下的只有「spawn 了哪个脚本」。
 * - **只探不读**:`existsSync` / `readdirSync` / `stat` 不在 hook 内(记它们会把「探了一下这个
 *   目录」写成「依赖这个目录」)。于是 `skipIf(existsSync(...))` 这类前置判断可能整条不在
 *   map 里——而它探的往往正是本机状态。
 * - **人先手工摆现场**:`node_modules/.bin/*`、`stryker/baseline/` 这类「先装好、先跑一次」
 *   才有东西可读的依赖。
 *
 * 一句话:这道门禁保证的是「map 说出来的东西里没有一条是本机状态」,不是「map 说全了」。
 * 后半句是 recorder 与 `observe:inputs` 的活(ADR-0038 第三条),不在这里重复一遍。
 */

import type { InputsMap } from "./test-inputs.ts";

/** 一条派生前缀。`segment` 看路径的任意一层,`suffix` 看结尾(产物文件就这两个形状)。 */
export type DerivedRule = {
  readonly kind: "segment" | "suffix";
  /** 目录名(不含 `/`)或文件后缀(含 `.`)。 */
  readonly value: string;
  /**
   * 断言「这条规则还真的会被 git 忽略」用的探针路径。**不落在仓库里、也不入库**:
   * 它只过一遍 `git check-ignore`,证明这条路今天仍然被忽略。
   */
  readonly probe: string;
  /** 为什么它算「能从入库源码重算」。 */
  readonly why: string;
  /**
   * **观测口径**(`test-inputs.ts` 的 `classifyInput`)拿这条形状怎么办。
   *
   * “派生”与“不是输入”不是同一件事,二者在这张表里分开声明:
   *
   * - `"excluded"`:它只说明「这台机器装过 / 跑过」,选择器对它没有下一跳,
   *   记进输入 map 只会把机器状态写成依赖。
   * - `"source-backed"`:它 **是源码的产物**。有源码在背后时它就是那个源码文件的下一跳,
   *   **算输入**(改那个源码,得能顺着产物找到读它的测试);背后没有源码时,它只能是
   *   打包器额外塞进来的东西(标准链 `tsc -b` 不产出它),丢掉。
   *
   * 写在这张表里而不写在 `test-inputs.ts` 里,是翻工之后的结论:口径散成两份时,一边加了一种
   * 形状、另一边还是旧样子,map 会静默变窄。派生形状只有**这一处**真源。
   */
  readonly observation: "excluded" | "source-backed";
};

/**
 * 派生类:允许被测试读到。
 *
 * 每一条都回答同一个问题:**删掉它、在一台干净机器上跑 `pnpm install && tsc -b`,它回不回来?**
 * 回得来才在这里。`reports/` / `archive/` 这类回不来的,一条都不许进来(下一条清单盯着这件事)。
 *
 * `coverage/` 不在这里:这个仓库里没有任何工具往它落东西、`.gitignore` 也没忽略它。往里加一条
 * 形状要能过 `probe`(下面第三条断言要求探针真的被 `git check-ignore` 命中),而一条不存在
 * 的形状只能靠伪造探针混进来——那正是白名单变宽的输法。
 */
export const DERIVED_RULES: readonly DerivedRule[] = [
  {
    kind: "segment",
    value: "node_modules",
    probe: "model-war-probe-nm/node_modules/probe/index.js",
    why: "依赖树:由 pnpm-lock.yaml 重算",
    observation: "excluded",
  },
  {
    kind: "segment",
    value: "dist",
    probe: "packages/model-war-probe/dist/index.js",
    why: "tsc -b 的产物:由入库源码重算(有源码在背后才算输入)",
    observation: "source-backed",
  },
  {
    kind: "suffix",
    value: ".tsbuildinfo",
    probe: "packages/model-war-probe/tsconfig.tsbuildinfo",
    why: "tsc -b 的增量状态:删掉只会变慢,不影响结果",
    observation: "excluded",
  },
  {
    kind: "segment",
    value: ".vitest",
    probe: ".vitest/probe.json",
    why: "vitest 的缓存与报告落点:每次运行现造",
    observation: "excluded",
  },
  {
    kind: "segment",
    value: ".stryker-tmp",
    probe: ".stryker-tmp/probe/index.js",
    why: "变异测试的沙箱副本:由 mutate:* 现造",
    observation: "excluded",
  },
];

/**
 * 本机状态 / 产物 / 配置的探针:**一条都不许被 `DERIVED_RULES` 判成派生**。
 *
 * 取的都是 `.gitignore` 里那几条与「这台机器」绑定的路径(与 `version-control-boundary.test.ts`
 * 同一份名单的精神)。它们的存在只为反方向断言:白名单一旦变宽到这里,`swallowedLocalState`
 * 会点名,而不是让本机状态从旁边走过去。
 */
export const LOCAL_STATE_PROBES: readonly string[] = [
  "archive/claude-opus-5-5/2026-10-16T08-40-12-578Z/script.js",
  "archive/claude-opus-5-5/meta.json",
  "reports/mutation/mutation.json",
  "runs/2026-10-16/replay.jsonl",
  ".scratch/spec.md",
  "models.yaml",
  "season.yaml",
  ".env",
  ".pi/subagents-lite.json",
];

/** 一条规则是否命中某个路径。 */
export const matchesDerivedRule = (rule: DerivedRule, path: string): boolean =>
  rule.kind === "segment"
    ? path.split("/").includes(rule.value)
    : path.endsWith(rule.value) && path.length > rule.value.length;

/** 这个路径是否属于「能从入库源码重算」的那一类。 */
export const isDerived = (path: string): boolean =>
  DERIVED_RULES.some((rule) => matchesDerivedRule(rule, path));

/**
 * 白名单吞掉了哪些本机状态探针。空数组 = 白名单还没变宽。
 *
 * 输入是规则表本身(而不是直接读 `DERIVED_RULES`),这样「把 `archive` 塞进去 → 红」这条
 * 反方向断言不必改真实源码:喂一份加了 `archive` 的表就演得出来。
 */
export const swallowedLocalState = (rules: readonly DerivedRule[]): readonly string[] =>
  LOCAL_STATE_PROBES.filter((probe) => rules.some((rule) => matchesDerivedRule(rule, probe)));

/** 登记表在仓库里的落点。与 `test-inputs/inputs.json` 同住:两份都是入库的判据数据。 */
export const REGISTRY_PATH = "test-inputs/ignored-inputs.json";

/** 登记表的一条:测试文件 + 行号 ← 忽略路径 + 为什么只能这样。 */
export type RegistryEntry = {
  /** 仓库根相对的测试文件路径(与 map 的键同一口径)。 */
  readonly test: string;
  /** 1 起的行号:那一行里必须写着 `path` 的末段字面量。 */
  readonly line: number;
  /** 被忽略的路径,按**前缀**匹配(条目 `archive/a` 覆盖 `archive/a/b.js`,不覆盖 `archive/ab.js`)。 */
  readonly path: string;
  /** 为什么只能这样。空串 = 没登记。 */
  readonly reason: string;
};

/** 一条观测到的命中:哪个测试文件读到了哪条被忽略的路径。 */
export type Hit = {
  readonly test: string;
  readonly path: string;
};

/** 登记表的三种坏法。 */
export type RegistryProblemKind = "ghost" | "stale" | "no-reason";

export type RegistryProblem = {
  readonly kind: RegistryProblemKind;
  readonly entry: RegistryEntry;
  /** 一句人话,直接进红消息。 */
  readonly detail: string;
};

export type Judgment = {
  /** 命中里没有任何登记覆盖的那些(门禁要点名的就是它们)。 */
  readonly uncovered: readonly Hit[];
  readonly problems: readonly RegistryProblem[];
};

/**
 * 一条登记是否覆盖一条命中:同一测试文件,且命中落在条目的前缀下。
 *
 * 前缀比较带 `/`:否则 `archive/a` 会把 `archive/ab/c.js` 也算成覆盖——白名单最经典的漏法。
 * 空前缀一律不覆盖任何东西:空串当前缀等于「这个文件的忽略输入全放行」,那是一条登记就拆掉了整道门。
 */
export const covers = (entry: RegistryEntry, hit: Hit): boolean => {
  const prefix = entry.path.replace(/\/+$/, "");
  if (prefix === "" || entry.test !== hit.test) return false;
  return hit.path === prefix || hit.path.startsWith(`${prefix}/`);
};

/** 路径的末段(`archive/a/b.js` → `b.js`);空串表示这条路径没法定位。 */
const lastSegment = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment !== "")
    .at(-1) ?? "";

/**
 * 这一行里是否写着这个路径的末段字面量。
 *
 * 只认带引号的出现:注释里提一句不算定位,`join("archive", "x")` 这种拆行写法与
 * `"archive/x/meta.json"` 这种整串写法都算。末段而不是整条路径,是因为 `join()` 拆行之后
 * 一行里放不下整条——条目登记的锚点因此是「那一行确实在说这件事」,不是「那一行逐字复制路径」。
 */
export const mentionsPathEnd = (line: string, path: string): boolean => {
  const last = lastSegment(path);
  if (last === "") return false;
  return ['"', "'", "`"].some(
    (quote) =>
      line.includes(`${quote}${last}${quote}`) ||
      line.includes(`${quote}${last}/`) ||
      line.includes(`/${last}${quote}`),
  );
};

/** 判据:`uncovered` 非空或 `problems` 非空 ⇔ 红。 */
export const judgeIgnoredInputs = (input: {
  readonly hits: readonly Hit[];
  readonly registry: readonly RegistryEntry[];
  /** 取源文件第 `line` 行(1 起);文件不在、行号越界 → `undefined`。注入着,纯函数才测得了幽灵。 */
  readonly sourceLine: (file: string, line: number) => string | undefined;
}): Judgment => {
  const uncovered = input.hits.filter((hit) => !input.registry.some((entry) => covers(entry, hit)));
  const problems: RegistryProblem[] = [];
  for (const entry of input.registry) {
    const line = input.sourceLine(entry.test, entry.line);
    if (line === undefined) {
      problems.push({
        kind: "ghost",
        entry,
        detail: `第 ${String(entry.line)} 行读不到(文件不在,或行号越界)`,
      });
    } else if (!mentionsPathEnd(line, entry.path)) {
      problems.push({
        kind: "ghost",
        entry,
        detail: `第 ${String(entry.line)} 行里没有 \`${lastSegment(entry.path)}\` 这个字面量(代码改了?行号漂了?)`,
      });
    }
    if (entry.reason.trim() === "") {
      problems.push({
        kind: "no-reason",
        entry,
        detail: "理由空着。空理由等于没登记:下一个人读不出「为什么这里只能这样」",
      });
    }
    if (!input.hits.some((hit) => covers(entry, hit))) {
      problems.push({
        kind: "stale",
        entry,
        detail: "map 里没有它覆盖的忽略输入了。这条豁免已经过期,删掉它(留着就是继续允许读)",
      });
    }
  }
  return { uncovered, problems };
};

/** map → 全部命中(测试文件 × 它读到的路径)。门禁再按「被忽略」与「派生」筛。 */
export const observedInputs = (map: InputsMap): readonly Hit[] =>
  Object.entries(map.files)
    .flatMap(([test, inputs]) => inputs.map((path) => ({ test, path })))
    .sort((left, right) =>
      left.test === right.test
        ? left.path.localeCompare(right.path)
        : left.test.localeCompare(right.test),
    );

/** 登记表文件的落盘形状:`version` 留给将来加字段时判读,不是判据。 */
export type RegistryFile = {
  readonly version: number;
  readonly entries: readonly RegistryEntry[];
};

/** 本文件声明的 schema 号(与 `REGISTRY_PATH` 里的 `version` 比对,不是判据,只是自证)。 */
export const REGISTRY_SCHEMA = 1;
