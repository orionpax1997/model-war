/**
 * 动作块的**严格解析**:一条回复里恰好一个 ` ```bash ` 块(ADR-0032「一次输出恰好一个动作块」)。
 *
 * ── 为什么严格到「零个 / 多个 / 非 bash 都不执行」 ──
 *
 * 放宽到「抽第一个块」能省一步,代价是模型以为自己把三条命令都跑了,然后基于那个错误的世界观
 * 继续推理——那是最难诊断的一类失败。宁可浪费一步,也不要在错误的前提上继续。
 *
 * 所以本模块只有两种结论:一个可执行的命令,或者一条纠正消息。
 *
 * **`done` 的判据整个不在这里**:收工是 rootfs 里那条薄壳命令上报给宿主的一个请求,本层既
 * 不认行、也不切块——整块原样交出去,由 `bash` 解析(ADR-0032 修订)。本层曾经也报一份
 * 「独占一行 `done` 的行号」,而那个行号一路传到执行器却从没被读过(执行器自己重扫一遍)
 * ——同一件事的两份判据,删掉的是多余的那一份。
 *
 * **纠正消息带逐字正例与逐字反例。** 只写一句「恰好一个 `bash` 块」时,一个不服从的席位
 * 三次都不改(2026-11-19 的 `deepseek-v4.1-flash` / `mimo-v2.6-flash`),而「它没懂」与
 * 「它懂了但不照做」无法区分。逐字反例把被拒的**那一处**指出来,于是下一次要么改对、要么
 * 留下「指到脸上仍不改」这条可读的证据。
 *
 * ── 本模块不碰 IO、不碰时钟、不拼历史 ──
 *
 * 纯文本进、纯结论出,所以「零个块怎么办」可以被单测逐字钉住,而 loop 只消费结论。
 */

/** 动作块的围栏标记。用 `bash` 而不是 mini 的私有串:它是训练分布里的东西(ADR-0032)。 */
export const ACTION_FENCE_TAG = "bash";

/**
 * 「这一步没有动作可执行」的退出码。
 *
 * 借 `EX_USAGE`(64):它是「命令用法不对」,与沙箱薄壳的 2(工具不可用)、命令自己的非零退出
 * 都分得开。解析被拒与响应被截断转格式反馈共用它——两者都是「模型这一步没写出可执行的动作」。
 */
export const ACTION_REJECT_EXIT_CODE = 64;

/** 被识别出来的一个围栏块。`body` 不含两端的围栏行。 */
export type FencedBlock = {
  /** 围栏行上写的标记(可为空串)。 */
  readonly tag: string;
  readonly body: string;
};

/** 一条回复的解析结论。 */
export type ActionParse =
  | {
      readonly kind: "ok";
      /** 整块原文,原样交给一次 `bash -c`。 */
      readonly command: string;
    }
  | {
      readonly kind: "reject";
      readonly reason: ActionRejectReason;
      /** 回给模型的纠正消息,与 `prompts/agent-system.md` 里那份协议呼应。 */
      readonly correction: string;
    };

/**
 * 被拒的形状族:**零个块**、**多个块**、**块标记不是 `bash`**、**XML 工具调用**。
 *
 * 它是身份清单里 `actionSyntax.rejects` 的唯一真源(清单不另抄一份),也是纠正消息逐字反例
 * 的索引:每一种都有它自己的那一条反例。
 */
export const ACTION_REJECT_REASONS = [
  "no-block",
  "multiple-blocks",
  "non-bash",
  "xml-tool-call",
] as const;

export type ActionRejectReason = (typeof ACTION_REJECT_REASONS)[number];

/**
 * XML 工具调用的形状:训练分布里那套 `tool-calling`(`<tool_call><function=bash>`)。
 *
 * 判据放宽到「标签名后面跟空白 / `=` / `:`」,因为真会话里那一族常被模型写坏成带 id 的样子
 * (`<tool_calls:6124c78e><tool_call:6124c78e>bash>`),那不是别的形状,是同一个不服从的写法。
 *
 * 单独识别它**不是**为了接受它——接受它等于给协议开第二套语法,而「恰好一个块、整块交给一次
 * shell」是 ADR-0032 的身份项。识别只为了两件事:纠正消息能指名「被拒的是 `<function=bash>`
 * 这一处」,以及身份清单里记下这一版拒过什么。
 */
const XML_TOOL_CALL = /<\/?(?:tool_calls?|function|parameter)[\s>=:]/iu;

const OPEN_FENCE = /^```(\S*)\s*$/;
const CLOSE_FENCE = /^```\s*$/;

/**
 * 把文本切成围栏块。
 *
 * 三种细节都是有意为之:
 * - 围栏行必须**独占一行**(` ```bash ` 后面只允许空白),正文里行内的反引号不算动作;
 * - 关围栏只认**光杆 ` ``` `**:块内的 ` ```ts ` 是正文,不会把块提前截断;
 * - **没关的围栏跑到文本结尾**。模型常常忘写收尾那一行,而它的意图是清楚的;响应真被输出上限
 *   截断时,`finishReason` 那一侧先拦下来(转格式反馈),轮不到这里猜。
 */
export const fencedBlocks = (text: string): readonly FencedBlock[] => {
  const blocks: FencedBlock[] = [];
  let open: { tag: string; lines: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (open === undefined) {
      const opened = OPEN_FENCE.exec(line);
      if (opened !== null) {
        open = { tag: opened[1] ?? "", lines: [] };
      }
      continue;
    }
    if (CLOSE_FENCE.test(line)) {
      blocks.push({ tag: open.tag, body: open.lines.join("\n") });
      open = undefined;
      continue;
    }
    open.lines.push(line);
  }
  if (open !== undefined) {
    blocks.push({ tag: open.tag, body: open.lines.join("\n") });
  }
  return blocks;
};

/**
 * 纠正消息。
 *
 * 它必须与 `prompts/agent-system.md` 里那份协议**说同一件事**:恰好一个 `bash` 块、多行也算
 * 一块、解析失败仍然计步。措辞里点名这一次到底违反了什么(零个 / 几个 / 标记是什么),因为
 * 只说「格式错误」的纠正消息会让模型下一步换一个方向再猜一次。
 */
const FENCE = "```";

/** 逐字正例:最小可执行的一块。模型下一步照这个形状写就对了,不需要理解「恰好一个」是什么意思。 */
const POSITIVE_EXAMPLE = [`${FENCE}${ACTION_FENCE_TAG}`, "ls /workspace", FENCE].join("\n");

/**
 * 逐字反例:一种被拒的形状一条。
 *
 * `rejectedAt` 是**被拒的那一处**,不是「格式不对」:
 * 零块被拒的是「整条回复里没有那个块」,两块被拒的是「第二个块的起始行」,非 `bash` 被拒的
 * 是「围栏行上的标记」,XML 被拒的是「`<function=bash>` 这一处」。
 */
type RejectExample = {
  readonly reason: ActionRejectReason;
  readonly rejectedAt: string;
  readonly sample: string;
};

const REJECT_EXAMPLES: readonly RejectExample[] = [
  {
    reason: "no-block",
    rejectedAt: `零块:整条回复只有解释,一个围栏块都没有——被拒的是「那个块本身不存在」。`,
    sample: "我想先把 script.ts 读完,再决定改哪里。",
  },
  {
    reason: "multiple-blocks",
    rejectedAt:
      "两块:被拒的是第二个块的起始行。想一次跑两件事就写进同一个块," +
      "一行一条或者用 `&&` 连起来。",
    sample: [
      `${FENCE}bash`,
      "ls /workspace",
      FENCE,
      `${FENCE}bash`,
      "wc -l /workspace/script.ts",
      FENCE,
    ].join("\n"),
  },
  {
    reason: "non-bash",
    rejectedAt: `非 bash 标记:被拒的是围栏行上的标记(${FENCE}ts / ${FENCE}typescript 之类),不是块里的内容。`,
    sample: [`${FENCE}ts`, "const x = 1;", FENCE].join("\n"),
  },
  {
    reason: "xml-tool-call",
    rejectedAt:
      "XML 工具调用:被拒的是 `<function=bash>` 这一处——这里没有 XML 解析器," +
      "它既不是 `bash` 块,也不是 bash 命令。",
    sample: [
      "<tool_call>",
      "<function=bash>",
      "<parameter=command>ls /workspace</parameter=command>",
      "</function>",
      "</tool_call>",
    ].join("\n"),
  },
];

/** 把一段多行样本挂到列表项下面:`- 说明` 之后每行缩进两格,读起来是一段而不是一段散落的行。 */
const indented = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/**
 * 纠正消息 = 规则 + 逐字正例 + 逐字反例(本次踩到的那条点名)。
 *
 * 三段缺一不可:只说规则,模型得猜「恰好一个块」长什么样;只给正例,它不知道自己现在写的
 * 那种形状为什么不算;不点名,它改的是无从判断的「格式」。
 */
const correctionOf = (reason: ActionRejectReason, blocks: readonly FencedBlock[]): string => {
  const wanted = `${FENCE}${ACTION_FENCE_TAG}`;
  const head =
    reason === "no-block"
      ? `这一步的回复里没有 ${wanted} 代码块,所以没有任何命令被执行。`
      : reason === "multiple-blocks"
        ? `这一步的回复里有 ${String(blocks.length)} 个代码块,所以没有任何命令被执行。`
        : reason === "non-bash"
          ? `这一步的回复里只有一个代码块,但它的标记是 ${FENCE}${blocks[0]?.tag ?? ""},不是 ${wanted},所以没有任何命令被执行。`
          : `这一步的回复用的是 XML 工具调用形状(<tool_call> / <function=bash>),没有 ${wanted} 代码块,所以没有任何命令被执行。`;
  const lines = [
    head,
    "",
    `规则:你的每一轮回复里**恰好一个** \`bash\` 代码块——它就是这一步的全部动作,整块交给一次 shell 执行。`,
    "",
    `✅ 正例(逐字,下一步照这个形状写):`,
    POSITIVE_EXAMPLE,
    "",
    `❌ 反例(逐字,${String(REJECT_EXAMPLES.length)} 种都会被拒,一条命令都不执行;标 ◀ 的是这一次踩到的那种):`,
  ];
  for (const example of REJECT_EXAMPLES) {
    const mark = example.reason === reason ? " ◀" : "";
    lines.push(`- ${example.rejectedAt}${mark}`);
    lines.push(indented(example.sample));
  }
  lines.push("", "下一步请只写一个 `bash` 代码块。这一步已经计入步数。");
  return lines.join("\n");
};

/**
 * 解析一条回复。
 *
 * 只有「恰好一个块且标记是 `bash`」才产出命令;其余三种一律不执行,只回纠正消息。
 */
export const parseAction = (text: string): ActionParse => {
  const blocks = fencedBlocks(text);
  if (blocks.length === 0) {
    // XML 形状单独成一档:它与「只说了话」是两种不同的服从失败,纠正消息要指到不同的地方。
    const reason: ActionRejectReason = XML_TOOL_CALL.test(text) ? "xml-tool-call" : "no-block";
    return { kind: "reject", reason, correction: correctionOf(reason, blocks) };
  }
  if (blocks.length > 1) {
    return {
      kind: "reject",
      reason: "multiple-blocks",
      correction: correctionOf("multiple-blocks", blocks),
    };
  }
  const block = blocks[0];
  if (block === undefined || block.tag !== ACTION_FENCE_TAG) {
    return { kind: "reject", reason: "non-bash", correction: correctionOf("non-bash", blocks) };
  }
  return { kind: "ok", command: block.body };
};

/**
 * 整块去空白后恰为 `evaluate`:这一次 `evaluate` 产出一个候选(过程记录条目的 `action.kind`)。
 *
 * 判据只看**整块**:`evaluate; rm -rf /workspace` 不是 `evaluate` 动作,它是 bash——配额与
 * 观测定性都挂在「整块就是那一条命令」上。
 */
export const isEvaluateAction = (command: string): boolean => command.trim() === "evaluate";
