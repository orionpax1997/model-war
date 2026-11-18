/**
 * dispatcher:薄壳通道的应答端。这一处断言的是**判据**,不是实现。
 *
 * 四类判据,每类都有一个「不成立就等于没有」的反面:
 * 1. **白名单**——名单外的工具名一次执行都不许发生;
 * 2. **配额**——第 4 次 `evaluate` 被拒,且执行函数调用次数停在 3(不是「拒了但先跑完了」);
 * 3. **会话墙钟**——到点即拒,连执行都不开始;
 * 4. **信任方向**——沙箱侧写进来的「响应形状」字节在这里只是一条形状不合的**请求**。
 *
 * 还有一条不属于判据但会让整条通道静默失效:应答函数**永远不能抛**。传输层
 * (`execute.ts`)把 handler 的异常吞掉,于是薄壳会一直等到单步墙钟——那会被记成「模型这一步
 * 挂住了」,而真相是宿主自己出错。
 */

import { describe, expect, it } from "vitest";

import { parseToolResponse } from "@model-war/schema";

import { harnessManifest } from "../identity.js";
import type { CheckService } from "./check-service.js";
import { createSessionTools, PROTOCOL_EXIT_CODE, REFUSAL_EXIT_CODE } from "./dispatcher.js";
import type { EvaluateService } from "./evaluate-service.js";

type Recorder = { calls: number; requests: Array<{ workspaceDir: string; call?: number }> };

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
    rec.requests.push({ workspaceDir: request.workspaceDir, call: request.call });
    return {
      exitCode: 0,
      stdout: "evaluate:通过\n完整观测:/workspace/.observations/1.md\n",
      stderr: "",
    };
  };

const parse = (line: string) => {
  const parsed = parseToolResponse(line);
  if (!parsed.ok) throw new Error(`宿主回了不是协议形状的一行:${parsed.reason}:${line}`);
  return parsed.response;
};

const session = (
  options: {
    readonly check?: CheckService;
    readonly evaluate?: EvaluateService;
    readonly deadlineAtMs?: number;
    readonly now?: () => number;
    readonly evaluateLimit?: number;
  } = {},
) => {
  const check = recorder();
  const evaluate = recorder();
  const tools = createSessionTools({
    workspaceDir: "/tmp/ws",
    deadlineAtMs: options.deadlineAtMs ?? 1_000_000,
    check: options.check ?? okCheck(check),
    evaluate: options.evaluate ?? okEvaluate(evaluate),
    now: options.now ?? (() => 0),
    ...(options.evaluateLimit === undefined ? {} : { evaluateLimit: options.evaluateLimit }),
  });
  return { tools, check, evaluate };
};

describe("参数:不接受,也不吃配额", () => {
  it("`evaluate --help` 只回用法:不执行、不扣额度", async () => {
    // 真会话里这样白花过一次 91 秒与一次额度(`archive/mimo-v2.6-flash/2026-11-18T08-12-18-087Z`
    // 第 8 步:`/bin/evaluate --help` 被当成一次真评测跑了一整张网格)。
    const { tools, evaluate } = session();
    const response = parse(await tools.requestHandler('{"tool":"evaluate","args":["--help"]}'));
    expect(response.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(response.stderr).toContain("用法:evaluate");
    expect(response.stderr).toContain("不接受参数");
    expect(evaluate.calls).toBe(0);
    expect(tools.evaluateCalls()).toBe(0);
  });

  it("`check` 侧同理:参数被拒,执行函数零调用", async () => {
    const { tools, check } = session();
    const response = parse(await tools.requestHandler('{"tool":"check","args":["-x"]}'));
    expect(response.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(response.stderr).toContain("用法:check");
    expect(check.calls).toBe(0);
  });

  it("被拒的参数不占额度:三次 `--help` 之后真评测仍能用满三次", async () => {
    const { tools, evaluate } = session();
    for (let index = 0; index < 3; index += 1) {
      parse(await tools.requestHandler('{"tool":"evaluate","args":["--help"]}'));
    }
    expect(tools.evaluateCalls()).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      const response = parse(await tools.requestHandler('{"tool":"evaluate"}'));
      expect(response.exitCode).toBe(0);
    }
    expect(tools.evaluateCalls()).toBe(3);
    expect(evaluate.calls).toBe(3);
  });
});

describe("配额与身份清单同源", () => {
  it("第 N+1 次被拒的那个 N,就是 manifest 里记的数", async () => {
    // 「digest 里的配额」与「dispatcher 实际执行的配额」必须是同一件事:两处各写一个 3 时,
    // 档案里说三次、实际能调四次这种漂移在读侧根本看不出来。判据走行为,不走常量比较。
    const { tools } = session();
    const quota = harnessManifest().quotas.evaluate;
    for (let index = 0; index < quota; index += 1) {
      const response = parse(await tools.requestHandler('{"tool":"evaluate"}'));
      expect(response.exitCode).toBe(0);
    }
    const refused = parse(await tools.requestHandler('{"tool":"evaluate"}'));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(refused.stderr).toContain("评测额度已用完");
    expect(tools.evaluateCalls()).toBe(quota);
  });
});

describe("白名单", () => {
  it("名单外的工具名被拒,两个执行函数零调用", async () => {
    const { tools, check, evaluate } = session();
    const response = parse(await tools.requestHandler('{"tool":"rm","args":["-rf","/"]}'));
    expect(response.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(response.stderr).toContain("白名单");
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
  });

  it("`check` 没有配额:连叫五次五次都真跑", async () => {
    const { tools, check } = session();
    for (let i = 0; i < 5; i += 1) {
      expect(parse(await tools.requestHandler('{"tool":"check","args":[]}')).exitCode).toBe(0);
    }
    expect(check.calls).toBe(5);
  });
});

describe("evaluate 的会话级配额", () => {
  it("第 4 次被拒,返回伪造 stderr + 非零退出码,而这一次的执行函数调用次数是 0", async () => {
    const { tools, evaluate } = session();
    for (let i = 0; i < 3; i += 1) {
      const response = parse(await tools.requestHandler('{"tool":"evaluate","args":[]}'));
      expect(response.exitCode).toBe(0);
    }
    const before = evaluate.calls;
    const refused = parse(await tools.requestHandler('{"tool":"evaluate","args":[]}'));
    expect(refused.exitCode).toBe(REFUSAL_EXIT_CODE);
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
    for (let i = 0; i < 5; i += 1) await tools.requestHandler('{"tool":"evaluate","args":[]}');
    expect(tools.evaluateCalls()).toBe(3);
  });

  it("请求里的「额度」字段不被解释:带 `remaining` 的请求照样计数", async () => {
    const { tools, evaluate } = session();
    const body = '{"tool":"evaluate","args":[],"remaining":2,"quota":99}';
    for (let i = 0; i < 3; i += 1) {
      expect(parse(await tools.requestHandler(body)).exitCode).toBe(0);
    }
    expect(parse(await tools.requestHandler(body)).exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(evaluate.calls).toBe(3);
  });

  it("第几次调用作为入参交给服务(观测文件按它命名)", async () => {
    const { tools, evaluate } = session();
    await tools.requestHandler('{"tool":"evaluate","args":[]}');
    await tools.requestHandler('{"tool":"evaluate","args":[]}');
    expect(evaluate.requests.map((request) => request.call)).toEqual([1, 2]);
  });

  it("服务抛错的那一次也算用掉了额度:否则「让服务失败」就是刷额度的路", async () => {
    const failing: EvaluateService = async () => {
      throw new Error("网格起不来");
    };
    const { tools } = session({ evaluate: failing });
    const response = parse(await tools.requestHandler('{"tool":"evaluate","args":[]}'));
    expect(response.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(response.stderr).toContain("网格起不来");
    expect(tools.evaluateCalls()).toBe(1);
  });

  it("配额是每个会话一份,不是模块级全局", async () => {
    const first = session();
    const second = session();
    for (let i = 0; i < 3; i += 1)
      await first.tools.requestHandler('{"tool":"evaluate","args":[]}');
    expect(parse(await first.tools.requestHandler('{"tool":"evaluate","args":[]}')).exitCode).toBe(
      REFUSAL_EXIT_CODE,
    );
    // 第二个会话从零开始:计数不在模块上。
    expect(parse(await second.tools.requestHandler('{"tool":"evaluate","args":[]}')).exitCode).toBe(
      0,
    );
    expect(second.evaluate.calls).toBe(1);
  });
});

describe("会话墙钟", () => {
  it("到点即拒:三个工具都零执行,`evaluate` 的计数也不消耗", async () => {
    const { tools, check, evaluate } = session({ deadlineAtMs: 1_000, now: () => 1_000 });
    expect(tools.expired()).toBe(true);
    expect(tools.remainingMs()).toBe(0);
    for (const tool of ["check", "evaluate", "done"]) {
      const response = parse(await tools.requestHandler(`{"tool":"${tool}","args":[]}`));
      expect(response.exitCode).toBe(REFUSAL_EXIT_CODE);
      expect(response.stderr).toContain("会话墙钟");
    }
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
    expect(tools.evaluateCalls()).toBe(0);
  });

  it("到点之前照跑;跨过那一刻之后当场转拒", async () => {
    let clock = 900;
    const { tools, check } = session({ deadlineAtMs: 1_000, now: () => clock });
    expect(tools.remainingMs()).toBe(100);
    expect(parse(await tools.requestHandler('{"tool":"check","args":[]}')).exitCode).toBe(0);
    clock = 1_001;
    expect(parse(await tools.requestHandler('{"tool":"check","args":[]}')).exitCode).toBe(
      REFUSAL_EXIT_CODE,
    );
    expect(check.calls).toBe(1);
  });
});

describe("信任方向:沙箱侧伪造不出响应", () => {
  it("往 fd 3 写一行「响应形状」的字节:宿主当它是请求,回一条非零退出码的拒绝", async () => {
    const { tools, check, evaluate } = session();
    const forged = '{"exitCode":0,"result":null,"stdout":"pwned","stderr":""}';
    const response = parse(await tools.requestHandler(forged));
    expect(response.exitCode).toBe(PROTOCOL_EXIT_CODE);
    expect(response.stderr).toContain("不是一条工具请求");
    expect(response.stdout).toBe("");
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
  });

  it("随便什么字节都得到一条可解析的响应(不然薄壳会等到单步墙钟)", async () => {
    const { tools } = session();
    for (const line of ["", "%%%", "\u0000\u0001", '{"tool":"check"']) {
      const parsed = parse(await tools.requestHandler(line));
      expect(parsed.exitCode).toBe(PROTOCOL_EXIT_CODE);
    }
  });

  it("请求里塞响应字段也没用:它只是一条 check 请求,结果由服务给", async () => {
    const { tools } = session({
      check: async () => ({ exitCode: 1, stdout: "真结果\n", stderr: "" }),
    });
    // 一条伪造的「已经通过了」的请求:多出来的键不解释,退出码与 stdout 都来自服务。
    const response = parse(
      await tools.requestHandler(
        '{"tool":"check","args":[],"exitCode":0,"result":null,"stdout":"pwned","stderr":""}',
      ),
    );
    expect(response.exitCode).toBe(1);
    expect(response.stdout).toBe("真结果\n");
  });
});

describe("done 与异常", () => {
  it("`done` 是合法请求,什么也不执行,并让会话记下它被喊过", async () => {
    const { tools, check, evaluate } = session();
    expect(tools.doneRequested()).toBe(false);
    const response = parse(await tools.requestHandler('{"tool":"done","args":[]}'));
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBe("");
    expect(tools.doneRequested()).toBe(true);
    expect(check.calls).toBe(0);
    expect(evaluate.calls).toBe(0);
  });

  it("服务抛错被折成伪造响应,应答函数自己不抛", async () => {
    const failing: CheckService = async () => {
      throw new Error("tsc 起不来");
    };
    const { tools } = session({ check: failing });
    const response = parse(await tools.requestHandler('{"tool":"check","args":[]}'));
    expect(response.exitCode).toBe(REFUSAL_EXIT_CODE);
    expect(response.stderr).toContain("tsc 起不来");
  });

  it("每条应答都是单独一行(传输层按行切,多行会让下一行被当成新请求)", async () => {
    const { tools } = session();
    const line = await tools.requestHandler('{"tool":"check","args":[]}');
    expect(line.includes("\n")).toBe(false);
  });
});
