/**
 * 单会话 loop 的骨架:送历史 → 解析动作 → 执行 → 记一步 → 再送(ADR-0032)。
 *
 * ── 它是**替换**,不是包裹 ──
 *
 * 旧外循环的四项产出(阶段推进、反馈轮数、跨阶段复用、网格计划)都是 one-shot 形态的产物,
 * 一个都不在这里。这里只有线性的一串地址:步 → 动作 → 观测 → 下一步。
 *
 * ── 终止原因与落档判据正交 ──
 *
 * 本函数只回答「循环怎么停」(六个取值),不回答「这次会话成功还是失败」:有候选就是成功档,
 * 一个候选都没有就是失败档,与终止原因无关。所以墙钟耗尽不会被判成失败——那是拿资源约束
 * 当成绩判据。
 *
 * ── 一次模型调用 = 一步,截断重试不占步 ──
 *
 * 被输出上限截断时重发一次,两次调用挂在**同一步**的 `attempts` 上(ADR-0035):步钉在「一个
 * 动作加一个观测」上,不是「一次 HTTP 调用」。第二次仍截断就转格式反馈,而不是继续退避——模型
 * 能自我修正,把一个可自我修正的截断升级成整次失败,正好违反上面那条正交性。
 *
 * 传输重试耗尽的那一次调用相反:**不进过程记录、不进协议轮数**,只在 `turns` 里留一条传输末行。
 *
 * ── 本段不启动 bwrap、不联网 ──
 *
 * 执行器是注入的(`AgentExecutor`),模型客户端是注入的(`ModelClient`)。真实接线(沙箱、
 * 宿主服务、网格)在票 03/04/06 的那几侧,本函数不认识它们中的任何一个。
 */

import type { ModelClient, ModelParams, ModelResponse } from "../model-client.js";
import {
  buildHistory,
  type HistorySeed,
  type HistoryTurn,
  type StepObservation,
} from "./history.js";
import { ACTION_REJECT_EXIT_CODE, isEvaluateAction, parseAction } from "./action.js";
import {
  AGENT_MAX_STEPS,
  AGENT_TOTAL_WALL_CLOCK_MS,
  contextGuardTrips,
  inputTokensOf,
} from "./limits.js";
import { clampRaw, truncateObservation, TRUNCATED_RESPONSE_FEEDBACK } from "./truncate.js";
import type {
  AgentExecResult,
  AgentExecutor,
  AgentStep,
  AgentTermination,
  AgentToolHost,
  AgentTurnEvidence,
  EvaluateProbe,
} from "./types.js";
import type { ArchiveStepAction } from "@model-war/schema";

/** 连续几次动作解析失败即停:一次是模型手滑,三次是它没读懂协议。 */
export const ACTION_PARSE_FAILURE_LIMIT = 3;

/** 一次会话的入参。所有缝都注入,所以整条 loop 可以在无网络、无沙箱的机器上被钉住。 */
export type AgentLoopRequest = {
  readonly model: ModelClient;
  readonly executor: AgentExecutor;
  /** `system`:协议(动作语法、`done` 语义)。 */
  readonly system: string;
  /** 首条 `user`:任务、目录与三条硬约束。 */
  readonly firstUser: string;
  readonly params?: ModelParams;
  /** 会话的注入面:宿主服务(fd 3 的端)与评测探针。本段不传。 */
  readonly host?: AgentToolHost;
  /** 模型席位的上下文窗口;缺席即不判守卫(不知道自己离窗口多近)。 */
  readonly contextLength?: number;
  /** 覆盖步数上限(默认 `AGENT_MAX_STEPS`);测试用它把边界压到个位数。 */
  readonly maxSteps?: number;
  /** 覆盖总墙钟(默认 `AGENT_TOTAL_WALL_CLOCK_MS`)。 */
  readonly totalWallClockMs?: number;
  /** 时钟注入缝:默认 `Date.now`。测试用它把墙钟推到边界。 */
  readonly now?: () => number;
};

/** 一次会话的产出。落档那一步(票 07)只填值,不改形状。 */
export type AgentLoopResult = {
  readonly steps: readonly AgentStep[];
  readonly termination: AgentTermination;
  /** 终止发生在第几步(0 = 一次模型调用都没有成功)。 */
  readonly atStep: number;
  /**
   * 起始 prompt:零步会话为空数组、否则一条(ADR-0031)。
   *
   * `prompts` 在分步形态下恢复原始语义——「这个会话是拿哪份 prompt 起的」,而不是「每轮发了
   * 什么」;每轮发了什么由 `steps` 与历史规则确定性还原。
   */
  readonly prompts: readonly string[];
  /** 一步一条的发送侧证据(含那条不进步数的传输末行)。 */
  readonly turns: readonly AgentTurnEvidence[];
  /**
   * 这一步里**真评出过成绩**的那次 `evaluate` 的提交身份(宿主服务的事实,loop 只搬运)。
   *
   * 它与 `steps` 分开走:过程记录记的是「经过」(命令、两路输出、退出码),而提交身份是宿主侧
   * 服务知道的一件**别的**事(评的是哪份字节、观测落在哪)。塞进 `steps` 就要给档案形状加格,
   * 那是票 01 定死的契约;混在 `turns` 里又会让「一次模型调用一行」这条口径失真。
   */
  readonly submissions: readonly AgentSubmission[];
};

/** 一次 `evaluate` 的提交身份:宿主服务算的,按步号与过程记录对起来。 */
export type AgentSubmission = {
  readonly step: number;
  /** 第几次评测(1 起,dispatcher 的计数器)。 */
  readonly call: number;
  readonly scriptSha256: string;
  readonly hostPath: string;
  readonly observationsPath: string;
};

/** 没有动作的那一步:命令一条都没跑,但步数与过程记录照记。 */
const noActionObservation = (message: string): StepObservation => ({
  stdout: "",
  stderr: message,
  exitCode: ACTION_REJECT_EXIT_CODE,
});

/** 一步的动作类别。`evaluate` 只认整块(见 `isEvaluateAction`)。 */
const actionOf = (command: string, done: boolean): ArchiveStepAction =>
  done
    ? { kind: "done" }
    : isEvaluateAction(command)
      ? { kind: "evaluate" }
      : { kind: "bash", command };

/**
 * 把一次执行结果并进一步的记录。
 *
 * 截断在**这里**发生(生成侧):`stdout` / `stderr` 一旦截过,落盘的就是模型看到的那份字节,
 * 观测消息也用它渲染——同一个字节串走两条路,不一致在构造上不可能。
 */
const observationOf = (executed: AgentExecResult): StepObservation => ({
  stdout: truncateObservation("stdout", executed.stdout),
  stderr: truncateObservation("stderr", executed.stderr),
  exitCode: executed.exitCode,
});

/**
 * 跑一场会话。
 *
 * 执行器起不来是**基础设施失败**:`executor` reject 直接向上抛,不折成一次「模型写错了」的
 * 观测——把环境故障解释给模型,等于把归因工作从人挪给模型(ADR-0030 残余风险 3)。
 */
export const runAgentSession = async (request: AgentLoopRequest): Promise<AgentLoopResult> => {
  const now = request.now ?? Date.now;
  const maxSteps = request.maxSteps ?? AGENT_MAX_STEPS;
  const totalWallClockMs = request.totalWallClockMs ?? AGENT_TOTAL_WALL_CLOCK_MS;
  const params = request.params ?? {};
  const seed: HistorySeed = { system: request.system, firstUser: request.firstUser };

  const startedAt = now();
  const steps: AgentStep[] = [];
  const turns: AgentTurnEvidence[] = [];
  const turnHistory: HistoryTurn[] = [];
  const submissions: AgentSubmission[] = [];
  let lastInputTokens: number | undefined;
  let parseFailures = 0;
  let termination: AgentTermination = "max-steps";
  let atStep = 0;

  /** 收口:把终止原因与步号记下来,并交回这一步为止的全部证据。 */
  const settle = (reason: AgentTermination, step: number): AgentLoopResult => ({
    steps,
    termination: reason,
    atStep: step,
    prompts: steps.length === 0 ? [] : [request.firstUser],
    turns,
    submissions,
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    // ① 总墙钟:两项硬约束之一。含退避是另一册的口径(ADR-0036),本段只按注入的时钟判。
    if (now() - startedAt >= totalWallClockMs) {
      termination = "wall-clock";
      atStep = steps.length;
      break;
    }
    // ② 上下文守卫:用上一轮的精确读数,不估算(ADR-0035)。
    if (
      request.contextLength !== undefined &&
      lastInputTokens !== undefined &&
      contextGuardTrips(lastInputTokens, request.contextLength)
    ) {
      termination = "context";
      atStep = steps.length;
      break;
    }

    const turnStart = now();
    const atMs = turnStart - startedAt;
    const history = buildHistory(seed, turnHistory);

    // ③ 调用:截断重发一枪,两枪挂在同一步的 attempts 上。
    let attempts = 1;
    let response: ModelResponse;
    try {
      response = await request.model.send(history, params);
      if (response.finishReason === "length") {
        attempts = 2;
        response = await request.model.send(history, params);
      }
    } catch {
      // 传输重试耗尽(重试预算在传输层,不在 loop):这一次调用不进过程记录、不进协议轮数。
      //
      // `attempts` 仍要记:一枪就死与「第一枪被截断、第二枪死在连接上」在诊断上是两件事,
      // 而后者只有这里知道——它没有过程记录条目可挂(ADR-0031)。
      turns.push({ kind: "transport", round: step, attempts });
      termination = "transport";
      atStep = steps.length;
      break;
    }
    const sendMs = now() - turnStart;
    const harnessStart = now();
    // 原文**只算一次**：落进 `steps.raw` 的字节与下一步发回历史里的字节必须是同一份
    // （ADR-0032「与发回去的字节同源」）。分两处各取一次 `response.text` 会在病态保护边界上
    // 悄悄造出两个字节串，而那种不一致在读侧根本看不出来。
    const raw = clampRaw(response.text);
    const observedInputTokens = inputTokensOf(response.usage);
    if (observedInputTokens !== undefined) {
      lastInputTokens = observedInputTokens;
    }
    turns.push({
      kind: "response",
      round: step,
      attempts,
      finishReason: response.finishReason,
      usage: response.usage,
      sendMs,
    });

    // ④ 解析 / 执行。第二次仍被截断时转格式反馈,不再退避。
    let action: ArchiveStepAction = { kind: "none" };
    let observation = noActionObservation(TRUNCATED_RESPONSE_FEEDBACK);
    let result: AgentExecResult["result"];
    let done = false;
    if (response.finishReason !== "length") {
      const parsed = parseAction(response.text);
      if (parsed.kind === "reject") {
        parseFailures += 1;
        observation = noActionObservation(parsed.correction);
      } else {
        parseFailures = 0;
        const executed = await request.executor({
          step,
          command: parsed.command,
          ...(parsed.doneAtLine === undefined ? {} : { doneAtLine: parsed.doneAtLine }),
          ...(request.host === undefined ? {} : { requestHandler: request.host.requestHandler }),
        });
        done = executed.done === true;
        action = actionOf(parsed.command, done);
        observation = observationOf(executed);
        result = executed.result;
        // 宿主服务说「这一次真评出了成绩」时,把提交身份记下来(loop 只搬运)。
        if (executed.submission !== undefined) {
          submissions.push({
            step,
            call: executed.evaluateCall ?? 1,
            scriptSha256: executed.submission.scriptSha256,
            hostPath: executed.submission.hostPath,
            observationsPath: executed.submission.observationsPath,
          });
        }
      }
    }
    // `harnessMs` 覆盖沙箱执行与观测回填:sendMs 的补集,两者相加就是整步。
    const harnessMs = now() - harnessStart;

    steps.push({
      step,
      action,
      stdout: observation.stdout,
      stderr: observation.stderr,
      exitCode: observation.exitCode,
      atMs,
      harnessMs,
      raw,
      ...(result === undefined ? {} : { result }),
    });
    turnHistory.push({
      raw,
      observation,
      ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
    });

    // ⑤ 这一步之后要不要停。
    if (done) {
      termination = "done";
      atStep = step;
      break;
    }
    if (parseFailures >= ACTION_PARSE_FAILURE_LIMIT) {
      termination = "action-parse";
      atStep = step;
      break;
    }
  }

  if (termination === "max-steps" && atStep === 0) {
    atStep = steps.length;
  }
  return settle(termination, atStep);
};

/** 便于接线方判断「这一步是不是有候选」:候选为空即失败档(ADR-0030)。 */
export const hasCandidates = (result: AgentLoopResult): boolean => result.submissions.length > 0;

/** `EvaluateProbe` 的最小占位实现:本段不接网格,选举时用它会得到一条明确的失败而不是空候选。 */
export const unpluggedEvaluateProbe: EvaluateProbe = {
  evaluate: async () => ({
    kind: "failed",
    stderr: "evaluate 尚未接线(票 06 才接真实网格):这一次没有产出候选。",
  }),
};
