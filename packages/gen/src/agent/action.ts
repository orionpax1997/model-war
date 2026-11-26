/**
 * 动作的**严格解析**:这一步恰好一次工具调用,工具名在声明的集合里,`arguments` 是合法 JSON 且
 * 符合那个工具的参数形状(修订「一步一次调用」)。
 *
 * ── 为什么严格到「零次 / 多次 / 名字不认识 / 参数坏了都不执行」 ──
 *
 * 放宽到「抽第一次调用」能省一步,代价是模型以为自己把两个动作都做了,然后基于那个错误的世界观
 * 继续推理——那是最难诊断的一类失败。宁可浪费一步,也不要在错误的前提上继续。
 *
 * 「一步恰好一次」这条判据不是排版偏好:一步两次调用会立刻引出「同一块里先写文件后 evaluate,
 * 评的是哪一版」——那是把「候选与步号的单向引用」打穿。所以多次调用归**拒绝档**,
 * 而不是「挑一次执行」。
 *
 * ── `arguments` 的解析归本层,不归传输层 ──
 *
 * 传输层原样交出 `argumentsJson` 字符串(渠道给的那串字节)。在这里解析,是因为
 * `malformed-arguments` 是一条**模型可自我修正的格式失败**:计一步、回纠正消息、连续三次才停。
 * 放进传输层它就变成了端点错误——那会把「模型手滑」升级成「整场会话失败」,而前者正是模型能
 * 自己修好的那类。
 *
 * ── 纠正消息带逐字正例与逐字反例 ──
 *
 * 只写一句「一步恰好一次调用」时,一个不服从的席位三次都不改;而「它没懂」与「它懂了但不照做」
 * 无法区分。逐字反例把被拒的**那一处**指出来,于是下一次要么改对、要么留下「指到脸上仍不改」
 * 这条可读的证据。
 *
 * ── 本模块不碰 IO、不碰时钟、不拼历史 ──
 *
 * 纯 `ToolCall[]` 进、纯结论出,所以「零次调用怎么办」可以被单测逐字钉住,而 loop 只消费结论。
 */

import type { ArchiveStepRejectReason } from "@model-war/schema";

import { TOOL_NAMES, acceptsArgumentsOf, type ToolCall, type ToolName } from "./tools.js";

/**
 * 「这一步没有动作可执行」的退出码。
 *
 * 借 `EX_USAGE`(64):它是「命令用法不对」,与沙箱执行自己的非零退出分得开。拒绝档与响应被截断
 * 转格式反馈共用它——两者都是「模型这一步没写出可执行的动作」。
 *
 * 它是**运行期**的事实(那一步的 `exitCode`),不是身份清单里的协议常量:新协议下拒绝是回给模型
 * 的一条观测,不是薄壳的退出码。
 */
export const ACTION_REJECT_EXIT_CODE = 64;

/**
 * 被拒的形状族:**零次调用**、**多于一次调用**、**工具名不在声明集合里**、**`arguments` 不是
 * 合法 JSON 或形状不符**。
 *
 * 它是身份清单里 `actionSyntax.rejects` 的唯一真源(清单不另抄一份),也是纠正消息逐字反例的
 * 索引:每一种都有它自己的那一条反例。
 */
export const ACTION_REJECT_REASONS = [
  "no-tool-call",
  "multiple-tool-calls",
  "unknown-tool",
  "malformed-arguments",
] as const;

export type ActionRejectReason = (typeof ACTION_REJECT_REASONS)[number];

/**
 * 档案形状那一侧的值域是 `@model-war/schema` 的 `ARCHIVE_STEP_REJECT_REASONS`：本包这一份是**真源**，
 * 它那一份是归档契约的需求（schema 不能 import gen，依赖方向是 gen → schema）。
 *
 * 于是「同一组名字写两遍」成了必须付的账，而下面这条类型级断言就是不让它漂的那根钉子：任一侧多
 * 一个、少一个、改一个字母，`tsc -b` 就非零退出。它比「两边注释里都写一句请保持一致」硬，也比
 * 运行期对表省——这组名字是编译期常量，没有一份能在运行期不对。
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ArchiveRejectReasonsMatchAction = Assert<
  MutuallyAssignable<ActionRejectReason, ArchiveStepRejectReason>
>;

/** 一条回复的解析结论。 */
export type ActionParse =
  | {
      readonly kind: "ok";
      /** 这一次调用的是哪个工具(必是声明集合里的五个之一)。 */
      readonly tool: ToolName;
      /**
       * 渠道给的 `arguments` **原文**:原样落档、不重编码(`steps[i].toolCall.argumentsJson`)。
       * 发回历史时用的就是这串字节,所以「发回去的 == 落盘的」在工具调用轮次里重新成立。
       */
      readonly argumentsJson: string;
      /**
       * `bash` 的那条命令串(`JSON.parse(argumentsJson).command`),是**派生值**。
       *
       * 其余四个工具没有这一格:它们做什么由「当前的 `/workspace/script.ts`」唯一决定,命令行
       * 没有可填的东西。
       */
      readonly command?: string;
    }
  | {
      readonly kind: "reject";
      readonly reason: ActionRejectReason;
      /** 回给模型的纠正消息,与 `prompts/agent-system.md` 里那份协议呼应。 */
      readonly correction: string;
    };

/** `arguments` 的形状判据的结论:要么通过(带 `bash` 的命令串),要么是 `malformed-arguments`。 */
type ArgumentsVerdict =
  | { readonly kind: "ok"; readonly command?: string }
  | { readonly kind: "bad" };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 一次调用的 `arguments` 是否符合该工具的参数声明。
 *
 * 三条判据与 `tools.ts` 的声明同源(`acceptsArgumentsOf` 回答「收不收参数」):
 * - `bash` 收 `{command}`,且 `command` 是**长度 > 0** 的字符串,不许多余键(声明里
 *   `additionalProperties: false`);
 * - 其余四个**不收参数**:对象必须为空。空串(`""` / 空白)按「没有参数」读——不少渠道对不收
 *   参数的工具给的就是空串,而把它判成坏 JSON 会把一条合法调用拒掉;
 * - 形状不符与 JSON 坏掉归**同一档**:对模型来说处方相同(照着声明重写一次),而分成两档只会
 *   让纠正消息多一条分支、少一条被真实覆盖的反例。
 */
const argumentsOf = (tool: ToolName, argumentsJson: string): ArgumentsVerdict => {
  const trimmed = argumentsJson.trim();
  let parsed: unknown;
  if (trimmed === "") {
    // 空串不是「合法 JSON」,但对不收参数的工具它是「没有参数」的常见写法。
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: "bad" };
    }
  }
  if (!isObject(parsed)) return { kind: "bad" };
  const keys = Object.keys(parsed);
  if (!acceptsArgumentsOf(tool)) return keys.length === 0 ? { kind: "ok" } : { kind: "bad" };
  const command = parsed["command"];
  if (keys.length !== 1 || typeof command !== "string" || command.length === 0)
    return { kind: "bad" };
  return { kind: "ok", command };
};

/**
 * 逐字正例:模型下一步照这个形状调用就对了,不需要理解「恰好一次」是什么意思。
 *
 * 四条各一个工具(`bash` / `check` / `evaluate` / `finish`):前两条覆盖「带参数」与「不带参数」
 * 两种形状,后两条是这一步真正会走到的两个收尾动作。
 */
const POSITIVE_EXAMPLES = [
  `bash {"command": "ls /workspace"}`,
  `check {}`,
  `evaluate {}`,
  `finish {}`,
];

/**
 * 逐字反例:一种被拒的形状一条。
 *
 * `rejectedAt` 是**被拒的那一处**,不是「格式不对」:零次被拒的是「调用本身不存在」,多次被拒的
 * 是「第二次调用」,未知工具被拒的是「那个名字」,坏参数被拒的是「那串字节」。
 */
type RejectExample = {
  readonly reason: ActionRejectReason;
  readonly rejectedAt: string;
  readonly sample: string;
};

const REJECT_EXAMPLES: readonly RejectExample[] = [
  {
    reason: "no-tool-call",
    rejectedAt:
      "零次调用:整条回复只有文字,一次工具调用都没有——被拒的是「那次调用本身不存在」。" +
      "解释可以写,但必须同时有一次调用。",
    sample: "我想先把 script.ts 读完,再决定改哪里。",
  },
  {
    reason: "multiple-tool-calls",
    rejectedAt:
      "两次调用:被拒的是第二次调用,而且两次都不会执行。想一次跑两件事就写进**同一条** " +
      "`command`,用换行或 `&&` 连起来。",
    sample: [
      `bash {"command": "ls /workspace"}`,
      `bash {"command": "wc -l /workspace/script.ts"}`,
    ].join("\n"),
  },
  {
    reason: "unknown-tool",
    rejectedAt:
      "工具名不认识:被拒的是那个名字。本会话声明的五个是 " +
      "`bash` / `check` / `probe` / `evaluate` / `finish`,别的名字没有执行体。",
    sample: `shell {"command": "ls /workspace"}`,
  },
  {
    reason: "malformed-arguments",
    rejectedAt:
      "参数坏了:被拒的是 `arguments` 那串字节——它不是合法 JSON,或者形状不符合该工具的声明。" +
      '`bash` 只收 `{"command": "<一条命令串>"}`,另外四个不收参数(`{}` 或空)。',
    sample: `bash {"command": }`,
  },
];

/** 把一段多行样本挂到列表项下面:`- 说明` 之后每行缩进两格,读起来是一段而不是一段散落的行。 */
const indented = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** 被拒时能指名的那几处细节。缺席的键说明那一种拒绝没有可指的读数。 */
type RejectDetail = {
  /** 这一次发起了几次调用(`multiple-tool-calls`)。 */
  readonly count?: number;
  /** 那个不认识的名字(`unknown-tool`)。 */
  readonly name?: string;
  /** 那串坏掉的 `arguments` 的开头(`malformed-arguments`)。 */
  readonly excerpt?: string;
  /** 参数坏掉的那一次调用的是哪个工具(`malformed-arguments`)。 */
  readonly tool?: string;
};

/** 逐字引用一段字节时截短:纠正消息不是回显全部坏字节的地方。 */
const EXCERPT_LIMIT = 120;

const excerptOf = (text: string): string =>
  text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT)}…`;

/**
 * 纠正消息 = 规则 + 逐字正例 + 逐字反例(本次踩到的那条点名)。
 *
 * 三段缺一不可:只说规则,模型得猜「恰好一次调用」长什么样;只给正例,它不知道自己现在写的
 * 那种形状为什么不算;不点名,它改的是无从判断的「格式」。
 */
const correctionOf = (reason: ActionRejectReason, detail: RejectDetail): string => {
  const head =
    reason === "no-tool-call"
      ? "这一步没有发起任何工具调用,所以没有任何动作被执行。"
      : reason === "multiple-tool-calls"
        ? `这一步一次性发起了 ${String(detail.count ?? 0)} 次工具调用,而一步恰好一次,所以一次都没有被执行。`
        : reason === "unknown-tool"
          ? `这一步调用的工具名是 \`${detail.name ?? ""}\`,不在本会话声明的五个里(bash / check / probe / evaluate / finish),所以没有任何动作被执行。`
          : `这一步调用 \`${detail.tool ?? ""}\` 时给的 arguments 不能用:它不是合法 JSON,或者形状不符合该工具的声明(${excerptOf(detail.excerpt ?? "")})。所以没有任何动作被执行。`;
  const lines = [
    head,
    "",
    "规则:你的每一轮回复里**恰好一次**工具调用——它就是这一步的全部动作。调用 `bash` 时把多行命令写成**一条** `command` 串(换行、`&&`、`for … do … done` 都照 bash 的规则走),不要拆成多次调用。",
    "",
    `✅ 正例(逐字,下一步照这个形状调用):`,
    ...POSITIVE_EXAMPLES.map((example) => `- ${example}`),
    "",
    `❌ 反例(逐字,${String(REJECT_EXAMPLES.length)} 种都会被拒,一条命令都不执行;标 ◀ 的是这一次踩到的那种):`,
  ];
  for (const example of REJECT_EXAMPLES) {
    const mark = example.reason === reason ? " ◀" : "";
    lines.push(`- ${example.rejectedAt}${mark}`);
    lines.push(indented(example.sample));
  }
  lines.push("", "下一步请只发起一次工具调用。这一步已经计入步数。");
  return lines.join("\n");
};

const reject = (reason: ActionRejectReason, detail: RejectDetail): ActionParse => ({
  kind: "reject",
  reason,
  correction: correctionOf(reason, detail),
});

/**
 * 解析这一步发起的工具调用。
 *
 * 只有「恰好一次调用、名字在声明集合里、`arguments` 合法且形状对」才产出一个动作;其余四种一律
 * 不执行,只回纠正消息。
 */
export const parseAction = (toolCalls: readonly ToolCall[]): ActionParse => {
  if (toolCalls.length === 0) return reject("no-tool-call", {});
  if (toolCalls.length > 1) return reject("multiple-tool-calls", { count: toolCalls.length });
  const call = toolCalls[0];
  if (call === undefined) return reject("no-tool-call", {});
  const tool = TOOL_NAMES.find((name) => name === call.name);
  if (tool === undefined) return reject("unknown-tool", { name: call.name });
  const verdict = argumentsOf(tool, call.argumentsJson);
  if (verdict.kind === "bad")
    return reject("malformed-arguments", { tool, excerpt: call.argumentsJson });
  return {
    kind: "ok",
    tool,
    argumentsJson: call.argumentsJson,
    ...(verdict.command === undefined ? {} : { command: verdict.command }),
  };
};
