/**
 * 数值表区块的生产函数:规则集取值文件 + 键清单 → 两份契约文档里各自那一段数值表。
 *
 * ── 为什么是「一份内容、两件生成物」 ──
 *
 * 同一批数字要露在两份文档里:`docs/rules-v1/rules.md`(机制与结算)与 `docs/rules-v1/api.md`
 * (脚本 API)各自都要让模型看到它。两份各自维护就是两份手抄,而这张表是全部数字唯一的对外
 * 露面——分叉的后果不是文档难看,是模型照着一张过期的表设计脚本。
 * 所以本文件**只产出一段字节**,两件生成物(`rules-v1-value-table` 与 `api-v1-value-table`)
 * 交付它的同一份内容,差别只在落点与两行定界标记。同理,两份文档的散文一律**引表不抄值**:
 * 散文提到某个键时只写键名与机制,数字留在表里。
 *
 * ── 真源是两份,合起来才够渲染一张表 ──
 *
 * - **取值**在 `rulesets/v1.json`(取值真源,AGENTS.md 定的那一处);
 * - **键序、量纲、标定状态与一句说明**在 `packages/schema/src/ruleset-keys.ts`(键清单)。
 *
 * 键清单给不了值,取值文件给不了「这个键是什么、是不是未定」;两边缺一头,表就残一列。
 *
 * ── 为什么生产函数读盘 ──
 *
 * 漂移检查的①判定是「真源现在会产出的东西」对「工作树里那一段」。检查与生成器共用本函数,
 * 所以读盘正是这条判定成立的前提:**改了取值不重跑生成器,检查当场读到的是新值、文档里是旧值,
 * 判红**。不读盘的话这条判定只剩「文档被手改」那一半,而本票另一半(改真源即改文档)就没有
 * 机器保证。既有两件生成物的真源是 `.ts`,因此走 `@model-war/schema` 的编译产物;本件的真源
 * 是数据文件,直接读。分界线是**真源是代码还是数据**,不是「读不读盘」。
 *
 * 读出来的形状由本文件自己收:取值文件少一个键、某个兵种键写成了整数,都在这里非零退出,
 * 而不是渲染出一张缺格的表(那比没有表更坏)。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FULL_PRODUCTION_COST_RATE,
  MEMORY_SOFT_THRESHOLD_RATIO,
  RULESET_KEYS,
  RULESET_KEY_CATALOG,
  RULESET_UNIT_KEYS,
  SPAWN_TICKS_COEFFICIENT,
} from "@model-war/schema";
import type { Ruleset, RulesetKey, UnitStats } from "@model-war/schema";

import { sectionMarker } from "./section.ts";
import type { GeneratedArtifact, Section, SectionArtifact } from "./artifact.ts";

/** 取值文件。仓库根起的相对串,与生成物落点的 `path` 同一记法。 */
const TRUTH_RELATIVE_PATH = "rulesets/v1.json";

/** 取值文件的绝对路径。从本文件的位置上溯到仓库根(同生成器与漂移门禁两个入口的算法)。 */
const TRUTH_PATH = resolve(import.meta.dirname, "../../../..", TRUTH_RELATIVE_PATH);

/**
 * 「未定」这个渲染词。
 *
 * 它是 CONTEXT.md《未定值》词条的措辞:该词只认「机制已定、终值交给后续的图」这一种情形,
 * 不表示「字段暂缺」或「还没想好」。判据是键身上的 `calibration.state`,所以这个词写在生产
 * 函数里(文档渲染的家在这里),而**判据**不写进正文——它在键清单的注释里,抄一份进文档就会漂移。
 */
const UNDETERMINED_LABEL = "未定";

/**
 * 兵种属性的六个字段,连同它们在表里那一列的名字。
 *
 * **这份清单在本文件里只有一个家**:表头、取值与形状校验三处都从它推,所以「多一列少一列」
 * 与「少校验一个字段」不可能各自发生。它与键清单里那份 `unit-stats` schema 同名的核对不归这里:
 * 那是装载期断言的活(`apps/cli` 的派生量断言逐条比对)。
 */
const UNIT_STAT_COLUMNS: readonly { readonly field: keyof UnitStats; readonly label: string }[] = [
  { field: "cost", label: "造价" },
  { field: "hp", label: "生命" },
  { field: "damage", label: "伤害" },
  { field: "range", label: "射程" },
  { field: "speed", label: "速度" },
  { field: "spawnTicks", label: "生产耗时" },
];

/**
 * 读取值文件并收成 `Ruleset` 形状。
 *
 * `JSON.parse` 的返回类型是 `any`,这里**一次**断言到真源包自己的对偶类型(不是手抄的结构),
 * 之后所有取值都经下面的取值口读,形状不对当场抛。断言只在边界上有一处:收窄散在几处等于让
 * 每一处都可疑,而这里唯一可能出错的地方就是「这个文件不是规则集文件」。
 */
const readTruth = (): Ruleset => {
  const parsed: unknown = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const truth = parsed as Partial<Ruleset>;
  for (const key of RULESET_KEYS) {
    // 缺键与取 `0` 是两件不同的事(键清单头注),所以这里报「缺」而不是渲染出一格空白。
    if (truth[key] === undefined) {
      throw new Error(`取值文件 ${TRUTH_PATH} 缺键 \`${key}\`。`);
    }
  }
  return truth as Ruleset;
};

/** 一个整数值键的取值。形状不对当场抛,不把 `undefined` 渲染成表里的一格。 */
const integerOf = (truth: Ruleset, key: RulesetKey): number => {
  const value = truth[key];
  if (typeof value !== "number") {
    throw new Error(`取值文件 ${TRUTH_PATH} 里 \`${key}\` 不是整数(键清单说它是整数值键)。`);
  }
  return value;
};

/** 一个兵种键的六项属性。六字段逐个校验,少一个或类型不对都在这里抛。 */
const unitStatsOf = (truth: Ruleset, key: RulesetKey): UnitStats => {
  const value = truth[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`取值文件 ${TRUTH_PATH} 里 \`${key}\` 不是兵种属性对象。`);
  }
  const stats: Partial<UnitStats> = value;
  for (const { field } of UNIT_STAT_COLUMNS) {
    if (typeof stats[field] !== "number") {
      throw new Error(
        `取值文件 ${TRUTH_PATH} 里 \`${key}\` 的 \`${field}\` 不是整数` +
          `(兵种属性六字段全是整数值键)。`,
      );
    }
  }
  return stats as UnitStats;
};

/**
 * 生产耗时:按公式现算,不抄取值文件里双存的那一份。
 *
 * 双存(键里存一份、公式算一份)是键清单的设计,装载期由 `apps/cli` 的派生量断言判两者相等;
 * 本函数只负责**渲染公式算出来的那个**,这样表里这一列与式子永不脱钩。两者不等时这里非零退出,
 * 而不是渲染一个与式子对不上的数——取值文件坏了就改到自洽为止。
 */
const spawnTicksOf = (key: RulesetKey, stats: UnitStats): number => {
  const derived = Math.ceil(stats.cost * SPAWN_TICKS_COEFFICIENT);
  if (stats.spawnTicks !== derived) {
    throw new Error(
      `取值文件 ${TRUTH_PATH} 里 \`${key}\` 的 \`spawnTicks\` 与 ` +
        `⌈cost × SPAWN_TICKS_COEFFICIENT⌉ 对不上(文件 ${stats.spawnTicks},公式 ${derived})。`,
    );
  }
  return derived;
};

/**
 * 表格单元。竖线要转义,否则一条带竖线的说明会把整张表拆成两列;换行不可能出现
 * (说明是键清单里的单行常量),所以不必处理它。
 */
const cell = (text: string): string => text.replaceAll("|", "\\|");

/** 参数取值表。行序即键清单的键序,不另定一处(键清单头注就是这么定的)。 */
const parameterTable = (truth: Ruleset): string[] => [
  "| 键 | 值 | 量纲 | 说明 |",
  "| --- | --- | --- | --- |",
  ...RULESET_KEYS.filter((key) => RULESET_KEY_CATALOG[key].valueType === "integer").map((key) => {
    const entry = RULESET_KEY_CATALOG[key];
    // **判据是 `calibration.state`,不是「值是不是 0」**:`worker.damage` 就是真的 0,
    // 写成 `value === 0` 会把「未定」与「一个真的 0」混成一件(CONTEXT.md《未定值》)。
    const shown =
      entry.calibration.state === "undetermined" ? UNDETERMINED_LABEL : `${integerOf(truth, key)}`;
    return `| \`${key}\` | ${shown} | ${entry.unit} | ${cell(entry.description)} |`;
  }),
];

/** 兵种表:四条兵种线的六项属性取自四个兵种键,生产耗时一列现算。 */
const unitTable = (truth: Ruleset): string[] => {
  const header = UNIT_STAT_COLUMNS.map((column) => column.label).join(" | ");
  const separator = UNIT_STAT_COLUMNS.map(() => "---").join(" | ");
  return [
    `| 兵种 | ${header} | 说明 |`,
    `| --- | ${separator} | --- |`,
    ...RULESET_UNIT_KEYS.map((key) => {
      const stats = unitStatsOf(truth, key);
      const columns = UNIT_STAT_COLUMNS.map((column) =>
        column.field === "spawnTicks" ? `${spawnTicksOf(key, stats)}` : `${stats[column.field]}`,
      );
      return `| \`${key}\` | ${columns.join(" | ")} | ${cell(RULESET_KEY_CATALOG[key].description)} |`;
    }),
  ];
};

/**
 * 派生量表:**入表不入键清单**。
 *
 * 这一节存在的理由是「推导展示项」有两种相反的失败:漏掉它,模型看不到软阈这条线;
 * 把它塞进取值文件,则多一个能填错、且没有任何第二个数会对的格子(键清单头注)。
 * 取值取自真源包的派生常量,系数与真值都不在这份文档里另抄。
 */
const derivedTable = (truth: Ruleset): string[] => [
  "| 派生量 | 公式 | 值 |",
  "| --- | --- | --- |",
  // 软阈跟着它依赖的那个键走:那个键还是未定值时软阈也渲染成「未定」,
  // 而不是把系数乘未定值占位算出一个看着像真的 0。
  `| 内存软阈 | \`MEMORY_SOFT_THRESHOLD_RATIO × memoryTickCeiling\` | ${
    RULESET_KEY_CATALOG.memoryTickCeiling.calibration.state === "undetermined"
      ? UNDETERMINED_LABEL
      : `${Math.floor(MEMORY_SOFT_THRESHOLD_RATIO * integerOf(truth, "memoryTickCeiling"))}`
  } |`,
  `| 单基地满产烧钱率 | \`FULL_PRODUCTION_COST_RATE\` | ${FULL_PRODUCTION_COST_RATE} |`,
];

/**
 * 区块正文。**这一段字节是两份文档里那张表的唯一来源**:两份文档各挂一份,内容逐字节相同。
 * 生成头的写法对齐 `emit.ts` 那三件套(勿手改 / 真源在哪 / 为什么规则层读的是生成物),
 * 只是载体从 `.ts` 换成 markdown:区块形态的正文就在这两行定界标记之间。
 */
const valueTableContent = (): string => {
  const truth = readTruth();
  return (
    [
      "> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/rules-value-table.ts` 从",
      `> \`${TRUTH_RELATIVE_PATH}\` 与 \`packages/schema/src/ruleset-keys.ts\`(键清单)产出。`,
      "> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查",
      "> (`check:drift`)判红。",
      "",
      "**参数取值**",
      "",
      ...parameterTable(truth),
      "",
      "**兵种属性**",
      "",
      ...unitTable(truth),
      "",
      "生产耗时一列按 `⌈造价 × SPAWN_TICKS_COEFFICIENT⌉` **现算**,不是抄进表的第二份取值。",
      "",
      "**派生量(入表,不入键清单)**",
      "",
      ...derivedTable(truth),
    ].join("\n") + "\n"
  );
};

const sectionOf = (id: string, path: string): SectionArtifact => ({
  id,
  form: "section",
  path,
  produce: (): Section => ({ marker: sectionMarker(id), content: valueTableContent() }),
});

/** 机制文档里的那张数值表。落点是 `docs/rules-v1/rules.md` §10。 */
export const rulesValueTable: GeneratedArtifact = sectionOf(
  "rules-v1-value-table",
  "docs/rules-v1/rules.md",
);

/** API 文档里的那张数值常量表。**与上面那份逐字节相同**,出自同一个生产函数。 */
export const apiValueTable: GeneratedArtifact = sectionOf(
  "api-v1-value-table",
  "docs/rules-v1/api.md",
);
