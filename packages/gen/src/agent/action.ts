/**
 * 动作块的**严格解析**:一条回复里恰好一个 ` ```bash ` 块(ADR-0032「一次输出恰好一个动作块」)。
 *
 * ── 为什么严格到「零个 / 多个 / 非 bash 都不执行」 ──
 *
 * 放宽到「抽第一个块」能省一步,代价是模型以为自己把三条命令都跑了,然后基于那个错误的世界观
 * 继续推理——那是最难诊断的一类失败。宁可浪费一步,也不要在错误的前提上继续。
 *
 * 所以本模块只有两种结论:一个可执行的命令,或者一条纠正消息。`done` 哨兵的出现位置也在这里
 * 暴露出来,但**切分不在这里**:它属于宿主侧(票 04 的 dispatcher / 薄壳通道),本层只回答
 * 「块里有没有一行独占的 `done`、在第几行」。
 *
 * ── 本模块不碰 IO、不碰时钟、不拼历史 ──
 *
 * 纯文本进、纯结论出,所以「零个块怎么办」可以被单测逐字钉住,而 loop 只消费结论。
 */

/** 动作块的围栏标记。用 `bash` 而不是 mini 的私有串:它是训练分布里的东西(ADR-0032)。 */
export const ACTION_FENCE_TAG = "bash";

/** 块级哨兵:块内**独占一行**的 `done`。 */
export const DONE_SENTINEL = "done";

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
      /** 块内独占一行 `done` 的行号(0 起);没有这一行时缺席。切分归宿主侧。 */
      readonly doneAtLine?: number;
    }
  | {
      readonly kind: "reject";
      readonly reason: ActionRejectReason;
      /** 回给模型的纠正消息,与 `prompts/agent-system.md` 里那份协议呼应。 */
      readonly correction: string;
    };

/** 三种拒绝:**零个块**、**多个块**、**块标记不是 `bash`**。 */
export type ActionRejectReason = "no-block" | "multiple-blocks" | "non-bash";

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

/** 块内独占一行的 `done` 的行号(0 起);没有就 `undefined`。 */
export const doneSentinelLine = (body: string): number | undefined => {
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === DONE_SENTINEL) {
      return index;
    }
  }
  return undefined;
};

/**
 * 纠正消息。
 *
 * 它必须与 `prompts/agent-system.md` 里那份协议**说同一件事**:恰好一个 `bash` 块、多行也算
 * 一块、解析失败仍然计步。措辞里点名这一次到底违反了什么(零个 / 几个 / 标记是什么),因为
 * 只说「格式错误」的纠正消息会让模型下一步换一个方向再猜一次。
 */
const correctionOf = (reason: ActionRejectReason, blocks: readonly FencedBlock[]): string => {
  const fence = "```";
  const wanted = `${fence}${ACTION_FENCE_TAG}`;
  const head =
    reason === "no-block"
      ? `这一步的回复里没有 ${wanted} 代码块,所以没有任何命令被执行。`
      : reason === "multiple-blocks"
        ? `这一步的回复里有 ${String(blocks.length)} 个代码块,所以没有任何命令被执行。`
        : `这一步的回复里只有一个代码块,但它的标记是 ${fence}${blocks[0]?.tag ?? ""},不是 ${wanted},所以没有任何命令被执行。`;
  return [
    head,
    "",
    "协议:你的每一轮回复里**恰好一个** `bash` 代码块——它就是这一步的全部动作,整块交给一次 shell 执行。",
    "- 想跑多条命令:写进同一个块,一行一条或者用 `&&` 连起来,不要开第二个块。",
    "- 想解释:解释写成普通文字,不要用一个非 `bash` 的代码块代替动作。",
    "- 块内可以有多行,仍然只算一块;块内独占一行的 `done` 会让会话在这一步结束后停下。",
    "",
    "下一步请只写一个 `bash` 代码块。这一步已经计入步数。",
  ].join("\n");
};

/**
 * 解析一条回复。
 *
 * 只有「恰好一个块且标记是 `bash`」才产出命令;其余三种一律不执行,只回纠正消息。
 */
export const parseAction = (text: string): ActionParse => {
  const blocks = fencedBlocks(text);
  if (blocks.length === 0) {
    return { kind: "reject", reason: "no-block", correction: correctionOf("no-block", blocks) };
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
  const doneAtLine = doneSentinelLine(block.body);
  return {
    kind: "ok",
    command: block.body,
    ...(doneAtLine === undefined ? {} : { doneAtLine }),
  };
};

/**
 * 整块去空白后恰为 `evaluate`:这一次 `evaluate` 产出一个候选(过程记录条目的 `action.kind`)。
 *
 * 判据只看**整块**:`evaluate; rm -rf /workspace` 不是 `evaluate` 动作,它是 bash——配额与
 * 观测定性都挂在「整块就是那一条命令」上。
 */
export const isEvaluateAction = (command: string): boolean => command.trim() === "evaluate";
