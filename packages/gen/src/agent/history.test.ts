/**
 * 历史构造的单测:形状、原文不改写、观测逐字节、推理只搭车不进文本。
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

it("每步一对:assistant 原文 + user 观测,顺序与步号一致", () => {
  const history = buildHistory(seed, [
    { raw: "第一步的原文", observation: { stdout: "a\n", stderr: "", exitCode: 0 } },
    { raw: "第二步的原文", observation: { stdout: "", stderr: "编译错误\n", exitCode: 1 } },
  ]);
  expect(history.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  // 原文不改写:一个字都不动。
  expect(history[2]?.content).toBe("第一步的原文");
  expect(history[4]?.content).toBe("第二步的原文");
  // 观测的角色是 user(不走 tool-calling,没有 id 可配对)。
  expect(history[3]).toEqual({
    role: "user",
    content: "exit code: 0\n[stdout]\na\n\n[stderr]\n(empty)",
  });
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
    { raw: "```bash\nls\n```", observation: { stdout: "", stderr: "", exitCode: 0 }, reasoning },
  ]);
  const assistant = history[2];
  expect(assistant?.content).toBe("```bash\nls\n```");
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
