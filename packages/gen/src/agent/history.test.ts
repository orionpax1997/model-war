/**
 * 历史构造的单测:形状、原文不改写、观测逐字节、推理只搭车不进文本、工具调用配对。
 *
 * 头注释为什么在 `history.ts` 而不在这里:角色选型(观测是 `tool` 而不是 `user`)的理由
 * 是协议的,不是测试的。这里只钉它的**后果**:一条 assistant + 一条 `tool`、`tool_call_id`
 * 与本步号一致、`argumentsJson` 逐字不改写。
 */

import { expect, it } from "vitest";
import type { ReasoningEcho } from "../model-client.js";
import { buildHistory, renderObservation } from "./history.js";

const seed = { system: "协议:每一步一个动作块", firstUser: "任务:/workspace 里写 script.ts" };

it("历史 = system + 首条 user,没有步就到此为止", () => {
  expect(buildHistory(seed, [])).toEqual([
    { role: "system", content: seed.system },
    { role: "user", content: seed.firstUser },
  ]);
});

it("每步一对:assistant 原文 + tool 观测,顺序与步号一致,`toolCallId` 是 `call-<步号>`", () => {
  const history = buildHistory(seed, [
    { raw: "第一步的原文", observation: { stdout: "a\n", stderr: "", exitCode: 0 } },
    { raw: "第二步的原文", observation: { stdout: "", stderr: "编译错误\n", exitCode: 1 } },
  ]);
  expect(history.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
    "tool",
  ]);
  // 原文不改写:一个字都不动。
  expect(history[2]?.content).toBe("第一步的原文");
  expect(history[4]?.content).toBe("第二步的原文");
  // 观测的角色是 `tool`:上一轮 assistant 只调了一次工具(`content` 可能是空串),后面跟 `user`
  // 会让历史读成「它没说话,然后我自己说了一段」。id 是我们自己确定性派生的,不用渠道那串。
  expect(history[3]).toEqual({
    role: "tool",
    toolCallId: "call-1",
    content: "exit code: 0\n[stdout]\na\n\n[stderr]\n(empty)",
  });
  expect(history[5]).toEqual({
    role: "tool",
    toolCallId: "call-2",
    content: "exit code: 1\n[stdout]\n(empty)\n[stderr]\n编译错误\n",
  });
});

it("工具调用那一轮:assistant 的 `toolCalls` 原样搭车,`argumentsJson` 逐字不改写(不重编码)", () => {
  // 渠道给的是原始 JSON 文本,含它自己的空格与转义写法。`JSON.parse` 再 `stringify` 会改掉它,
  // 而发回下一轮用的就是这串字节——重编码等于「发回去的 ≠ 落盘的」。
  const argumentsJson = '{ "command" : "ls -la /contract" }';
  const history = buildHistory(seed, [
    {
      raw: "",
      toolCalls: [{ name: "bash", argumentsJson }],
      observation: { stdout: "", stderr: "", exitCode: 0 },
    },
  ]);
  // 那一轮模型没说话,真正的产物在 toolCalls 里——历史必须把它带上,否则模型下一轮读到的自己是空的。
  expect(history[2]?.content).toBe("");
  expect(history[2]?.toolCalls).toEqual([{ name: "bash", argumentsJson }]);
  expect(history[3]?.toolCallId).toBe("call-1");
});

it("观测逐字节包住落盘的两路输出:模型看到的字节就是档案里的字节", () => {
  const stdout = "诊断第一行\n诊断第二行\n";
  const stderr = "error TS2322: 类型不匹配\n";
  const rendered = renderObservation({ stdout, stderr, exitCode: 2 });
  expect(rendered).toContain(stdout);
  expect(rendered).toContain(stderr);
  expect(rendered.startsWith("exit code: 2\n")).toBe(true);
});

it("空输出也有一句话,不与环境没跑区分不开", () => {
  expect(renderObservation({ stdout: "", stderr: "", exitCode: 0 })).toBe(
    "exit code: 0\n[stdout]\n(empty)\n[stderr]\n(empty)",
  );
});

it("推理只搭车:content 仍是原文,不透明字段原样挂在 assistant 上", () => {
  const reasoning: ReasoningEcho = {
    carry: "signed",
    blocks: [{ type: "thinking", thinking: "内部推理", signature: "sig-1" }],
    dropped: 0,
  };
  const history = buildHistory(seed, [
    {
      raw: "先想一下\n```bash\nls\n```",
      observation: { stdout: "", stderr: "", exitCode: 0 },
      reasoning,
    },
  ]);
  const assistant = history[2];
  expect(assistant?.content).toBe("先想一下\n```bash\nls\n```");
  expect(assistant?.reasoning).toEqual(reasoning);
  // 推理不进历史文本。
  expect(assistant?.content).not.toContain("内部推理");
  expect(assistant?.content).not.toContain("sig-1");
});

it("没有推理时 assistant 消息不挂空壳键", () => {
  const history = buildHistory(seed, [
    { raw: "原文", observation: { stdout: "", stderr: "", exitCode: 0 } },
  ]);
  expect(Object.keys(history[2] ?? {}).sort()).toEqual(["content", "role"]);
});

it("同一输入产出同一份字节(线性重发的前提)", () => {
  const turns = [
    { raw: "a", observation: { stdout: "1\n", stderr: "", exitCode: 0 } },
    { raw: "b", observation: { stdout: "", stderr: "2\n", exitCode: 1 } },
  ];
  expect(JSON.stringify(buildHistory(seed, turns))).toBe(
    JSON.stringify(buildHistory(seed, [...turns])),
  );
});
