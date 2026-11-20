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
import type { ToolCall, ToolDeclaration } from "./tools.js";
import {
  buildHistory,
  type HistorySeed,
  type HistoryTurn,
  type StepObservation,
} from "./history.js";
import { ACTION_REJECT_EXIT_CODE, parseAction } from "./action.js";
import {
  AGENT_MAX_STEPS,
  AGENT_TOTAL_WALL_CLOCK_MS,
  WallClockExhausted,
  contextGuardTrips,
  inputTokensOf,
} from "./limits.js";
import { clampRaw, truncateObservation, TRUNCATED_RESPONSE_FEEDBACK } from "./truncate.js";
import type {
  AgentExecResult,
  AgentExecutor,
  AgentStep,
  AgentTermination,
  AgentTurnEvidence,
} from "./types.js";
import type { ArchiveStepAction } from "@model-war/schema";
import type { ActionParse } from "./action.js";

/** 连续几次动作解析失败即停:一次是模型手滑,三次是它没读懂协议。 */
export const ACTION_PARSE_FAILURE_LIMIT = 3;

/** 一次会话的入参。所有缝都注入,所以整条 loop 可以在无网络、无沙箱的机器上被钉住。 */
export type AgentLoopRequest = {
  readonly model: ModelClient;
  readonly executor: AgentExecutor;
  /**
   * 本会话的工具声明(`AGENT_TOOLS`)。
   *
   * 由接线方注入而不是本模块 import 常量:loop 不认识「模型看得见的世界」里有哪五个工具,
   * 它只负责把声明原样送到端口上(`SendOptions.tools`)。这样同一份 loop 也能被只声明一个
   * 工具的测试钉住。缺席 = 不带 `tools` 发请求(请求体与工具调用之前逐字节相同)。
   */
  readonly tools?: readonly ToolDeclaration[];
  /** `system`:协议(动作语法、`finish` 收工命令的语义)。 */
  readonly system: string;
  /** 首条 `user`:任务、目录与三条硬约束。 */
  readonly firstUser: string;
  readonly params?: ModelParams;
  /** 模型席位的上下文窗口;缺席即不判守卫(不知道自己离窗口多近)。 */
  readonly contextLength?: number;
  /** 覆盖步数上限(默认 `AGENT_MAX_STEPS`);测试用它把边界压到个位数。 */
  readonly maxSteps?: number;
  /** 覆盖总墙钟(默认 `AGENT_TOTAL_WALL_CLOCK_MS`)。 */
  readonly totalWallClockMs?: number;
  /**
   * 总墙钟的 **active** 口径:已用掉多少该计的时间(退避等待不算,ADR-0035/0036)。
   *
   * 由接线方注入,因为它才知道哪些时间该划掉(`pipeline.ts` 用 `BudgetClock` 在退避期间停表)。
   * 缺席时按注入的 `now()` 算,那一档**含**退避——只在没有接线方的单测里成立。
   */
  readonly activeElapsedMs?: () => number;
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
   * 它装的就是首条 `user` 的逐字文本(`request.firstUser`)。`system` 不在这里:那是**协议**,
   * 不是「这次会话的任务」,它的归属是 `harnessVersion` / `harnessDigest` 与
   * `prompts/agent-system.md`(同一份字节存两处就会漂)。
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
  /** 编出这份产物的 tsc 版本（冻结时要写进 `meta.tscVersion`）。 */
  readonly tscVersion: string;
};

/** 没有动作的那一步:命令一条都没跑,但步数与过程记录照记。 */
const noActionObservation = (message: string): StepObservation => ({
  stdout: "",
  stderr: message,
  exitCode: ACTION_REJECT_EXIT_CODE,
});

/** 这一步发起的**那一次**工具调用;零次或多于一次时没有「那一次」可指,回 `undefined`。 */
const toolCallOf = (toolCalls: readonly ToolCall[] | undefined): ToolCall | undefined =>
  toolCalls?.length === 1 ? toolCalls[0] : undefined;

/**
 * 一步的动作类别:从**工具名**推出来,不再从命令文本猜。
 *
 * 旧读法要问「整块去空白后是不是恰好 `evaluate`」,因为那时 `check` / `evaluate` / `finish`
 * 都是 `bash` 里的一条命令——那是唯一能区分它们的信号。新世界里工具名本身就是答案,那条判据
 * (以及它对「`evaluate; 别的东西`」的边界讨论)整个消失。
 *
 * `done` 这一档的名字留在档案形状里(见 `ArchiveStepAction`),工具名是 `finish`:两者是不同的
 * 东西——一个是档案枚举值,一个是模型调的工具。
 */
const actionOf = (parsed: Extract<ActionParse, { kind: "ok" }>): ArchiveStepAction => {
  switch (parsed.tool) {
    case "bash":
      // `parseAction` 只在 `bash` 这一档产出 `command`,别处不会走到这里。
      return { kind: "bash", command: parsed.command ?? "" };
    case "check":
      return { kind: "check" };
    case "probe":
      return { kind: "probe" };
    case "evaluate":
      return { kind: "evaluate" };
    case "finish":
      return { kind: "done" };
  }
};

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
    // ① 总墙钟:两项硬约束之一。口径是 **active**(ADR-0035):退避等待不算。
    //
    // 注入的 `activeElapsedMs` 由接线方给(它知道哪些时间该划掉);不给时退回实钟——那一档
    // **含**退避,只在没有外循环的测试里成立。
    if ((request.activeElapsedMs?.() ?? now() - startedAt) >= totalWallClockMs) {
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
    // 工具声明是**每次请求**都带的:历史逐轮变长,协议面不变。不传时请求体逐字节不变。
    const sendOptions = request.tools === undefined ? undefined : { tools: request.tools };
    try {
      response = await request.model.send(history, params, sendOptions);
      if (response.finishReason === "length") {
        attempts = 2;
        response = await request.model.send(history, params, sendOptions);
      }
    } catch (cause) {
      // 传输重试耗尽(重试预算在传输层,不在 loop)与「总墙钟到点、调用被中止」都到这里:
      // 这一次调用不进过程记录、不进协议轮数。
      //
      // `attempts` 仍要记:一枪就死与「第一枪被截断、第二枪死在连接上」在诊断上是两件事,
      // 而后者只有这里知道——它没有过程记录条目可挂(ADR-0031)。
      //
      // 两种收场共用**同一行日志**(`kind: "transport"`:这一行按传输末行的形状读),差别只在
      // 终止原因:预算到点不是传输运气不好,重跑一次同样的会话也不会更好。半截响应没有别的
      // 落法——它既不是一份响应(没有 `finishReason`、没有被执行的动作),也不是一次手滑。
      turns.push({ kind: "transport", round: step, attempts });
      termination = cause instanceof WallClockExhausted ? "wall-clock" : "transport";
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
    // 收工判据是「这一步调用了 `finish` 工具」:它是工具名,不是命令字节里某一行长什么样。
    let done = false;
    if (response.finishReason !== "length") {
      const parsed = parseAction(response.toolCalls ?? []);
      if (parsed.kind === "reject") {
        parseFailures += 1;
        observation = noActionObservation(parsed.correction);
      } else {
        parseFailures = 0;
        // 执行器拿到的是一次**工具调用**:`bash` 由它交给沙箱,其余四个交给宿主的 dispatch。
        // loop 不判断哪一个是谁的事——它只把解析出来的那一次调用原样递下去。
        const executed = await request.executor({
          step,
          call: { name: parsed.tool, argumentsJson: parsed.argumentsJson },
          ...(parsed.command === undefined ? {} : { command: parsed.command }),
        });
        // 收工判据是「宿主收下了这次 `finish`」,不是「模型调了一个叫 finish 的东西」:
        // 被拒的那一次(会话到点、参数误用)不算收工,与旧世界拒绝不置位同理。
        done = executed.done === true;
        action = actionOf(parsed);
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
            tscVersion: executed.submission.tscVersion,
          });
        }
      }
    }
    // `harnessMs` 覆盖沙箱执行与观测回填:sendMs 的补集,两者相加就是整步。
    const harnessMs = now() - harnessStart;
    // 逐字字节的那一格:只在**恰好一次**调用时记(理由见 `steps.push` 那里的注释)。
    const recorded = toolCallOf(response.toolCalls);

    steps.push({
      step,
      action,
      stdout: observation.stdout,
      stderr: observation.stderr,
      exitCode: observation.exitCode,
      atMs,
      harnessMs,
      raw,
      // 逐字字节的家:那一次调用叫什么、`arguments` 原文是什么。**只在这一步恰好一次调用时**记。
      // 零次没有可记的;多于一次则「那一次」这个说法不成立(拒档的 `none` + 退出码 64 说明它们
      // 一次都没执行)。被拒的**单次**调用照样记:字节留下来,读侧才看得见模型当时到底写了什么
      // (ADR-0031),而 `action.kind` 与退出码回答「它有没有被执行」。
      ...(recorded === undefined ? {} : { toolCall: recorded }),
      ...(result === undefined ? {} : { result }),
    });
    turnHistory.push({
      raw,
      ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
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
