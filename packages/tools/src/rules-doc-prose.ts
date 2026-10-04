/**
 * 规则文档正文的一道收窄门禁:**生成区块之外,不许出现「参数键名 + 数字」的赋值形态。**
 *
 * ── 它补的是哪一个洞 ──
 * `docs/rules-v1/rules.md` 的 §10 数值表是生成物,漂移检查逐字节比它;**区块外的散文按设计不比**
 * (逐字节锁死整份文档等于让人不敢改文档)。于是手抄一份取值进散文是一个**当前无人看守**的动作:
 * `carryLimit(=20)`、`resourcePerSite=125` 抄进去,真源改了文档不跟着改,模型照着一张过期的表
 * 写脚本,而且没有任何东西会变红。本模块是那个洞上的一道窄缝。
 *
 * ── 为什么判据是「赋值形态」而不是「正文里不许出现数字」──
 * 后者会当场误伤本该有的数字:时间轴的分段边界、移动示例的格点坐标、约束描述里的 tick 跨度与
 * 倍数关系。那些不是手抄的第二份取值,它们就是规则本身。所以判据收窄成:**键名与一个数字直接
 * 绑定**——两者之间只允许空白与 `=` `:` `为` `是` `(` 这几个连接件(或反向的 `20 = carryLimit`)。
 * 抄取值只有这一种写法,于是这道缝抓得住它;而正文照常写数字、照常改措辞,不会被它挡住。
 * 这是它敢当门禁(而不是放在注释里的建议)的唯一理由:门禁红一次就得有人回来改,判据过宽的
 * 门禁是在收罚正常改写。
 *
 * ── 键名从哪来(不在本文件另存一份)──
 * 键清单 `RULESET_KEY_CATALOG`(键名,以及四个兵种键的六个子字段)逐字从真源包取,改键名即改这道
 * 门禁;兵种子字段也从清单的 `required` 推,不另抄 `cost`/`hp`/… 这六个名字。两个派生常量的
 * **名字**是手写的——名字没法从值反推(值是真源包的常量,名字是标识符),它们进表时以标识符形态
 * 出现,所以这里也按标识符形态收。
 */

import { RULESET_KEY_CATALOG } from "@model-war/schema";

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

/**
 * 该被这道门禁盯着的名字全集:21 个键 + 兵种键的六个子字段(限定名 `worker.cost` 那种)+ 两个派生
 * 常量名。键名从键清单推,子字段从键清单的 `required` 推——两处都不在本文件里手写。
 */
export const boundParameterNames = (): readonly string[] => {
  const names: string[] = [...Object.keys(RULESET_KEY_CATALOG), ...DERIVED_CONSTANT_NAMES];
  for (const [key, entry] of Object.entries(RULESET_KEY_CATALOG)) {
    if (entry.schema.type !== "object") continue;
    // `required` 是兵种键对象的字段清单,键清单里它就是那一份;此处只把它投影成限定名。
    for (const field of entry.schema.required) names.push(`${key}.${field}`);
  }
  return names;
};

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

/**
 * 扫一份文档的正文,返回所有「键名绑着数字」的命中。
 *
 * 正向(`carryLimit(=20)`)与反向(`20 = carryLimit`)都收:两种都是抄取值的写法。
 * 名字两侧都有 `(?<![A-Za-z0-9_$])`,免得 `worker` 命中在 `meleeWorkerCost` 之类更长的标识符里
 * ——那不是键名,那只是恰好含有这两个字母。
 */
export const handCopiedValuesIn = (file: string): readonly HandCopiedValue[] => {
  const names = boundParameterNames();
  const found: HandCopiedValue[] = [];

  for (const [index, line] of proseLinesOf(file).entries()) {
    // 行内代码的反引号先摘掉:`carryLimit`(=20) 与 carryLimit(=20) 是同一处手抄。
    const bare = line.replaceAll("`", "");
    for (const name of names) {
      const escaped = escapeRegExp(name);
      const forward = new RegExp(
        String.raw`(?<![A-Za-z0-9_$])${escaped}${GAP}(\d+(?:\.\d+)?)`,
      ).exec(bare);
      const backward = new RegExp(
        String.raw`(\d+(?:\.\d+)?)[\s]*[=＝:：][\s]*(?<![A-Za-z0-9_$])${escaped}`,
      ).exec(bare);
      const matched = forward?.[0] ?? backward?.[0];
      if (matched !== undefined) {
        found.push({ key: name, fragment: matched, line: index + 1 });
      }
    }
  }
  return found;
};

/** 命中拼成一句人话,门禁的失败信息直接用它。 */
export const describeHandCopiedValue = (hit: HandCopiedValue): string =>
  `docs/rules-v1/rules.md 第 ${hit.line} 行:参数 \`${hit.key}\` 旁边绑着一个数字` +
  `(${hit.fragment.trim()})。取值只在 §10 数值表里露一次面,散文请改成按键名引` +
  `(「见 §10 数值表的 \`${hit.key}\`」)。`;
