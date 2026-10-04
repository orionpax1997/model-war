/**
 * API 面的表格区块的生产函数:注入面符号表 + 后果行 → 契约文档里那几张表。
 *
 * ── 为什么这件事是「投影」而不是「抄一遍」 ──
 *
 * 面向模型的 API 文档直接进 prompt,所以它最容易出的错不是难看得见,而是**看起来对**:
 * 签名少一个参数、某个码的触发条件写成了另一个码的情形、错误码落在「异常」而实际是「丢弃」。
 * 这些错在模型那一侧都是照着写脚本,而且写得很顺——所以它们的防线只能是机器断言,而机器断言
 * 只能对着**唯一的一份数据**做。这里那份数据是真源包的两个目录:符号表给名字、签名与触发条件,
 * 后果行给「这个码落在哪一类、这一类丢的是什么」。文档里每一个名字、每一个签名、每一个
 * 「落在哪类」都是从这两个目录渲染出来的投影,没有任何一处是第二次书写。
 *
 * ── 为什么不生成散文 ──
 *
 * 语义段、示例段、`loop()` 骨架、快照面都是散文,它们天生该手写(ADR-0004 的选项对照里
 * 「整篇生成」被否掉的理由)。生成物只覆盖**表格**:表格是「一列对一个字段」的东西,而散文是
 * 「一段话对多件事」的东西,后者搬进生产函数会让一份 Markdown 的正文分裂在两个文件之间。
 *
 * ── 为什么两个区块而不是一整块 ──
 *
 * 三张表(API 表 / 错误码表 / 常量表)读的是符号表,而「丢弃 vs 异常」对照表读的是后果行:
 * 两个真源、两句判据。分成两个区块,漂移检查的报告就能指认是哪一句判据下的那一段漂了——
 * 一整块的话,「符号表改了」与「后果改了」在报告里长得一模一样,查的人得先猜是哪半边。
 *
 * 真源都是 `.ts`,所以本件走 `@model-war/schema` 的编译产物(与前两件同一套分发机制);
 * 数值那一半不走这里,它归 `rules-value-table.ts`。
 */

import {
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
  SCRIPT_OUTCOME_BY_CODE,
  SCRIPT_OUTCOME_CATALOG,
  SCRIPT_OUTCOME_CLASSES,
} from "@model-war/schema";
import type {
  InjectedApiSymbolEntry,
  InjectedApiSymbolKind,
  ScriptOutcomeEntry,
  ScriptOutcomeKind,
} from "@model-war/schema";

import { tableCell } from "./emit.ts";
import { sectionMarker } from "./section.ts";
import type { GeneratedArtifact, Section, SectionArtifact } from "./artifact.ts";

/** 契约文档 API 面那一份的相对路径。落点与两行定界标记都按它拼。 */
const API_DOC = "docs/rules-v1/api.md";

/** 真源路径串。进生成头注释,改了它等于改了入库文档的正文,漂移检查会照出来。 */
const SYMBOL_TRUTH = "packages/schema/src/script-surface.ts";
const OUTCOME_TRUTH = "packages/schema/src/script-outcome.ts";

/**
 * 分组渲染的组序与组标题。
 *
 * 组序即符号表的书写序(查询 → 动作 → 座位自认 → 错误判别),不是另定的一次排序。四组各出一张表
 * 而不是一张四行标签的表:组标题顺带把这一组的**副作用**(只读 / 提交意图 / 只读)说了,而模型
 * 分错「查询会不会改状态」的代价是一次写错的策略,不是一次少写一行。
 */
const FUNCTION_GROUPS: readonly { readonly kind: InjectedApiSymbolKind; readonly title: string }[] =
  [
    { kind: "query", title: "**查询函数**——只读本 tick 的快照副本,不改引擎状态。" },
    { kind: "action", title: "**动作函数**——收集一条意图 + 参数界检查,不直写引擎。" },
    {
      kind: "seat",
      title: "**座位自认**——脚本唯一的「我是几号」来源,不用于判断某个 id 是不是我的。",
    },
    {
      kind: "helper",
      title: "**错误判别 helper**——把动作函数的返回值拆成可判的两步。",
    },
  ];

/** 「落在哪类」那一栏渲染的是类上的两个字,不是一个自造的枚举值。 */
const outcomeOf = (code: string): ScriptOutcomeEntry | undefined =>
  SCRIPT_OUTCOME_BY_CODE.get(code);

/** 一行表格。**行序即目录的书写序**,不另定一次排序(与键清单那条纪律同形)。 */
const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

/** 三个单元格的一行:名字、签名、一句语义。签名里的竖线必须转义。 */
const functionRow = (entry: InjectedApiSymbolEntry): string =>
  entry.kind === "error-code"
    ? // 错误码档没有签名(它不是函数),而这行不进函数表:真源侧的类型分档已经让它到不了这里,
      // 这一支只是让「渲染时忘了分档」不会悄悄渲染出一行空的签名。
      row([`\`${tableCell(entry.symbol)}\``, "—"])
    : row([
        `\`${tableCell(entry.symbol)}\``,
        `\`${tableCell(entry.signature)}\``,
        tableCell(entry.reason),
      ]);

/** 函数档三组表:一组一个标题 + 一张表。 */
const functionTables = (): string[] =>
  FUNCTION_GROUPS.flatMap((group) => {
    const entries = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter(
      (entry) => entry.kind === group.kind,
    );
    // 组空了就整组不出:一张只有表头的表会被模型读成「这一类没有 API」,而真相是那一档暂时没用。
    return entries.length === 0
      ? []
      : [
          group.title,
          "",
          row(["函数", "签名", "一句语义"]),
          row(["---", "---", "---"]),
          ...entries.map(functionRow),
          "",
        ];
  });

/**
 * 错误码表。**一码一行,不多不少**,且每一行都写出它落在哪一类。
 *
 * 「落在哪类」从 `SCRIPT_OUTCOME_BY_CODE` 取,不在这里判:码与后果的关系只有 `script-outcome.ts`
 * 一处可改,取错了方向就是第二份答案。取不到(`outcomeOf` 给不出)时非零退出而不是留一格「—」——
 * 一个码在后果表里没有落点,意味着模型读到它时无从判断要不要兜,而空格会被读成「不用管」。
 *
 * 「那一类丢的是什么」不进这一栏:同一类的七行会逐字重复同一句话,而真正要紧的差别(丢的范围与
 * 累计)只有两句,写在表前那两行里就够,完整形态在第 4 节那张对照表。
 */
const errorCodeTable = (): string[] => {
  const codes = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter((entry) => entry.kind === "error-code");
  const loss = (kind: ScriptOutcomeKind): string => tableCell(SCRIPT_OUTCOME_CLASSES[kind].loss);
  return [
    "**错误码表**——全表就下面这些,没有别的。每一行都标出它落在哪一类,而这两类的后果不同:",
    `「丢弃」= ${loss("discard")}「异常」= ${loss("exception")}`,
    "模型据此决定要不要兜。",
    "",
    row(["错误码", "一句触发条件", "落在哪类"]),
    row(["---", "---", "---"]),
    ...codes.map((entry) => {
      const outcome = outcomeOf(entry.symbol);
      if (outcome === undefined) {
        throw new Error(
          `错误码 \`${entry.symbol}\` 在 \`${OUTCOME_TRUTH}\` 的后果行里没有落点。` +
            `每一码必须恰好落在一行上——它落在哪一类只有那一个家。`,
        );
      }
      return row([
        `\`${tableCell(entry.symbol)}\``,
        tableCell(entry.reason),
        SCRIPT_OUTCOME_CLASSES[outcome.kind].label,
      ]);
    }),
    "",
  ];
};

/**
 * 常量表里归本表的那一半:**错误码字符串**。
 *
 * 类型名(`UnitType` / `IntentKind` / `ErrResult` / `Snapshot` / `Intent`)刻意**不**在这里渲染:
 * 它们擦掉类型标注后不剩运行时值,归类型面(hld §6.2),而类型面尚未落库;数值归
 * `rulesets/v1.json` 那条链,渲染在「数值常量表」一节。所以本表只出这个联合。
 *
 * 联合的成员序即符号表里错误码的书写序,不去重也不排序——排序会让「码表长什么样」取决于
 * 排序实现,而书写序是有人有意定的。
 */
const constantTable = (): string[] => {
  const codes = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter((entry) => entry.kind === "error-code");
  return [
    "**常量表**——本表只有错误码字符串这一半。类型名(`UnitType` / `IntentKind` / `ErrResult` /",
    "`Snapshot` / `Intent`)归类型面,数值归「数值常量表」一节,两者都不进本表。",
    "",
    "```ts",
    "type ErrCode =",
    ...codes.map(
      (entry, at) => `  | '${tableCell(entry.symbol)}'${at === codes.length - 1 ? ";" : ""}`,
    ),
    "```",
    "",
  ];
};

/**
 * 判别方式那一段:两步 helper 是终稿承认的唯一形态。
 *
 * 示例里的每个名字都过一道**存在性**校验(`exampleNames`):它引用的名字必须真的在符号表里、
 * 类别还对得上。改了真源里的名字而忘了改这里,生成器会非零退出并点名,而不是静默地渲染一段
 * 引用了不存在之物的示例——那段示例会被模型原样抄走,而它压根跑不起来。
 */
const exampleNames = (): void => {
  const expected: readonly { readonly symbol: string; readonly kind: InjectedApiSymbolKind }[] = [
    { symbol: "move", kind: "action" },
    { symbol: "isError", kind: "helper" },
    { symbol: "errCode", kind: "helper" },
  ];
  for (const { symbol, kind } of expected) {
    const found = SANDBOX_INJECTED_API_SYMBOL_CATALOG.find((entry) => entry.symbol === symbol);
    if (found === undefined || found.kind !== kind) {
      throw new Error(
        `判别示例引用了 \`${symbol}\`,但它在注入面符号表里不是一档 \`${kind}\` 的成员。` +
          `示例引用的名字必须与符号表同源——改名字要连示例一起改。`,
      );
    }
  }
};

const discriminationNote = (): string[] => {
  exampleNames();
  return [
    "判一次调用错没错,只有上面那两个 helper 这一条路:`isError(result)` 判有没有出错,",
    "`errCode(result)` 取回码字符串。**不要用 `typeof`、不要用真值去猜**——返回值是",
    "`void | ErrResult` 的联合,猜它的形状等于替终稿写一份判定。",
    "",
    "```ts",
    "const result = move(unitId, 0, 1);",
    "if (isError(result)) {",
    "  // 这一条意图没生效:落在哪一类、丢的是什么,见「错误码表」与第 4 节那张对照表。",
    "  const code = errCode(result); // 取回「错误码表」里的七个码之一",
    "} else {",
    "  // 这一条意图已提交;合法性终裁在结算时按同一套界检查做。",
    "}",
    "```",
    "",
    "沙箱内即时返回的码只是**反馈**:合法性终裁在结算时按同一套界检查再做一遍,所以拿到一个码",
    "也不等于这一步一定生效(同一 tick 里单位已经没了、目标已经死了,都可能让一条已提交的意图作废)。",
    "",
  ];
};

/**
 * 区块正文。这一段字节里没有任何一次第二次书写:名字、签名、触发条件来自符号表目录,
 * 「落在哪类」与「丢的是什么」来自后果行目录,组标题与那句判别说明是排版零件(措辞随排版走,
 * 不随真源走,因为它们描述的是**表怎么读**,不是哪个名字收不收)。
 */
const apiSurfaceContent = (): string =>
  [
    "> 本节三张表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从",
    `> \`${SYMBOL_TRUTH}\`(注入面符号表)与 \`${OUTCOME_TRUTH}\`(后果行)产出。`,
    "> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查",
    "> (`check:drift`)判红。",
    "",
    "**API 表**",
    "",
    ...functionTables(),
    ...errorCodeTable(),
    ...constantTable(),
    ...discriminationNote(),
  ].join("\n") + "\n";

/** 两类后果的措辞。类只有这两档,顺序由这份清单定,不由对象的键序定。 */
const OUTCOME_CLASS_ORDER: readonly ScriptOutcomeKind[] = ["discard", "exception"];

/** 对照表那一段:先给两类后果的共性措辞,再给逐行情形。 */
const outcomeTableContent = (): string =>
  [
    "> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从",
    `> \`${OUTCOME_TRUTH}\`(后果行)与 \`${SYMBOL_TRUTH}\`(错误码名)产出。`,
    "> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查",
    "> (`check:drift`)判红。",
    "",
    "**两类后果**",
    "",
    row(["类", "丢的是什么", "累计"]),
    row(["---", "---", "---"]),
    ...OUTCOME_CLASS_ORDER.map((kind) => {
      const consequence = SCRIPT_OUTCOME_CLASSES[kind];
      return row([consequence.label, tableCell(consequence.loss), tableCell(consequence.tally)]);
    }),
    "",
    "**对照表**——每一种「没生效」各占一行。`相关错误码` 一栏是按名字从后果行投影的:",
    "一个码恰好落在一行,所以上面错误码表里「落在哪类」那一栏与这里逐条一致,不会两处各写一份。",
    "",
    row(["情形", "落在哪类", "这一行的后果", "例子", "相关错误码"]),
    row(["---", "---", "---", "---", "---"]),
    ...SCRIPT_OUTCOME_CATALOG.map((entry) => {
      const consequence = SCRIPT_OUTCOME_CLASSES[entry.kind];
      return row([
        tableCell(entry.situation),
        consequence.label,
        tableCell(entry.outcome),
        tableCell(entry.example),
        // 没有码的情形不是「忘了填」:沙箱内的整 tick 判罚压根不返回码,留一格 `—` 才是对的。
        entry.codes.length === 0
          ? "—"
          : entry.codes.map((code) => `\`${tableCell(code)}\``).join("、"),
      ]);
    }),
    "",
    "一句话记法:写错参数最多丢一条,写崩 `loop()` 才丢整 tick;累计的判罚走 `exceptionTickLimit`",
    "(取值见「数值常量表」),完整的异常披露在 [`rules.md`](./rules.md) §8。",
    "",
  ].join("\n") + "\n";

const sectionOf = (id: string, content: () => string): SectionArtifact => ({
  id,
  form: "section",
  path: API_DOC,
  produce: (): Section => ({ marker: sectionMarker(id), content: content() }),
});

/** API 表 / 错误码表 / 常量表(错误码)。落点是 `docs/rules-v1/api.md` 的 API 面一节。 */
export const apiSurfaceTables: GeneratedArtifact = sectionOf(
  "api-v1-api-surface",
  apiSurfaceContent,
);

/** 「丢弃 vs 异常」对照表。同一个落点,另一个真源。 */
export const apiOutcomeTable: GeneratedArtifact = sectionOf(
  "api-v1-outcome-table",
  outcomeTableContent,
);
