/**
 * 规则文档散文的一道收窄门禁:**生成区块之外,不许出现「参数键名 + 数字」的绑定形态。**
 *
 * ── 它补的是哪一个洞 ──
 * `docs/rules-v2/`(与历史快照 `docs/rules-v1/`)两份契约文档各自的数值表都是生成物(§10 / §5),
 * 漂移检查逐字节比它们;
 * **区块外的散文按设计不比**(逐字节锁死整份文档等于让人不敢改文档)。于是手抄一份取值进散文
 * 是一个**当前无人看守**的动作:`carryLimit(=20)`、`resourcePerSite=125` 抄进去,真源改了文档
 * 不跟着改,模型照着一张过期的表写脚本,而且没有任何东西会变红。本模块是那个洞上的一道窄缝。
 *
 * **它扫哪些**:**四份面向模型的契约文档**(当前 active 的 `docs/rules-v2/` 与历史快照
 * `docs/rules-v1/`,四份都挂了生成区块)、设计文档与 `CONTEXT.md`(显式清单,见
 * `PROSE_SCANNED_DOCS`),外加 `benchmarks/README.md` 与**整个 `docs/adr/` 目录**(见
 * `PROSE_SCANNED_DIRS`)。**它不扫 gdd**——gdd 是规则侧的家,那里出现的参数取值绝大多数是
 * **标定环那一轮的证据口径**(「这一批 1336 场跑在 `resourcePerSite=200` 上」),删掉它们会毁掉
 * 记录的可比性纪律,而它们也不是真源的第二份(gdd 自己的表头写着取值真源在 `rulesets/*.json`)。
 *
 * ── 为什么 ADR 目录必须被扫,而不是整目录豁免 ──
 * ADR 里必然出现「旧值 → 新值」的变更记账(否则「从多少改到多少」根本表达不出来)。按文件豁免
 * (`docs/adr/` 一律不查)能一键消掉这些命中,但它是错的修法:它会把 ADR 里未来真的抄当前取值的
 * 情况一起放走。所以例外只能挂在**形态**上(箭头两侧,见下),不能挂在**位置**上——ADR 目录与
 * 别的散文面一样扫,只有变更记账的写法被放行(ADR-0008)。
 *
 * ── 为什么判据是「绑定形态」而不是「正文里不许出现数字」──
 * 后者会当场误伤本该有的数字:时间轴的分段边界、移动示例的格点坐标、约束描述里的 tick 跨度与
 * 倍数关系。那些不是手抄的第二份取值,它们就是规则本身。所以判据收窄成:**键名与一个数字直接
 * 绑定**——两者之间只允许空白与 `=` `:` `为` `是` `(` 这几个连接件(或反向的 `20 = carryLimit`)。
 * 抄取值只有这一种写法,于是这道缝抓得住它;而正文照常写数字、照常改措辞,不会被它挡住。
 * 这是它敢当门禁(而不是放在注释里的建议)的唯一理由:门禁红一次就得有人回来改,判据过宽的
 * 门禁是在收罚正常改写。
 *
 * ── 变更记账例外:数字紧邻箭头时放行 ──
 * ADR-0008 把口径写死了:禁止只针对「静态陈述当前取值」,不针对「记录变更」。变更记账必然要写出
 * 旧值与新值,它与数值表不构成漂移风险。所以命中的数字**紧邻**箭头(`→` / `->` / `←` / `<-`,
 * 允许夹空白)时放行;箭头只是同一行里别处的装饰、并不贴着这个数字时照旧算违规。
 *
 * ── 键名从哪来(不在本文件另存一份)──
 * 键清单 `RULESET_KEY_CATALOG` 住在 `packages/schema/src/ruleset-keys.ts`。本模块**读它的源码
 * 文本**抽名字,而不是 `import` 真源包:本包以源码形态由 Node 的类型擦除执行,而 `@model-war/schema`
 * 的 `exports` 指向 `dist/`——`import` 它就让这道门禁依赖一次 `tsc -b`,与「快门禁必须零构建」
 * (hld §2.2.8)不相容。抽的是**名字**不是值:名字在源码里是标识符,值才是真源。
 *
 * 抽法:对象字面量里缩进两格的 `key: {`(普通键)与 `key: unitLine(`(四个兵种键),加上兵种键
 * 六个子字段的 `required: ["cost", ...]` 那一行(投影成限定名 `worker.cost` 那种)。两个派生常量
 * 的**名字**是手写的——名字没法从值反推(值是真源包的常量,名字是标识符),它们进表时以标识符
 * 形态出现,所以这里也按标识符形态收。
 *
 * 源码文本的抽取会随真源改写而退化,所以它有一条**对照测试**:`rules-doc-prose.test.ts` 里从源码
 * 抽出的名字集合必须与测试直接 `import` 真源包得到的 `Object.keys` + 兵种子字段完全一致(测试可以
 * `import` 真源包,因为 vitest 会先跑构建)。抽取退化时那条测试先红,而不是这道门禁静默失明。
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** 一处「键名绑着数字」的命中。报告要能指认是哪一行、哪一个键。 */
export type HandCopiedValue = {
  readonly key: string;
  /** 命中片段原文(不含行号),照抄出来便于在报告里读。 */
  readonly fragment: string;
  /** 行号从 1 起;生成区块已被挖空,行号仍是原文件里的行号。 */
  readonly line: number;
};

/** 真源包里两个派生常量的**标识符名字**。它们在数值表里以公式列的形态出现,散文引的是同一个名字。 */
const DERIVED_CONSTANT_NAMES = ["SPAWN_TICKS_COEFFICIENT", "FULL_PRODUCTION_COST_RATE"] as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 键清单本体那段对象字面量的起点与终点标记。抽不到任一端 = 抽不到名字 = 门禁按空转判红。 */
const CATALOG_START = "export const RULESET_KEY_CATALOG = {";
const CATALOG_END = "\n} as const satisfies";

/** 对象字面量里缩进两格的两种键行:普通键 `  tickLimit: {`,兵种键 `  worker: unitLine(`。 */
const PLAIN_KEY_LINE = /^ {2}([A-Za-z_$][\w$]*): \{\s*$/;
const UNIT_KEY_LINE = /^ {2}([A-Za-z_$][\w$]*): unitLine\(/;

/** 兵种键六个子字段的清单:源码里 `required: ["cost", ...]` 那一行(形状定义只有一处)。 */
const REQUIRED_LINE = /required: \[([^\]]*)\]/;
const QUOTED_NAME = /"([^"]+)"/g;

/**
 * 从键清单源码文本里抽出**名字**:21 个键(含四个兵种键)+ 兵种键六个子字段的限定名。
 *
 * 纯函数,输入源码文本、输出名字数组;不读盘、不 import 真源包(理由见头注)。抽不到任何名字时
 * 返回空数组,由调用方的空转检测(`gate/vacuous.ts`)按失败处理——这里不抛错:源码形状变了是
 * 门禁失效,不是崩溃。
 */
export const keyNamesFromRulesetSource = (source: string): readonly string[] => {
  const start = source.indexOf(CATALOG_START);
  const end = start < 0 ? -1 : source.indexOf(CATALOG_END, start);
  const bodyStart = start < 0 ? -1 : source.indexOf("\n", start);
  if (start < 0 || end < 0 || bodyStart < 0) return [];

  const keys: string[] = [];
  const unitKeys: string[] = [];
  for (const line of source.slice(bodyStart + 1, end).split("\n")) {
    const plain = PLAIN_KEY_LINE.exec(line)?.[1];
    if (plain !== undefined) {
      keys.push(plain);
      continue;
    }
    const unit = UNIT_KEY_LINE.exec(line)?.[1];
    if (unit !== undefined) {
      keys.push(unit);
      unitKeys.push(unit);
    }
  }

  const required = REQUIRED_LINE.exec(source)?.[1] ?? "";
  const fields = [...required.matchAll(QUOTED_NAME)]
    .map((match) => match[1] ?? "")
    .filter((field) => field !== "");

  return [...keys, ...unitKeys.flatMap((key) => fields.map((field) => `${key}.${field}`))];
};

/**
 * 该被这道门禁盯着的名字全集:键名 + 兵种子字段的限定名(`worker.cost` 那种)+ 两个派生常量名。
 * 前两样从源码文本抽(见 `keyNamesFromRulesetSource`),派生常量名是本文件唯一手写的名字。
 */
export const boundParameterNamesFrom = (source: string): readonly string[] => [
  ...keyNamesFromRulesetSource(source),
  ...DERIVED_CONSTANT_NAMES,
];

const isMarkerLine = (line: string, kind: "begin" | "end"): boolean =>
  new RegExp(`^[\\t ]*<!-- generated:[^\\n]*:${kind} -->[\\t ]*\\r?$`).test(line);

/**
 * 挖掉全部生成区块,返回剩下的正文行。
 *
 * **挖成空行而不是删掉**:删掉会让后面所有行号平移,报告指认的行就错了。
 * **区块没闭合就抛错而不是当作正文继续**:那种文件本来就是坏的,而把它当成散文扫一遍会给出
 * 一堆与真正病因无关的命中,把报错误导到别处(定界标记本身归漂移检查管)。
 */
const proseLinesOf = (file: string): readonly string[] => {
  const lines = file.split("\n");
  const prose: string[] = [];
  let inside: string | null = null;

  for (const [index, line] of lines.entries()) {
    if (isMarkerLine(line, "begin")) {
      inside = lines[index] ?? "";
      prose.push("");
      continue;
    }
    if (isMarkerLine(line, "end")) {
      if (inside === null) {
        throw new Error(`生成区块的终点标记没有对应的起点(第 ${index + 1} 行):${line}`);
      }
      inside = null;
      prose.push("");
      continue;
    }
    if (inside !== null) {
      prose.push("");
      continue;
    }
    prose.push(line);
  }

  if (inside !== null) {
    throw new Error(`生成区块没有闭合(起点在:${inside})——区块内的数字归生成物管,不归这道门禁。`);
  }
  return prose;
};

/** 键名与数字之间允许隔的东西:空白、可选的左括号、可选的一个连接件。**没有别的**——见头注「为什么」。 */
const GAP = String.raw`[\s]*(?:[（(][\s]*)?(?:[=＝:：是为][\s]*)?`;

/** 变更记账的方向记号:正向 `旧 → 新`、反向 `新 ← 旧`。四个字形都收。 */
const ARROWS = ["→", "->", "←", "<-"] as const;

/** 数字**紧前面**(允许夹空白)是不是箭头。 */
const arrowBefore = (text: string, index: number): boolean => {
  const head = text.slice(0, index).trimEnd();
  return ARROWS.some((arrow) => head.endsWith(arrow));
};

/** 数字**紧后面**(允许夹空白)是不是箭头。 */
const arrowAfter = (text: string, index: number): boolean => {
  const rest = text.slice(index).trimStart();
  return ARROWS.some((arrow) => rest.startsWith(arrow));
};

/** 这个数字是不是变更记账的一侧(紧邻箭头)。是 → 放行,不是 → 静态陈述,违规。 */
const isAccountingNumber = (text: string, start: number, end: number): boolean =>
  arrowBefore(text, start) || arrowAfter(text, end);

const forwardPattern = (name: string): RegExp =>
  new RegExp(String.raw`(?<![A-Za-z0-9_$])${escapeRegExp(name)}${GAP}(\d+(?:\.\d+)?)`, "g");

/**
 * 反向写法(`20 = carryLimit`)。连接件除 `=` `:` 外**也收箭头**:反向的变更记账
 * (`10000 → carryLimit`)要被看见、再按箭头放行,而不是因为「正则不认箭头」变成盲区——
 * 豁免必须是显式判定,不能是漏网。
 */
const backwardPattern = (name: string): RegExp =>
  new RegExp(
    String.raw`(\d+(?:\.\d+)?)[\s]*(?:[=＝:：]|→|->|←|<-)[\s]*(?<![A-Za-z0-9_$])${escapeRegExp(name)}`,
    "g",
  );

/**
 * 一行里该键名**第一个不放行的**命中片段;没有则返回 null。
 *
 * 每个名字独立扫一遍,所以同一行里两个不同键名各自成一条命中;同一个键名出现多次时只报第一处
 * 静态陈述——报告的作用是「指一个人回来改」,不是把同一句话里的每个数字都列一遍。
 */
const firstUnaccountedHit = (text: string, name: string): string | null => {
  for (const match of text.matchAll(forwardPattern(name))) {
    const number = match[1] ?? "";
    const end = (match.index ?? 0) + match[0].length;
    if (!isAccountingNumber(text, end - number.length, end)) return match[0];
  }
  for (const match of text.matchAll(backwardPattern(name))) {
    const number = match[1] ?? "";
    const start = match.index ?? 0;
    if (!isAccountingNumber(text, start, start + number.length)) return match[0];
  }
  return null;
};

/**
 * 扫一份文档的正文,返回所有「键名绑着数字」的命中。`names` 是受管参数名全集
 * (`boundParameterNamesFrom` 从源码文本抽出来的那一份)。
 *
 * 正向(`carryLimit(=20)`)与反向(`20 = carryLimit`)都收:两种都是抄取值的写法。
 * 名字两侧都有 `(?<![A-Za-z0-9_$])`,免得 `worker` 命中在 `meleeWorkerCost` 之类更长的标识符里
 * ——那不是键名,那只是恰好含有这两个字母。数字紧邻箭头时按变更记账放行(见头注)。
 */
export const handCopiedValuesIn = (
  file: string,
  names: readonly string[],
): readonly HandCopiedValue[] => {
  const found: HandCopiedValue[] = [];

  for (const [index, line] of proseLinesOf(file).entries()) {
    // 行内代码的反引号先摘掉:`carryLimit`(=20) 与 carryLimit(=20) 是同一处手抄。
    const bare = line.replaceAll("`", "");
    for (const name of names) {
      const hit = firstUnaccountedHit(bare, name);
      if (hit !== null) found.push({ key: name, fragment: hit, line: index + 1 });
    }
  }
  return found;
};

/** 扫描集里的一件:报告里用的路径标签 + 仓库根相对路径(两者今天相同,分开是因为标签可读性优先)。 */
export type ProseScanTarget = {
  readonly label: string;
  readonly path: string;
};

/**
 * 显式清单:四份面向模型的契约文档 + 设计文档 + 词汇表 + 基准说明。
 *
 * 为什么是清单而不是「扫到谁算谁」:这几份是**模型真读的**散文面,少列一份就是少一个家;
 * 新增一份同类的散文面时,改这一处即可。
 */
export const PROSE_SCANNED_DOCS: readonly ProseScanTarget[] = [
  { label: "docs/rules-v1/rules.md", path: "docs/rules-v1/rules.md" },
  { label: "docs/rules-v1/api.md", path: "docs/rules-v1/api.md" },
  { label: "docs/rules-v2/rules.md", path: "docs/rules-v2/rules.md" },
  { label: "docs/rules-v2/api.md", path: "docs/rules-v2/api.md" },
  { label: "docs/hld.md", path: "docs/hld.md" },
  { label: "docs/vision.md", path: "docs/vision.md" },
  { label: "CONTEXT.md", path: "CONTEXT.md" },
  // 基准说明是给接手的人读的散文面,同样会「顺手抄一个取值」。它今天有一处变更记账命中
  // (v2 豁免记),靠箭头例外放行,不靠「不扫这份文件」。
  { label: "benchmarks/README.md", path: "benchmarks/README.md" },
];

/**
 * 整目录扫的散文面。**ADR 目录在这里,而不是被豁免**:理由见头注「为什么 ADR 目录必须被扫」。
 * 目录条目按路径排序展开,保证两次运行的输出可 diff。
 */
export const PROSE_SCANNED_DIRS: readonly ProseScanTarget[] = [
  { label: "docs/adr/", path: "docs/adr" },
];

/**
 * 一个目录条目里的 `*.md`,按路径排序。
 *
 * 目录不存在时返回空数组而不是抛错:那是「读到 0 份被扫文档」,处方是门禁按失败处理(空转),
 * 不是进程崩溃——崩溃会让报告看起来像工具坏了,而不是像判据失明。
 */
export const documentsInDir = (root: string, dir: ProseScanTarget): readonly ProseScanTarget[] => {
  const absolute = resolve(root, dir.path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ label: `${dir.path}/${name}`, path: `${dir.path}/${name}` }));
};

/** 展开后的扫描集:显式文件在前,目录条目按路径排序接在后面。 */
export const proseScanTargets = (root: string): readonly ProseScanTarget[] => [
  ...PROSE_SCANNED_DOCS,
  ...PROSE_SCANNED_DIRS.flatMap((dir) => documentsInDir(root, dir)),
];

/** 命中拼成一句人话,门禁的失败信息直接用它。`doc` 是被扫的那份文档的路径标签。 */
export const describeHandCopiedValue = (hit: HandCopiedValue, doc: string): string =>
  `${doc} 第 ${hit.line} 行:参数 \`${hit.key}\` 旁边绑着一个数字` +
  `(${hit.fragment.trim()})。取值只在生成的那张数值表里露一次面,散文请改成按键名引` +
  `(「见数值表的 \`${hit.key}\`」);记录变更请写成「旧值 → 新值」。`;
