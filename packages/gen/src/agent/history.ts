/**
 * 会话历史的构造: `system` + 首条 `user` + 每步一对(`assistant` 原文、`user` 观测)。
 *
 * ── 历史不是一份 prompt,是一份只增不减的记录(ADR-0032) ──
 *
 * 分步形态每步都发完整对话,所以「这一轮发什么」没有独立答案:它就是「到目前为止发生过的
 * 一切」。因此本模块只做两件事——把一步的观测渲染成一条 `user` 消息,把若干步拼成消息数组。
 * 它不裁剪、不摘要、不改写,也不做上下文窗口的判断(那是守卫的事,守卫只决定停不停)。
 *
 * ── assistant 那一条是原文,一个字节都不改 ──
 *
 * 一旦 harness 把模型输出规范化成「解析后的动作」,模型下一轮读到的自己就不是它写的东西,
 * 而它恰恰是照着原文推理的;解析失败时改写 assistant 消息更糟——那是在篡改历史,模型会以为
 * 自己没写过那句话。解析失败是**工具结果**问题:另起一条观测消息,退出码非零。
 *
 * ── 观测的角色是 `user`,不是 `tool` ──
 *
 * 不走 tool-calling 就没有 `tool_use_id` / `tool_call_id` 可配对:用 `tool` 角色会在 messages
 * 族被要求配对、在 chat 族被要求带 id,等于把 tool-calling 的接口悄悄引进来。
 *
 * ── 推理是搭车,不是内容 ──
 *
 * `ReasoningEcho` 挂在 assistant 消息的**可选字段**上(ADR-0032「通道是不透明的」),不进
 * `content`、不进观测文本。这样同一段历史既能被三族各自序列化,也让「历史文本」这件事在档案
 * 与复核里保持原样。
 */

import type { ChatMessage, ReasoningEcho } from "../model-client.js";

/** 一步回给模型的观测。三个键就是过程记录条目里那三个键,不另造形状。 */
export type StepObservation = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** 一步在历史里留下的两半。 */
export type HistoryTurn = {
  /** 模型当时的原始文本(不改写)。 */
  readonly raw: string;
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
  for (const turn of turns) {
    messages.push({
      role: "assistant",
      content: turn.raw,
      ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
    });
    messages.push({ role: "user", content: renderObservation(turn.observation) });
  }
  return messages;
};
