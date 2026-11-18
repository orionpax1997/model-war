/**
 * 宿主侧工具服务与 fd 通道的对外面:**一个会话一个 `createSessionTools(...)`**。
 *
 * ── 票 05 从这里接 ──
 *
 * ```ts
 * const tools = createSessionTools({
 *   workspaceDir,                                   // bind 成 /workspace 的那个宿主目录
 *   deadlineAtMs: sessionStartedAt + sessionBudgetMs, // 会话墙钟的绝对到点时刻
 *   check: createCheckService({ root }),
 *   evaluate: createEvaluateService({ root, model, runId, plan: () => plan, trial }),
 * });
 *
 * const split = splitDoneBlock(modelOutput);        // 块级哨兵:切掉 done 之后的部分
 * const step = await sandbox.run({
 *   command: split.body,                            // 整块一次 bash -c,不是两段
 *   workspaceDir,
 *   requestHandler: tools.requestHandler,           // 薄壳的 fd 3 由此应答
 * });
 * ```
 *
 * 三件事在这一层就位:**块切分**(纯函数)、**通道应答**(带配额与会话墙钟)、**两个服务**
 * (check / evaluate)。执行器仍然只有 `sandbox.run` 一个动作,通道只是它的一个入参。
 *
 * ── 为什么这个目录叫 `host` ──
 * 它与 `agent/sandbox`(执行器)和 `agent/shim`(沙箱里的薄壳)是**三个位置**,不是三份实现:
 * 判据全在宿主(本目录),执行只在执行器,沙箱里只有那条通道的一端。把服务写进沙箱是这一票
 * 明确不做的事(ADR-0033 的重评条件),所以目录名要把「哪一侧」说清。
 */

export {
  createSessionTools,
  PROTOCOL_EXIT_CODE,
  QUOTA_EXHAUSTED_MESSAGE,
  REFUSAL_EXIT_CODE,
  SESSION_EXPIRED_MESSAGE,
  UNKNOWN_TOOL_MESSAGE,
  type SessionTools,
  type SessionToolsOptions,
} from "./dispatcher.js";
export {
  CHECK_DIAGNOSTIC_LIMIT,
  CHECK_FULL_TEXT_NAME,
  CHECK_FULL_TEXT_PATH,
  WORKSPACE_SCRIPT_PATH,
  contractRuleLabels,
  createCheckService,
  tscDiagnostics,
  tscErrorCodes,
  type CheckRequest,
  type CheckService,
  type CheckServiceDeps,
  type CompileFn,
  type ValidateFn,
} from "./check-service.js";
export {
  OBSERVATIONS_DIR_NAME,
  OBSERVATIONS_DIR_PATH,
  candidateObservationsFile,
  candidateScriptFile,
  candidateSourceFile,
  createEvaluateService,
  type EvaluateOutcome,
  type EvaluateRequest,
  type EvaluateService,
  type EvaluateServiceDeps,
  type EvaluateSubmission,
} from "./evaluate-service.js";
export { splitDoneBlock, type DoneSplit } from "./done.js";
