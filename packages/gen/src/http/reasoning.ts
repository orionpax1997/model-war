/**
 * 推理回传的**读法与写法**:三族各一份,生产者与序列化者都是本文件。
 *
 * ── 为什么这件事不能由 loop 或档案负责(「reasoning 按端点族分家」) ──
 *
 * 签名与加密块对 loop、档案、报告都是无意义的字节:只有**产出它的那一族端点**知道它该以什么
 * 形状带回去。所以通道是一个不透明字段(`ReasoningEcho`),本文件是它唯一的解释者——读进来
 * 在这里、写回去也在这里,中间的每一站(历史、`ChatMessage`)只负责原样搬运。
 *
 * ── 三族三份策略,第四族显式丢弃 ──
 *
 * | 族 | 响应里看得见的东西 | 策略 |
 * |---|---|---|
 * | `messages` | `content` 里 `type:"thinking"` 的块 + 它的 `signature` | **签名回传**:连签名原样送回;缺签名的块送回时不带它,并记一条丢块计数 |
 * | `responses` | `output` 里 `type:"reasoning"` 的条目(含 `encrypted_content`) | **加密回传**:条目原样送回 |
 * | `chat-completions` | `message.reasoning_details` 数组 | 普通推理内容(含 `reasoning_content`、`reasoning.text`)**丢弃**;`{type:"reasoning.encrypted"}` 原样回传 |
 * | `generate-content` | `parts[].thought` 的思维链 | 显式 `drop`: 只裁了三族,这一族的思考段没有签名也没有加密块,不发明一种回传 |
 *
 * `glyph-cluster` 的 `{type:"reasoning.encrypted", data:"gwst1.…", format:"stealth-v1"}` 属于
 * chat 族那一格:它是该族里**唯一有东西可回传**的形态,丢掉等于主动放弃跨步连续性。
 *
 * ── 策略取自能力声明,不取自本文件 ──
 *
 * 每个函数都要一个 `carry` 参数,它的唯一来源是 `endpoints.ts` 里那一族的能力声明。理由:
 * 「这一族怎么回传」只该有一个家;在这里写死一个 `"signed"`,再加一处声明,就是两份会分叉的
 * 事实。写回时它顺带成了复核——A 族的条目写进 B 族的请求体,端点会 400,而那种 400 在报告里
 * 与「模型写错了」同形,所以这里把它当场变成一条点名两族的错误。
 *
 * ── 丢块为什么要计数,而不是静默 ──
 *
 * 「这一席位的签名块被端点吞了」与「这一席位没有推理」在历史里长得一模一样,而前者是端点
 * 契约破裂的信号。计数留在不透明字段里(不进历史文本、不进档案):它是本族自己的诊断,
 * 归 loop 侧的日志读,不归模型读。
 *
 * ── 解析全程 `unknown` 收窄 ──
 *
 * 与 `endpoints.ts` 同一条纪律:端点返回的是外部输入,遇到缺字段退到「没有可回传的东西」,
 * 不抛「取属性时 undefined」的下游崩溃。
 */

import type { ReasoningCarry, ReasoningEcho } from "../model-client.js";
import { isRecord } from "../record.js";

/** chat 族的加密条目类型名(点名的形态)。 */
export const CHAT_ENCRYPTED_ENTRY_TYPE = "reasoning.encrypted";

/** messages 族的推理块类型名。 */
export const MESSAGES_THINKING_BLOCK_TYPE = "thinking";

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * 读出来、还没挂策略的条目。
 *
 * 分成两半是为了让「这一族怎么回传」只有一个家:本文件回答「带什么」,`endpoints.ts` 的能力
 * 声明回答「按哪种策略带」。合成一个类型的话,每次读都得从别处再借一个策略串。
 */
export type ReasoningPayload = {
  readonly blocks: readonly unknown[];
  readonly dropped: number;
};

/** 造一份条目;一条都没留下时返回 `undefined`(不往消息上挂空壳)。 */
const payloadOf = (blocks: readonly unknown[], dropped: number): ReasoningPayload | undefined =>
  blocks.length === 0 && dropped === 0 ? undefined : { blocks, dropped };

/**
 * 回传前复核「这份条目是这一族产出的」。
 *
 * 判据取**能力声明**而不是本文件里的常量:这一族怎么回传只由 `endpoints.ts` 那一行回答,
 * 在这里再抄一份就会有两个家。
 */
const assertCarry = (declared: ReasoningCarry, echo: ReasoningEcho, where: string): void => {
  if (echo.carry !== declared) {
    throw new Error(
      `${where}:推理条目的策略是 ${echo.carry},这一族声明的是 ${declared};跨族复用推理回传会静默 400`,
    );
  }
};

// ── chat-completions ────────────────────────────────────────────────────────

/**
 * 读 chat 族的推理条目。
 *
 * 只收 `type:"reasoning.encrypted"` 的条目;`reasoning_details` 里的其它类型(典型是
 * `reasoning.text`,即明文的半截思维链)**丢弃并计数**。`reasoning_content` 是纯文本增量、
 * 不是条目,既不带也不计——它不是「块」,计进来会让「有个块被吞了」这个信号被正常推理淹没。
 */
export const readChatReasoning = (
  message: Record<string, unknown>,
): ReasoningPayload | undefined => {
  const entries = asArray(message.reasoning_details);
  const blocks: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (isRecord(entry) && entry.type === CHAT_ENCRYPTED_ENTRY_TYPE) {
      blocks.push(entry);
    } else {
      dropped += 1;
    }
  }
  return payloadOf(blocks, dropped);
};

/** 把加密条目写回一条 chat 请求消息:`reasoning_details` 是这条族的回传位置。 */
export const writeChatReasoning = (
  wire: Record<string, unknown>,
  echo: ReasoningEcho,
  declared: ReasoningCarry,
): void => {
  assertCarry(declared, echo, "chat-completions");
  // 空数组不发:没有可回传的条目时,请求里不该多出一个陌生字段。
  if (echo.blocks.length > 0) {
    wire.reasoning_details = echo.blocks;
  }
};

/**
 * chat 流的逐帧累积器:同一份读法的流式形态。
 *
 * 加密条目一帧到齐(它是服务端签过的一段令牌,不会被切成增量),所以按 `id` 去重即可——
 * 中止帧重发同一条不会让历史里多出两份。明文推理增量(`reasoning_content`)一律丢。
 */
export const chatReasoningStream = (
  carry: ReasoningCarry,
): {
  readonly push: (delta: Record<string, unknown>) => void;
  readonly result: () => ReasoningEcho | undefined;
} => {
  const blocks: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  return {
    push: (delta) => {
      for (const entry of asArray(delta.reasoning_details)) {
        if (!isRecord(entry) || entry.type !== CHAT_ENCRYPTED_ENTRY_TYPE) {
          dropped += 1;
          continue;
        }
        const key = stringField(entry, "id") ?? JSON.stringify(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push(entry);
      }
    },
    result: () => (blocks.length === 0 && dropped === 0 ? undefined : { carry, blocks, dropped }),
  };
};

// ── messages(Anthropic 系)───────────────────────────────────────────────────

/**
 * 读 messages 族的 thinking 块。
 *
 * 带回的是 `{type:"thinking", thinking, signature}` 这一整块——**签名与正文必须成对**:
 * 端点靠签名验证这段思维链确实是它产出的,只带正文等于伪造。所以缺 `signature` 的块
 * 在这里就被丢掉并计数,而不是送到请求体里再让端点 400。
 */
export const readMessagesReasoning = (
  content: readonly unknown[],
): ReasoningPayload | undefined => {
  const blocks: unknown[] = [];
  let dropped = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== MESSAGES_THINKING_BLOCK_TYPE) {
      continue;
    }
    if (stringField(block, "signature") === undefined) {
      dropped += 1;
      continue;
    }
    blocks.push(block);
  }
  return payloadOf(blocks, dropped);
};

/**
 * messages 族一条 assistant 消息的内容块:签名块在前、正文块在后(与端点产出的顺序一致)。
 *
 * **正文是空串时不发 text 块**。工具调用那一轮的 `content` 通常是 `""`(模型只调工具不说话),
 * 而 Anthropic 不接受空的 text 块;整条消息三样都没有时由调用方整条不发(空 `content` 数组同样被拒)。
 */
export const writeMessagesReasoning = (
  echo: ReasoningEcho | undefined,
  text: string,
  declared: ReasoningCarry,
): unknown[] => {
  if (echo !== undefined) {
    assertCarry(declared, echo, "messages");
  }
  return [
    ...(echo === undefined ? [] : echo.blocks),
    ...(text === "" ? [] : [{ type: "text", text }]),
  ];
};

/** messages 流的逐帧累积器:thinking 起始块 + `thinking_delta` + `signature_delta`。 */
export const messagesReasoningStream = (
  carry: ReasoningCarry,
): {
  readonly pushStart: (block: Record<string, unknown>) => void;
  readonly pushDelta: (delta: Record<string, unknown>) => void;
  readonly result: () => ReasoningEcho | undefined;
} => {
  const blocks: Record<string, unknown>[] = [];
  let open: Record<string, unknown> | undefined;
  return {
    pushStart: (block) => {
      if (block.type !== MESSAGES_THINKING_BLOCK_TYPE) {
        open = undefined;
        return;
      }
      const thinking: Record<string, unknown> = {
        type: MESSAGES_THINKING_BLOCK_TYPE,
        thinking: "",
      };
      blocks.push(thinking);
      open = thinking;
    },
    pushDelta: (delta) => {
      const current = open;
      if (current === undefined) return;
      const type = stringField(delta, "type");
      if (type === "thinking_delta") {
        const accumulated = stringField(current, "thinking") ?? "";
        current.thinking = `${accumulated}${stringField(delta, "thinking") ?? ""}`;
      } else if (type === "signature_delta") {
        const signature = stringField(delta, "signature");
        if (signature !== undefined) current.signature = signature;
      }
    },
    result: () => {
      const payload = readMessagesReasoning(blocks);
      return payload === undefined ? undefined : { carry, ...payload };
    },
  };
};

// ── responses(OpenAI Responses API)──────────────────────────────────────────

/**
 * 读 responses 族的加密推理条目。
 *
 * 这一族的条目形状(`{type:"reasoning", id, encrypted_content, summary}`)是端点自己认的,
 * 所以整条原样保留:改一个字段名都会被端点当成陌生条目。没有 `encrypted_content` 的条目
 * (只有 `summary` 的明文摘要)不带——它不可用于跨步连续性,带回去只是白占字节。
 */
export const readResponsesReasoning = (
  output: readonly unknown[],
): ReasoningPayload | undefined => {
  const blocks: unknown[] = [];
  let dropped = 0;
  for (const item of output) {
    if (!isRecord(item) || item.type !== "reasoning") {
      continue;
    }
    if (stringField(item, "encrypted_content") === undefined) {
      dropped += 1;
      continue;
    }
    blocks.push(item);
  }
  return payloadOf(blocks, dropped);
};

/**
 * responses 族一条 assistant 消息展开成的 input 条目:推理条目在前、消息条目在后。
 *
 * 顺序是端点的要求:带上一条消息的推理必须排在它自己之前,否则连续性断在这一格。
 */
export const writeResponsesReasoning = (
  echo: ReasoningEcho | undefined,
  message: Record<string, unknown>,
  declared: ReasoningCarry,
): unknown[] => {
  if (echo !== undefined) {
    assertCarry(declared, echo, "responses");
  }
  return [...(echo === undefined ? [] : echo.blocks), message];
};
