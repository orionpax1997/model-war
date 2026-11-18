/**
 * loop 骨架的单测:全部终止分支 + 历史形状 + 单入口计数 + 截断重试归并 + 配额拒绝可见。
 *
 * 三样都是**假**的:模型(`stubClient`)、执行器、时钟。所以这些用例不启动 bwrap、不联网,
 * 也因此能逐字断言「发出去的到底是什么」「落下来的是什么」——history 与 steps 都在 loop 的
 * 输出面上,不需要读它的内部。
 */

import { expect, it } from "vitest";

import type { ChatMessage, ModelResponse } from "../model-client.js";
import { fail, reply, stubClient } from "../stub-client.js";
import { ACTION_REJECT_EXIT_CODE } from "./action.js";
import { AGENT_MAX_STEPS } from "./limits.js";
import {
  ACTION_PARSE_FAILURE_LIMIT,
  hasCandidates,
  runAgentSession,
  type AgentLoopRequest,
} from "./loop.js";
import { OBSERVATION_LIMITS, TRUNCATED_RESPONSE_FEEDBACK } from "./truncate.js";
import type { AgentExecRequest, AgentExecResult } from "./types.js";

const SYSTEM = "协议:每一步一个动作块";
const FIRST_USER = "任务:/workspace 里写 script.ts";

/** 一条合法动作。 */
const ACTION = "```bash\nls /contract\n```";

/** 一次「真评出成绩」的 evaluate 交回的提交身份:候选的两半里,loop 只搬运这一半。 */
const SUBMISSION = {
  scriptSha256: "0".repeat(64),
  hostPath: "/tmp/ws/script.ts",
  observationsPath: "/workspace/.observations/1.md",
  tscVersion: "7.0.2",
};

/** 假执行器:按序回放结果,并把每次请求原样记下来。 */
const fakeExecutor = (steps: readonly (AgentExecResult | (() => AgentExecResult))[]) => {
  const requests: AgentExecRequest[] = [];
  const executor = async (request: AgentExecRequest): Promise<AgentExecResult> => {
    requests.push(request);
    const next = steps[requests.length - 1];
    if (next === undefined) {
      throw new Error(`假执行器剧本已用尽:第 ${String(requests.length)} 次调用`);
    }
    return typeof next === "function" ? next() : next;
  };
  return { requests, executor };
};

const OK: AgentExecResult = { stdout: "", stderr: "", exitCode: 0 };

/** 手控时钟:只在测试显式推进时前进,于是墙钟边界是确定的。 */
const clockOf = () => {
  let elapsed = 0;
  return {
    now: () => elapsed,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
};

const requestOf = (
  input: Partial<AgentLoopRequest> & Pick<AgentLoopRequest, "model">,
): AgentLoopRequest => ({
  executor: fakeExecutor([]).executor,
  system: SYSTEM,
  firstUser: FIRST_USER,
  ...input,
});

it("`done` 停:动作照跑、步照记,终止原因是 done", async () => {
  const model = stubClient([reply(ACTION), reply("```bash\ndone\n```")]);
  const executor = fakeExecutor([OK, { ...OK, done: true }]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(result.termination).toBe("done");
  expect(result.atStep).toBe(2);
  expect(result.steps.map((step) => step.action)).toEqual([
    { kind: "bash", command: "ls /contract" },
    { kind: "done" },
  ]);
  expect(result.prompts).toEqual([FIRST_USER]);
});

it("步数耗尽:max-steps,步号等于上限,不多打一次模型", async () => {
  const model = stubClient([reply(ACTION), reply(ACTION)]);
  const executor = fakeExecutor([OK, OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 2 }),
  );

  expect(result.termination).toBe("max-steps");
  expect(result.atStep).toBe(2);
  expect(result.steps).toHaveLength(2);
  expect(model.calls).toHaveLength(2);
});

it("总墙钟耗尽:下一步开始前就停下,不把已跑完的步算丢", async () => {
  const clock = clockOf();
  const model = stubClient([reply(ACTION), reply(ACTION), reply(ACTION), reply(ACTION)]);
  const executor = fakeExecutor([
    () => {
      clock.advance(200);
      return OK;
    },
    () => {
      clock.advance(200);
      return OK;
    },
    () => {
      clock.advance(200);
      return OK;
    },
  ]);
  const result = await runAgentSession(
    requestOf({
      model,
      executor: executor.executor,
      totalWallClockMs: 500,
      maxSteps: 10,
      now: clock.now,
    }),
  );

  // 600 ms 时第四次调用前判超时:前三步留下,第四步从未发生。
  expect(result.termination).toBe("wall-clock");
  expect(result.atStep).toBe(3);
  expect(result.steps).toHaveLength(3);
  expect(model.calls).toHaveLength(3);
});

it("上下文守卫:上一轮读数到窗口 80% 即停,不是估算", async () => {
  const model = stubClient([reply(ACTION, { usage: { prompt_tokens: 8_000 } }), reply(ACTION)]);
  const executor = fakeExecutor([OK]);
  const result = await runAgentSession(
    requestOf({
      model,
      executor: executor.executor,
      contextLength: 10_000,
      maxSteps: 10,
    }),
  );

  // 8000 × 5 = 40000 = 10000 × 4:恰好落在边界上就停。
  expect(result.termination).toBe("context");
  expect(result.atStep).toBe(1);
  expect(result.steps).toHaveLength(1);
  expect(model.calls).toHaveLength(1);
});

it("读数没到 80% 时不触发守卫", async () => {
  const model = stubClient([reply(ACTION, { usage: { prompt_tokens: 7_999 } }), reply(ACTION)]);
  const executor = fakeExecutor([OK, OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, contextLength: 10_000, maxSteps: 2 }),
  );
  expect(result.termination).toBe("max-steps");
  expect(result.steps).toHaveLength(2);
});

it("连续三次动作解析失败即停:每一次都记成非零退出码的步,一条命令都没跑", async () => {
  const model = stubClient([reply("只说不动"), reply("```ts\nconst x = 1\n```"), reply("")]);
  const executor = fakeExecutor([]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 10 }),
  );

  expect(ACTION_PARSE_FAILURE_LIMIT).toBe(3);
  expect(result.termination).toBe("action-parse");
  expect(result.atStep).toBe(3);
  expect(result.steps).toHaveLength(3);
  expect(executor.requests).toHaveLength(0);
  for (const step of result.steps) {
    expect(step.action).toEqual({ kind: "none" });
    expect(step.exitCode).toBe(ACTION_REJECT_EXIT_CODE);
    expect(step.stderr).toContain("恰好一个");
  }
  // 纠正消息进了历史,模型下一步能看见自己违反了哪一条(逐次累积)。
  expect(model.calls[1]?.messages.at(-1)?.role).toBe("user");
  expect(model.calls[1]?.messages.at(-1)?.content).toContain("没有 ```bash 代码块");
  expect(model.calls[2]?.messages.at(-1)?.content).toContain("它的标记是 ```ts,不是 ```bash");
});

it("解析失败不是「连续」时清零:两次失败一次成功,不会停在第三次失败上", async () => {
  const model = stubClient([
    reply("只说不动"),
    reply("只说不动"),
    reply(ACTION),
    reply("只说不动"),
    reply("只说不动"),
    reply(ACTION),
  ]);
  const executor = fakeExecutor([OK, OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 6 }),
  );
  expect(result.termination).toBe("max-steps");
  expect(result.steps).toHaveLength(6);
});

it("传输耗尽立即停:那次调用不进过程记录、不进协议轮数,零步会话的 prompt 为空", async () => {
  const model = stubClient([fail(new Error("ECONNRESET"))]);
  const result = await runAgentSession(requestOf({ model, executor: fakeExecutor([]).executor }));

  expect(result.termination).toBe("transport");
  expect(result.atStep).toBe(0);
  expect(result.steps).toEqual([]);
  expect(result.prompts).toEqual([]);
  expect(result.turns).toEqual([{ kind: "transport", round: 1, attempts: 1 }]);
});

it("跑过几步之后才传输耗尽:已跑完的步留着,传输末行不进 steps", async () => {
  const model = stubClient([reply(ACTION), fail(new Error("ECONNRESET"))]);
  const executor = fakeExecutor([OK]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(result.termination).toBe("transport");
  expect(result.atStep).toBe(1);
  expect(result.steps).toHaveLength(1);
  expect(result.turns.map((turn) => turn.kind)).toEqual(["response", "transport"]);
  expect(result.prompts).toEqual([FIRST_USER]);
});

it("截断重试并入同一步:第二次成功就照常执行,attempts 是 2", async () => {
  const model = stubClient([
    reply("```bash\nls /contract", { finishReason: "length" }),
    reply(ACTION),
  ]);
  const executor = fakeExecutor([OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 1 }),
  );

  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]?.action).toEqual({ kind: "bash", command: "ls /contract" });
  expect(result.turns).toEqual([
    {
      kind: "response",
      round: 1,
      attempts: 2,
      finishReason: "stop",
      usage: {},
      sendMs: 0,
    },
  ]);
  // 第一次被截断的响应没有执行,执行的只有第二次那一块。
  expect(executor.requests).toHaveLength(1);
});

it("第二次仍截断:转格式反馈,不执行也不退避,步照记", async () => {
  const model = stubClient([
    reply("```bash\nls", { finishReason: "length" }),
    reply("```bash\nls", { finishReason: "length" }),
  ]);
  const executor = fakeExecutor([]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 1 }),
  );

  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]?.action).toEqual({ kind: "none" });
  expect(result.steps[0]?.stderr).toBe(TRUNCATED_RESPONSE_FEEDBACK);
  expect(result.steps[0]?.exitCode).toBe(ACTION_REJECT_EXIT_CODE);
  expect(executor.requests).toHaveLength(0);
  expect(result.turns[0]).toMatchObject({ attempts: 2, finishReason: "length" });
  expect(result.termination).toBe("max-steps");
});

it("历史形状:system + 首条 user + 每步一对,原文不改写", async () => {
  const model = stubClient([reply(ACTION), reply(ACTION), reply("```bash\ndone\n```")]);
  const executor = fakeExecutor([
    { stdout: "README\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "error TS2322\n", exitCode: 1 },
    { ...OK, done: true },
  ]);
  await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(model.calls[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(model.calls[1]?.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
  expect(model.calls[2]?.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  // assistant 那一条是模型当时写的原文。
  expect(model.calls[2]?.messages[4]?.content).toBe(ACTION);
  // 观测那一条带上了落盘的字节。
  expect(model.calls[2]?.messages[5]?.content).toContain("error TS2322");
});

it("steps 条数 = 协议轮数 = 响应条数,且首条 prompt 只存一份", async () => {
  const model = stubClient([reply(ACTION), reply(ACTION), reply("```bash\ndone\n```")]);
  const executor = fakeExecutor([OK, OK, { ...OK, done: true }]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(result.steps).toHaveLength(3);
  expect(result.turns.filter((turn) => turn.kind === "response")).toHaveLength(3);
  expect(result.turns.map((turn) => (turn.kind === "response" ? turn.round : undefined))).toEqual([
    1, 2, 3,
  ]);
  expect(result.prompts).toEqual([FIRST_USER]);
});

it("观测截断在生成侧:落盘的字节就是模型看到的字节", async () => {
  const huge = "x".repeat(20_000);
  const model = stubClient([reply(ACTION)]);
  const executor = fakeExecutor([{ stdout: huge, stderr: "", exitCode: 0 }]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 1 }),
  );

  const step = result.steps[0];
  expect(step?.stdout).toContain("[观测被截断]");
  expect(Buffer.byteLength(step?.stdout ?? "", "utf8")).toBeLessThan(
    OBSERVATION_LIMITS.stdout.limitBytes + 2_000,
  );
  // 原文不截断(20 KB 远低于病态保护的 64 KiB)。
  expect(step?.raw).toBe(ACTION);
});

it("配额拒绝是模型可见的:宿主伪造的那条 stderr 原样进观测", async () => {
  const refusal = "evaluate: 配额已用尽(3/3),这一次没有执行。";
  const model = stubClient([reply("```bash\nevaluate\n```"), reply("```bash\ndone\n```")]);
  const executor = fakeExecutor([
    { stdout: "", stderr: refusal, exitCode: 1 },
    { ...OK, done: true },
  ]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(result.steps[0]?.action).toEqual({ kind: "evaluate" });
  expect(result.steps[0]?.stderr).toBe(refusal);
  // 被拒的那一次没有提交身份:配额没用掉,也没有成绩。
  expect(result.submissions).toEqual([]);
  // 下一步的观测里就有它:模型看得到「我这次评测没执行」。
  expect(model.calls[1]?.messages.at(-1)?.content).toContain(refusal);
});

it("一次真评出成绩的 evaluate 把提交身份记下来,步号即候选条目的步号", async () => {
  const model = stubClient([reply("```bash\nevaluate\n```")]);
  const executor = fakeExecutor([{ ...OK, submission: SUBMISSION, evaluateCall: 1 }]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 1 }),
  );
  // loop 只搬运:候选的 score 与 matchCount 归网格(`scoreFromCandidateEvidence`),它一个字都不猜。
  expect(result.submissions).toEqual([{ step: 1, call: 1, ...SUBMISSION }]);
});

it("解析层的 done 行号原样递给执行器(块内 first 行 = 0 起)", async () => {
  const model = stubClient([reply("```bash\nevaluate\ndone\necho 不该跑\n```")]);
  const executor = fakeExecutor([{ ...OK, done: true }]);
  await runAgentSession(requestOf({ model, executor: executor.executor }));

  expect(executor.requests[0]).toMatchObject({
    step: 1,
    command: "evaluate\ndone\necho 不该跑",
    doneAtLine: 1,
  });
});

it("结果侧证据原样落步,没有结果时不写空壳", async () => {
  const model = stubClient([reply(ACTION), reply(ACTION)]);
  const executor = fakeExecutor([{ ...OK, result: { kind: "tsc", errorCodes: ["TS2322"] } }, OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 2 }),
  );
  expect(result.steps[0]?.result).toEqual({ kind: "tsc", errorCodes: ["TS2322"] });
  expect("result" in (result.steps[1] ?? {})).toBe(false);
});

it("原文与发回去的字节同源:病态保护生效时两处仍是同一份", async () => {
  const huge = `\`\`\`bash\n${"x".repeat(70_000)}\n\`\`\``;
  const calls: (readonly ChatMessage[])[] = [];
  const responses: ModelResponse[] = [
    { text: huge, finishReason: "stop", usage: {} },
    { text: "```bash\ndone\n```", finishReason: "stop", usage: {} },
  ];
  const model = {
    send: async (messages: readonly ChatMessage[]): Promise<ModelResponse> => {
      calls.push([...messages]);
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error("剧本已用尽");
      return next;
    },
  };
  const executor = fakeExecutor([OK, { ...OK, done: true }]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  const raw = result.steps[0]?.raw ?? "";
  expect(raw).toContain("病态保护上限");
  // 落盘的那一份与下一步发回去的那一份逐字节相同(不是「两份都各自 clamp 过」)。
  expect(calls[1]?.[2]?.content).toBe(raw);
  // 观测仍是完整跑出来的输出,没有被原文的病态保护牵连。
  expect(result.steps[0]?.stdout).toBe("");
});

it("推理随消息带走但不落过程记录", async () => {
  const reasoning: ModelResponse["reasoning"] = {
    carry: "signed",
    blocks: [{ type: "thinking", thinking: "内部推理", signature: "sig-loop" }],
    dropped: 0,
  };
  const calls: (readonly ChatMessage[])[] = [];
  const responses: ModelResponse[] = [
    { text: ACTION, finishReason: "stop", usage: {}, reasoning },
    { text: "```bash\ndone\n```", finishReason: "stop", usage: {} },
  ];
  const model = {
    send: async (messages: readonly ChatMessage[]): Promise<ModelResponse> => {
      calls.push([...messages]);
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error("剧本已用尽");
      return next;
    },
  };
  const executor = fakeExecutor([OK, { ...OK, done: true }]);
  const result = await runAgentSession(requestOf({ model, executor: executor.executor }));

  // 第二步发出去的历史里,assistant 带着那一份不透明推理。
  expect(calls[1]?.[2]?.reasoning).toEqual(reasoning);
  // 但它不进过程记录:签名与加密块对读侧没有意义,也不该涨档案体积。
  expect(JSON.stringify(result.steps)).not.toContain("sig-loop");
});

it("执行器起不来是基础设施失败:直接抛,不折成一条「模型写错了」的观测", async () => {
  const model = stubClient([reply(ACTION)]);
  const executor = async (): Promise<AgentExecResult> => {
    throw new Error("沙箱执行器起不来");
  };
  await expect(runAgentSession(requestOf({ model, executor }))).rejects.toThrow(/沙箱执行器起不来/);
});

it("单入口与调用计数:有动作的步数 == 执行器被调用次数 == 模型被调用次数", async () => {
  const model = stubClient([reply(ACTION), reply(ACTION), reply(ACTION)]);
  const executor = fakeExecutor([OK, OK, OK]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 3 }),
  );

  expect(result.steps).toHaveLength(3);
  expect(executor.requests).toHaveLength(3);
  expect(model.calls).toHaveLength(3);
  // 步号从 1 起、连续、与协议轮号一一对应(报告侧左连接的前提)。
  expect(executor.requests.map((request) => request.step)).toEqual([1, 2, 3]);
  expect(result.turns.map((turn) => (turn.kind === "response" ? turn.round : -1))).toEqual([
    1, 2, 3,
  ]);
});

it("零步会话:maxSteps 为 0 时一次调用都没有,形状仍然合法", async () => {
  const model = stubClient([]);
  const result = await runAgentSession(
    requestOf({ model, executor: fakeExecutor([]).executor, maxSteps: 0 }),
  );

  expect(result.termination).toBe("max-steps");
  expect(result.atStep).toBe(0);
  expect(result.steps).toEqual([]);
  expect(result.prompts).toEqual([]);
  expect(model.calls).toHaveLength(0);
});

it("atMs 是相对会话起点的偏移,harnessMs 是 sendMs 的补集", async () => {
  const clock = clockOf();
  const model = {
    send: async (): Promise<ModelResponse> => {
      clock.advance(100);
      return { text: ACTION, finishReason: "stop", usage: {} };
    },
  };
  const executor = fakeExecutor([
    () => {
      clock.advance(30);
      return OK;
    },
    () => {
      clock.advance(30);
      return OK;
    },
  ]);
  const result = await runAgentSession(
    requestOf({ model, executor: executor.executor, maxSteps: 2, now: clock.now }),
  );

  // 第一步:起点 0,模型 100ms,沙箱 30ms。
  expect(result.steps[0]).toMatchObject({ atMs: 0, harnessMs: 30 });
  // 第二步:起点就是第一步结束的时刻(130)。
  expect(result.steps[1]).toMatchObject({ atMs: 130, harnessMs: 30 });
  // sendMs + harnessMs 就是整步。
  for (const [index, step] of result.steps.entries()) {
    const turn = result.turns[index];
    expect(turn?.kind).toBe("response");
    if (turn?.kind !== "response") return;
    const nextAt = result.steps[index + 1]?.atMs;
    if (nextAt !== undefined) {
      expect(nextAt - step.atMs).toBe(turn.sendMs + step.harnessMs);
    }
  }
});

it("默认步数上限取自常量(不在这里写第二个 120)", async () => {
  expect(AGENT_MAX_STEPS).toBe(120);
});

it("有没有候选就是成功档与失败档的分界(与终止原因无关)", async () => {
  const model = stubClient([reply("```bash\nevaluate\n```")]);
  const withCandidate = await runAgentSession(
    requestOf({
      model,
      maxSteps: 1,
      executor: fakeExecutor([{ ...OK, submission: SUBMISSION, evaluateCall: 1 }]).executor,
    }),
  );
  expect(hasCandidates(withCandidate)).toBe(true);

  const empty = await runAgentSession(
    requestOf({
      model: stubClient([reply(ACTION)]),
      maxSteps: 1,
      executor: fakeExecutor([OK]).executor,
    }),
  );
  expect(empty.termination).toBe("max-steps");
  expect(hasCandidates(empty)).toBe(false);
});

it("截断重试那一枪死在连接上:transport 末行仍记下用了两枪", async () => {
  const model = stubClient([
    reply("```bash\nls", { finishReason: "length" }),
    fail(new Error("ECONNRESET")),
  ]);
  const result = await runAgentSession(requestOf({ model, executor: fakeExecutor([]).executor }));

  expect(result.termination).toBe("transport");
  expect(result.steps).toEqual([]);
  // 与「一枪就死」在诊断上是两件事:后者是运气,前者先说「模型话太多」。
  expect(result.turns).toEqual([{ kind: "transport", round: 1, attempts: 2 }]);
});
