/**
 * dispatcher:工具调用的受理端。这一处断言的是**判据**,不是实现。
 *
 * 五类判据,每类都有一个「不成立就等于没有」的反面:
 * 1. **白名单**——名单外的工具名一次执行都不许发生,而且被拒的那一次不落进 `finish`;
 * 2. **配额**——第 4 次 `evaluate` 被拒,且执行函数调用次数停在 3(不是「拒了但先跑完了」);
 * 3. **会话墙钟**——到点即拒,连执行都不开始;
 * 4. **参数面**——四个不收参数的工具收到参数就是被拒,不执行、不吃配额;
 * 5. **失败是 `isError`,不是伪造退出码**——拒绝与「命令跑了但非零退出」在这里分开。
 *
 * 还有一条不属于判据但会让整条分派静默失效:应答函数**永远不能抛**。异常折成一条
 * `isError: true` 的结果,带着它自己的那句话;抛出去会让执行器把「服务坏了」记成「模型这一步
 * 挂了」,而两者的处方完全不同。
 *
 * ── 为什么这里没有「沙箱伪造不出响应」那一组 ──
 *
 * 那一组测的是 fd 3 通道的信任方向:沙箱侧往通道里写「响应形状」的字节,宿主只当它是请求。
 * 通道已删除(票 03),模型手上没有那条 fd,也没有往宿主的请求里塞字节的路——它只能发一次
 * 结构化的工具调用。判据的对象不存在了,用例随之消失,而不是「少测了」。
 */

import { describe, expect, it } from "vitest";

import { PROBE_CALL_LIMIT } from "@model-war/schema";

import { harnessManifest } from "../identity.js";
import type { ToolCall } from "../tools.js";
import type { CheckService } from "./check-service.js";
import {
  createSessionTools,
  PROBE_QUOTA_EXHAUSTED_MESSAGE,
  PROTOCOL_EXIT_CODE,
  QUOTA_EXHAUSTED_MESSAGE,
  REFUSAL_EXIT_CODE,
  SESSION_EXPIRED_MESSAGE,
  UNKNOWN_TOOL_MESSAGE,
  type SessionTools,
} from "./dispatcher.js";
import type { EvaluateService } from "./evaluate-service.js";
import type { ProbeService } from "./probe-service.js";

type Recorder = {
  calls: number;
  requests: Array<{ workspaceDir: string; call?: number; step?: number }>;
};

const recorder = (): Recorder => ({ calls: 0, requests: [] });

const okCheck =
  (rec: Recorder): CheckService =>
  async (request) => {
    rec.calls += 1;
    rec.requests.push({ workspaceDir: request.workspaceDir });
    return { exitCode: 0, stdout: "类型检查通过(tsc 7.0.2)。\n", stderr: "" };
  };

const okEvaluate =
  (rec: Recorder): EvaluateService =>
  async (request) => {
    rec.calls += 1;
    rec.requests.push({
      workspaceDir: request.workspaceDir,
      call: request.call,
      step: request.step,
    });
    return {
      exitCode: 0,
      stdout: "evaluate:通过\n完整观测:/workspace/.observations/1.md\n",
      stderr: "",
    };
  };

/** 探针服务的桩：记调用次数，回一段三档文案里的"充裕"（形状与真服务一致）。 */
const okProbe =
  (rec: Recorder): ProbeService =>
  async (request) => {
    rec.calls += 1;
    rec.requests.push({ workspaceDir: request.workspaceDir });
    return {
      exitCode: 0,
      stdout: "probe：前 8 场跑完。最坏读数：事件 120/500（24%）。\n",
      stderr: "",
    };
  };

/** 一次工具调用。四个不收参数的工具都用空对象——与动作层放行的形状一致。 */
const callOf = (name: string, argumentsJson = "{}"): ToolCall => ({ name, argumentsJson });

/**
 * 一次分派。步号默认 1:本文件绝大多数判据(白名单、配额、墙钟、参数面)与步号无关,
 * 要步号的用例显式给第二参。
 */
const ask = (tools: SessionTools, call: ToolCall, step = 1) => tools.dispatch(step, call);

const session = (
  options: {
    readonly check?: CheckService;
    readonly evaluate?: EvaluateService;
    readonly probe?: ProbeService;
    readonly deadlineAtMs?: number;
    readonly now?: () => number;
    readonly evaluateLimit?: number;
    readonly probeLimit?: number;
  } = {},
) => {
  const check = recorder();
  const evaluate = recorder();
  const probe = recorder();
  const tools = createSessionTools({
    workspaceDir: "/tmp/ws",
    deadlineAtMs: options.deadlineAtMs ?? 1_000_000,
    check: options.check ?? okCheck(check),
    evaluate: options.evaluate ?? okEvaluate(evaluate),
    probe: options.probe ?? okProbe(probe),
    now: options.now ?? (() => 0),
    ...(options.evaluateLimit === undefined ? {} : { evaluateLimit: options.evaluateLimit }),
    ...(options.probeLimit === undefined ? {} : { probeLimit: options.probeLimit }),
  });
  return { tools, check, evaluate, probe };
};

describe("参数:不接受,也不吃配额", () => {
  it("`evaluate` 带参数只回用法:不执行、不扣额度、标成 isError", async () => {
    // 真会话里这样白花过一次 91 秒与一次额度(`archive/mimo-v2.6-flash/2026-11-18T08-12-18-087Z`
    // 第 8 步:`/bin/evaluate --help` 被当成一次真评测跑了一整张网格)。
    const { tools, evaluate } = session();
    const outcome = await ask(tools, callOf("evaluate", '{"args":["--help"]}'));
    expect(outcome.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("用法:evaluate");
    expect(outcome.stderr).toContain("不接受参数");
    expect(evaluate.calls).toBe(0);
    expect(tools.evaluateCalls()).toBe(0);
  });

  it("`probe` 带参数也只回用法:不执行、不扣探针额度、标成 isError", async () => {
    const { tools, probe } = session();
    const outcome = await ask(tools, callOf("probe", '{"matchLimit":4}'));
    expect(outcome.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("用法:probe");
    expect(outcome.stderr).toContain("不接受参数");
    expect(probe.calls).toBe(0);
    expect(tools.probeCalls()).toBe(0);
  });

  it("`check` 侧同理:参数被拒,执行函数零调用", async () => {
    const { tools, check } = session();
    const outcome = await ask(tools, callOf("check", '{"args":["-x"]}'));
    expect(outcome.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(outcome.stderr).toContain("用法:check");
    expect(check.calls).toBe(0);
  });

  it("`finish` 带参数也被拒:它不置位、不吃任何东西", async () => {
    const { tools } = session();
    const outcome = await ask(tools, callOf("finish", '{"extra":1}'));
    expect(outcome.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("不接受参数");
    // 被拒的收工不是收工。
    expect(tools.finishRequested()).toBe(false);
  });

  it("空串与 `{}` 都算「没带参数」:一条合法调用不会被拒", async () => {
    const { tools, check } = session();
    expect((await ask(tools, callOf("check", ""))).exitCode).toBe(0);
    expect((await ask(tools, callOf("check", "{}"))).exitCode).toBe(0);
    expect(check.calls).toBe(2);
  });

  it("被拒的参数不占额度:三次带参数的 `evaluate` 之后真评测仍能用满三次", async () => {
    const { tools, evaluate } = session();
    for (let index = 0; index < 3; index += 1) {
      await ask(tools, callOf("evaluate", '{"args":["--help"]}'));
    }
    expect(tools.evaluateCalls()).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      expect((await ask(tools, callOf("evaluate"))).exitCode).toBe(0);
    }
    expect(tools.evaluateCalls()).toBe(3);
    expect(evaluate.calls).toBe(3);
  });
});

describe("步号:随调用绑进来,不经过会话级槽位", () => {
  it("第 7 步调 evaluate,服务收到的 `step` 就是 7", async () => {
    // 候选证据族的名字是 `observed-<runId>-round-<步>`。它以前从「当前步」那个槽里读,
    // 正确性靠「先写进去、执行完再取走」的时序——错位时证据会挂到另一步上,而读侧看不出来。
    const { tools, evaluate } = session();
    await ask(tools, callOf("evaluate"), 7);
    expect(evaluate.requests[0]).toEqual({ workspaceDir: "/tmp/ws", call: 1, step: 7 });
  });
});

describe("配额与身份清单同源", () => {
  it("第 N+1 次被拒的那个 N,就是 manifest 里记的数", async () => {
    // 「digest 里的配额」与「dispatcher 实际执行的配额」必须是同一件事:两处各写一个 3 时,
    // 档案里说三次、实际能调四次这种漂移在读侧根本看不出来。判据走行为,不走常量比较。
    const { tools } = session();
    const quota = harnessManifest().quotas.evaluate;
    for (let index = 0; index < quota; index += 1) {
      expect((await ask(tools, callOf("evaluate"))).exitCode).toBe(0);
    }
    const refused = await ask(tools, callOf("evaluate"));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.isError).toBe(true);
    expect(refused.stderr).toContain("评测额度已用完");
    expect(tools.evaluateCalls()).toBe(quota);
  });
});

describe("白名单", () => {
  it("名单外的工具名被拒,两个执行函数零调用,而且不落进 `finish`", async () => {
    const { tools, check, evaluate } = session();
    const outcome = await ask(tools, callOf("rm", '{"args":["-rf","/"]}'));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("白名单");
    expect(outcome.stderr).toContain(UNKNOWN_TOOL_MESSAGE.trim());
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
    expect(tools.finishRequested()).toBe(false);
  });

  it("`bash` 也进不来:它由 loop 交给沙箱,不经宿主分派", async () => {
    const { tools } = session();
    const outcome = await ask(tools, callOf("bash", '{"command":"ls"}'));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
  });

  it("`probe` 没接上执行体时 fail-closed 拒掉,不冒充 `finish`(跨包那条桥的形状)", async () => {
    // 跨包的字面量桥(`packages/tools/src/sandbox-rootfs/executor-bridge.ts`)造工具面时不传
    // `probe`。那条路上它必须**被拒**而不是被当成收工——静默收工看起来完全正常,而模型
    // 那一步其实什么都没做。
    const bare = createSessionTools({
      workspaceDir: "/tmp/ws",
      deadlineAtMs: 1_000_000,
      check: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      evaluate: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      now: () => 0,
    });
    const outcome = await ask(bare, callOf("probe"));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(bare.finishRequested()).toBe(false);
    // 被拒的那一次不是一次调用:计数不涨。
    expect(bare.probeCalls()).toBe(0);
  });

  it("`check` 没有配额:连叫五次五次都真跑,而且都不是 `isError`", async () => {
    const { tools, check } = session();
    for (let i = 0; i < 5; i += 1) {
      const outcome = await ask(tools, callOf("check"));
      expect(outcome.exitCode).toBe(0);
      expect(outcome.isError).toBeUndefined();
    }
    expect(check.calls).toBe(5);
  });
});

describe("evaluate 的会话级配额", () => {
  it("第 4 次被拒:isError、零执行,而且执行函数调用次数停在 3", async () => {
    const { tools, evaluate } = session();
    for (let i = 0; i < 3; i += 1) {
      expect((await ask(tools, callOf("evaluate"))).exitCode).toBe(0);
    }
    const before = evaluate.calls;
    const refused = await ask(tools, callOf("evaluate"));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.isError).toBe(true);
    expect(refused.stderr).toContain("额度已用完");
    expect(refused.stdout).toBe("");
    expect(refused.result).toBeUndefined();
    // 这是本票最重要的一条断言:不是「拒了但仍然跑了一次」——被拒那一次的执行函数调用数就是 0。
    expect(evaluate.calls - before).toBe(0);
    expect(evaluate.calls).toBe(3);
    expect(tools.evaluateCalls()).toBe(3);
  });

  it("配额用完之后再碰一次也不会让计数涨上去(拒绝不消耗额度)", async () => {
    const { tools } = session();
    for (let i = 0; i < 5; i += 1) await ask(tools, callOf("evaluate"));
    expect(tools.evaluateCalls()).toBe(3);
  });

  it("第几次调用作为入参交给服务(观测文件按它命名)", async () => {
    const { tools, evaluate } = session();
    await ask(tools, callOf("evaluate"));
    await ask(tools, callOf("evaluate"));
    expect(evaluate.requests.map((request) => request.call)).toEqual([1, 2]);
  });

  it("服务抛错的那一次也算用掉了额度:否则「让服务失败」就是刷额度的路", async () => {
    // ⚠️ 这条反例是**判据本身**,不是实现细节:计数发生在 `await evaluate(...)` 之前,
    // 所以「让服务抛错」换不来一次免费额度。挪动那一行就会让这条用例红。
    const failing: EvaluateService = async () => {
      throw new Error("网格起不来");
    };
    const { tools } = session({ evaluate: failing });
    const outcome = await ask(tools, callOf("evaluate"));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("网格起不来");
    expect(tools.evaluateCalls()).toBe(1);
  });

  it("配额是每个会话一份,不是模块级全局", async () => {
    const first = session();
    const second = session();
    for (let i = 0; i < 3; i += 1) await ask(first.tools, callOf("evaluate"));
    expect((await ask(first.tools, callOf("evaluate"))).exitCode).toBe(REFUSAL_EXIT_CODE);
    // 第二个会话从零开始:计数不在模块上。
    expect((await ask(second.tools, callOf("evaluate"))).exitCode).toBe(0);
    expect(second.evaluate.calls).toBe(1);
  });
});

describe("会话墙钟", () => {
  it("到点即拒:四个工具都零执行,`evaluate` 的计数也不消耗,`finish` 也不置位", async () => {
    const { tools, check, evaluate, probe } = session({
      deadlineAtMs: 1_000,
      now: () => 1_000,
    });
    expect(tools.expired()).toBe(true);
    expect(tools.remainingMs()).toBe(0);
    for (const tool of ["check", "probe", "evaluate", "finish"]) {
      const outcome = await ask(tools, callOf(tool));
      expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
      expect(outcome.isError).toBe(true);
      expect(outcome.stderr).toContain(SESSION_EXPIRED_MESSAGE.trim());
    }
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
    expect(probe.calls).toBe(0);
    expect(tools.evaluateCalls()).toBe(0);
    expect(tools.probeCalls()).toBe(0);
    // 到点的会话里调 `finish` 不是收工:它没被受理。
    expect(tools.finishRequested()).toBe(false);
  });

  it("到点之前照跑;跨过那一刻之后当场转拒", async () => {
    let clock = 900;
    const { tools, check } = session({ deadlineAtMs: 1_000, now: () => clock });
    expect(tools.remainingMs()).toBe(100);
    expect((await ask(tools, callOf("check"))).exitCode).toBe(0);
    clock = 1_001;
    const refused = await ask(tools, callOf("check"));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.isError).toBe(true);
    expect(check.calls).toBe(1);
  });
});

describe("finish 与异常", () => {
  it("`finish` 是合法调用,什么也不执行,并让会话记下它被受理过", async () => {
    const { tools, check, evaluate } = session();
    expect(tools.finishRequested()).toBe(false);
    const outcome = await ask(tools, callOf("finish"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.isError).toBeUndefined();
    expect(tools.finishRequested()).toBe(true);
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
  });

  it("服务抛错被折成一条 isError 结果,分派函数自己不抛", async () => {
    const failing: CheckService = async () => {
      throw new Error("tsc 起不来");
    };
    const { tools } = session({ check: failing });
    const outcome = await ask(tools, callOf("check"));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("tsc 起不来");
  });

  it("拒绝文案就是送给模型的那一句:`stderr` 以换行收尾,`stdout` 为空", async () => {
    // 这一条钉的是「载体换了、字没换」:旧世界把它塞进一条伪造的命令 stderr,新世界它是一条
    // 被拒的工具调用输出——模型读到的两路文本仍是同一份(观测渲染按这两格走)。
    const { tools } = session();
    const outcome = await ask(tools, callOf("evaluate", '{"x":1}'));
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr.endsWith("\n")).toBe(true);
    expect(outcome.stderr).toContain("evaluate");
  });

  it("配额拒绝的文案与导出常量逐字相同(它是给模型读的,不许在别处另写一份)", async () => {
    const { tools } = session();
    for (let i = 0; i < 3; i += 1) await ask(tools, callOf("evaluate"));
    expect((await ask(tools, callOf("evaluate"))).stderr).toBe(`${QUOTA_EXHAUSTED_MESSAGE}\n`);
  });
});

// ── probe 的额度与「互不侵占」(票 08 判据 4) ─────────────────────────────────
//
// 两条额度各记各的:探针不产出候选、不占 `evaluate` 那三次里的任何一次,反之亦然。
// 计数同样发生在调用**之前**(理由与 evaluate 逐字相同)。

describe("probe 的会话级配额", () => {
  // 身份清单的 `quotas.probe` 那格归票 06(`harnessManifest()` 的形状与 `HARNESS_DIGEST` 是
  // 入库常量,本票不动它)。所以这里判的是**dispatcher 执行的那个常量**本身:两处不许各写一个数。
  it("第 N+1 次被拒的那个 N 就是 PROBE_CALL_LIMIT(执行的那个数)", async () => {
    const { tools, probe } = session();
    const quota = PROBE_CALL_LIMIT;
    for (let index = 0; index < quota; index += 1) {
      expect((await ask(tools, callOf("probe"))).exitCode).toBe(0);
    }
    const refused = await ask(tools, callOf("probe"));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.isError).toBe(true);
    expect(refused.stderr).toContain("探针额度已用完");
    expect(tools.probeCalls()).toBe(quota);
    // 被拒的那一次执行函数零调用。
    expect(probe.calls).toBe(quota);
  });

  it("第 6 次 probe 被拒且**服务未被调用**(不是「拒了但先跑完了」)", async () => {
    const { tools, probe } = session();
    for (let index = 0; index < 5; index += 1) {
      expect((await ask(tools, callOf("probe"))).exitCode).toBe(0);
    }
    const before = probe.calls;
    const refused = await ask(tools, callOf("probe"));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.isError).toBe(true);
    expect(refused.stdout).toBe("");
    expect(probe.calls - before).toBe(0);
    expect(tools.probeCalls()).toBe(5);
    // 文案与导出的常量逐字相同(它是给模型读的,不许在别处另写一份)。
    expect(refused.stderr).toBe(`${PROBE_QUOTA_EXHAUSTED_MESSAGE}\n`);
  });

  it("连续 5 次 probe 之后 evaluateCalls 仍是 0(互不侵占", async () => {
    const { tools, evaluate } = session();
    for (let index = 0; index < 5; index += 1) await ask(tools, callOf("probe"));
    expect(tools.probeCalls()).toBe(5);
    expect(tools.evaluateCalls()).toBe(0);
    expect(evaluate.calls).toBe(0);
    // 三次真评测照样可用满。
    for (let index = 0; index < 3; index += 1) {
      expect((await ask(tools, callOf("evaluate"))).exitCode).toBe(0);
    }
    expect(tools.evaluateCalls()).toBe(3);
  });

  it("连续 3 次 evaluate 之后 probeCalls 仍是 0(反方向同样不侵占)", async () => {
    const { tools } = session();
    for (let index = 0; index < 3; index += 1) await ask(tools, callOf("evaluate"));
    expect(tools.evaluateCalls()).toBe(3);
    expect(tools.probeCalls()).toBe(0);
    for (let index = 0; index < 5; index += 1) {
      expect((await ask(tools, callOf("probe"))).exitCode).toBe(0);
    }
    expect(tools.probeCalls()).toBe(5);
  });

  it("服务抛错的那一次也算用掉了探针额度", async () => {
    const failing: ProbeService = async () => {
      throw new Error("网格起不来");
    };
    const { tools } = session({ probe: failing });
    const outcome = await ask(tools, callOf("probe"));
    expect(outcome.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(outcome.isError).toBe(true);
    expect(outcome.stderr).toContain("网格起不来");
    expect(tools.probeCalls()).toBe(1);
  });
});
