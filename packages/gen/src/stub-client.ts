/**
 * `ModelClient` 的可编程桩:按序回放脚本或抛错,并记下每次调用收到的消息(首条等消息的渲染结果经由它被测试观察到)。
 *
 * ── 为什么桩要记「收到的消息」而不是只回文本 ──
 *
 * 生成协议的核心判据是"回喂的内容**只有**静态校验错误"以及"一次调用发出的 messages 含完整契约"。
 * 这两条只有站在**端口这一侧**才可观察:管线内部怎么拼、怎么拼错的,轮不到桩去读私有字段。
 * 所以桩把 `messages` 与 `params` 原样记下,测试从桩这一侧断言"发出去的到底是什么"。
 *
 * ── 为什么脚本用尽要抛错,而不是重复最后一步或回空串 ──
 *
 * 一条没预料到的多一次调用往往是 bug(重试次数写错、回喂环多转一轮)。回空串会把这种 bug
 * 藏进"文本为空"这种下游症状里;在桩上直接抛,才能让 bug **停在缝上**。
 */

import type {
  ChatMessage,
  ModelClient,
  ModelParams,
  ModelResponse,
  SendOptions,
} from "./model-client.js";
import type { ToolCall, ToolDeclaration } from "./agent/tools.js";

/**
 * 一步回放:回一段文本(可带工具调用 / 截断 / 用量),或抛一个错误(传输失败)。
 *
 * `text` 与 `toolCalls` **同时可给**:工具调用那一轮模型也可能说话了——实测 `hy4-flash` 在
 * `finish_reason: "tool_calls"` 时 `content` 是一段短文本,而 `mimo-v2.6-flash` 那边是 `null`。
 * 夹具能同时造出两种形状,才能钉住「`text` 与 `toolCalls` 各承载一种产物」。
 */
export type StubReply = {
  readonly text: string;
  /** 这一轮发起的工具调用;缺席 = 只说话。 */
  readonly toolCalls?: readonly ToolCall[];
  /** 缺省 `"stop"`;截断场景填 `"length"`(重试判据见 `packages/gen/src/retry.ts`)。 */
  readonly finishReason?: string;
  /** 缺省 `{}`;逐轮落进生成日志的用量读数。 */
  readonly usage?: unknown;
};

export type StubStep = { readonly reply: StubReply } | { readonly fail: Error };

/** 桩观察到的一次调用。 */
export type StubCall = {
  readonly messages: readonly ChatMessage[];
  readonly params: ModelParams;
  /** 这一次请求带上的工具声明(`SendOptions.tools`);没带时缺席。 */
  readonly tools?: readonly ToolDeclaration[];
};

export type StubClient = ModelClient & {
  readonly calls: readonly StubCall[];
};

/** 便利构造:一步"回文本"。 */
export const reply = (
  text: string,
  extra: {
    readonly toolCalls?: readonly ToolCall[];
    readonly finishReason?: string;
    readonly usage?: unknown;
  } = {},
): StubStep => ({ reply: { text, ...extra } });

/**
 * 便利构造:一步"回一次工具调用"(`text` 缺省空串)。
 *
 * 参数是**原始 JSON 字符串**,与渠道同形:桩不帮忙序列化,否则「`argumentsJson` 是逐字字节」
 * 这条断言就在夹具里被中和了。
 */
export const toolCall = (
  name: string,
  argumentsJson: string,
  extra: { readonly text?: string; readonly usage?: unknown } = {},
): StubStep => ({
  reply: {
    text: extra.text ?? "",
    toolCalls: [{ name, argumentsJson }],
    finishReason: "tool_calls",
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
  },
});

/** 便利构造:一步"抛错"(传输失败/超时的模拟)。 */
export const fail = (error: Error): StubStep => ({ fail: error });

/** 便利构造:一串"回文本"步骤。 */
export const replies = (texts: readonly string[]): readonly StubStep[] =>
  texts.map((text) => reply(text));

/** 造一个按序回放的桩客户端。`calls` 随每次 `send` 追加。 */
export const stubClient = (steps: readonly StubStep[]): StubClient => {
  const calls: StubCall[] = [];
  let next = 0;
  return {
    calls,
    send: async (messages, params, options?: SendOptions): Promise<ModelResponse> => {
      calls.push({
        messages,
        params,
        ...(options?.tools === undefined ? {} : { tools: options.tools }),
      });
      const step = steps[next];
      next += 1;
      if (step === undefined) {
        throw new Error(`桩客户端脚本已用尽:第 ${String(next)} 次调用没有可回放的步骤`);
      }
      if ("fail" in step) {
        throw step.fail;
      }
      return {
        text: step.reply.text,
        ...(step.reply.toolCalls === undefined ? {} : { toolCalls: step.reply.toolCalls }),
        finishReason: step.reply.finishReason ?? "stop",
        usage: step.reply.usage ?? {},
      };
    },
  };
};
