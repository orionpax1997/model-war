/**
 * 宿主侧工具服务的对外面:**一个会话一个 `createSessionTools(...)`**。
 *
 * ── 接线方从这里接 ──
 *
 * ```ts
 * const tools = createSessionTools({
 *   workspaceDir,                                     // bind 成 /workspace 的那个宿主目录
 *   deadlineAtMs: sessionStartedAt + sessionBudgetMs, // 会话墙钟的绝对到点时刻
 *   check: createCheckService({ root }),
 *   evaluate: createEvaluateService({ root, model, runId, plan: () => plan, trial }),
 * });
 *
 * // `bash` 由执行器交给沙箱;其余四个由宿主受理。
 * const outcome =
 *   call.name === "bash"
 *     ? await sandbox.run({ command, workspaceDir })   // 一步一次 bash -c,宿主不切块
 *     : await tools.dispatch(step, call);              // 工具名 + 参数进,结果对象出
 * if (tools.finishRequested()) break;                  // 模型调过 `finish`:本步结束后收工
 * ```
 *
 * 三件事在这一层就位:**工具分派**(带配额与会话墙钟)、**两个服务**(check / evaluate)、
 * **收工信号**(`finish` 调用)。沙箱仍然只有 `sandbox.run` 一个动作,而且它只跑 `bash`。
 *
 * ── 为什么这个目录叫 `host` ──
 * 它与 `agent/sandbox`(执行器)是两个位置,不是两份实现:判据全在宿主(本目录),隔离只在
 * 执行器。把服务写进沙箱是这一批明确不做的事(ADR-0033 的重评条件),所以目录名要把「哪一侧」
 * 说清。旧的第三个位置(`agent/shim`,沙箱里的薄壳)已删除——限制工具不再靠「沙箱里放一个
 * 只会敲宿主的程序」,靠「沙箱里没有那条路」(票 03)。
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
