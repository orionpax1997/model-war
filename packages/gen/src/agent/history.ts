/**
 * 会话历史的构造: `system` + 首条 `user` + 每步一对(`assistant` 原文 + 它发起的调用、`tool` 观测)。
 *
 * ── 历史不是一份 prompt,是一份只增不减的记录(ADR-0032) ──
 *
 * 分步形态每步都发完整对话,所以「这一轮发什么」没有独立答案:它就是「到目前为止发生过的
 * 一切」。因此本模块只做两件事——把一步的观测渲染成一条 `tool` 消息,把若干步拼成消息数组。
 * 它不裁剪、不摘要、不改写,也不做上下文窗口的判断(那是守卫的事,守卫只决定停不停)。
 *
 * ── assistant 那一条是原文,一个字节都不改 ──
 *
 * 一旦 harness 把模型输出规范化成「解析后的动作」,模型下一轮读到的自己就不是它写的东西,
 * 而它恰恰是照着原文推理的;解析失败时改写 assistant 消息更糟——那是在篡改历史,模型会以为
 * 自己没写过那句话。解析失败是**工具结果**问题:另起一条观测消息,退出码非零。
 *
 * ── 观测的角色是 `tool`,不是 `user`(ADR-0032 修订) ──
 *
 * 它以前是 `user`,理由是「不走 tool-calling 就没有 `tool_call_id` 可配对」。那条理由现在
 * **反过来了**:有了工具调用,才**必须**用 `tool` 角色——工具调用那一轮 assistant 的 `content`
 * 常常是空串(它没有说话,只调了一次工具),后面跟一条 `user` 会让模型读到「它什么都没说,
 * 然后我自己说了一段」,历史读起来像自言自语。`tool` + `tool_call_id` 配对是这个形状的
 * **正确信封**,也是渠道唯一认的配对方式(不配对 / 缺 id 会 400 或静默读错)。
 *
 * ── 推理是搭车,不是内容 ──
 *
 * `ReasoningEcho` 挂在 assistant 消息的**可选字段**上(ADR-0032「通道是不透明的」),不进
 * `content`、不进观测文本。这样同一段历史既能被三族各自序列化,也让「历史文本」这件事在档案
 * 与复核里保持原样。
 */

import type { ChatMessage, ReasoningEcho } from "../model-client.js";
import { toolCallIdOf, type ToolCall } from "./tools.js";

/** 一步回给模型的观测。三个键就是过程记录条目里那三个键,不另造形状。 */
export type StepObservation = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** 一步在历史里留下的几半。 */
export type HistoryTurn = {
  /** 模型当时的原始文本(不改写)。工具调用轮次里它常常是空串——真正的产物在 `toolCalls`。 */
  readonly raw: string;
  /** 模型这一步真的发起了哪些工具调用;按序原样搬运,含 `argumentsJson` 的逐字字节。 */
  readonly toolCalls?: readonly ToolCall[];
  readonly observation: StepObservation;
  /** 这一轮响应带回来的不透明推理;没有可回传的东西时缺席。 */
  readonly reasoning?: ReasoningEcho;
};

/** 会话的开始:两段固定文本(协议在 `system`,任务与目录在首条 `user`)。 */
export type HistorySeed = {
  readonly system: string;
  readonly firstUser: string;
};

/** 空输出也要有一句话:留白会让模型分不清「跑了但没输出」与「什么都没跑」。 */
const EMPTY = "(empty)";

/**
 * 把一步的观测渲染成一条文本。
 *
 * 用方括号标签而不是自然语言标题:输出内容里出现 `stderr:` 这种字样是常见的事
 * (编译器、`grep -n` 的命中行),标签足够短、足够醒目,边界不会被内容里的同形字样吃掉。
 * 输出**逐字节**嵌在标签下面——模型看到的字节就是落盘的字节(ADR-0031)。
 */
export const renderObservation = (observation: StepObservation): string =>
  [
    `exit code: ${String(observation.exitCode)}`,
    "[stdout]",
    observation.stdout === "" ? EMPTY : observation.stdout,
    "[stderr]",
    observation.stderr === "" ? EMPTY : observation.stderr,
  ].join("\n");

/**
 * 造一份完整历史。
 *
 * 线性重发,所以每次调用都从头拼:**同一个输入产出同一份字节**,而「历史里少了哪一步」这类
 * bug 会在下一步的红里立刻出现,不需要靠 diff 两步之间的增量去猜。
 */
export const buildHistory = (
  seed: HistorySeed,
  turns: readonly HistoryTurn[],
): readonly ChatMessage[] => {
  const messages: ChatMessage[] = [
    { role: "system", content: seed.system },
    { role: "user", content: seed.firstUser },
  ];
  // 步号从 1 起,与 `steps[i].step` 同一口径:它是配对 id 里那半只属于本会话的序号。
  for (const [index, turn] of turns.entries()) {
    const step = index + 1;
    messages.push({
      role: "assistant",
      content: turn.raw,
      ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
      ...(turn.toolCalls === undefined
        ? {}
        : { toolCalls: turn.toolCalls, toolCallId: toolCallIdOf(step) }),
    });
    messages.push({
      role: "tool",
      toolCallId: toolCallIdOf(step),
      content: renderObservation(turn.observation),
    });
  }
  return messages;
};
