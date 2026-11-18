/**
 * 单模型生成:**一个单会话 loop**,一次模型调用一步(ADR-0032)。
 *
 * ── 外循环是**替换**,不是包裹 ──
 *
 * 旧形态的那条 `for (round)` 与它的四项产出(阶段推进、反馈轮数、跨阶段复用、网格计划与陪练
 * 身份)在 v3 里一个都不剩:它们是 one-shot 形态的产物,留着等于每加一个字段、每条断言都要
 * 维护两遍。这里只有一条线性链:送历史 → 解析动作 → 执行 → 记一步 → 再送。
 *
 * 于是「阶段」这个概念整个消失(ADR-0031):`evaluate` 就是提交,三次是配额上限而不是时序,
 * 候选的数组下标就是「第几次评测」。`stage` / `protocolRound` / `feedbackRounds` / `plan` /
 * `reusedFromStage` 都不进 v3 的优化段。
 *
 * ── 唯一生成入口 ──
 *
 * `generateOneModel` 仍是唯一入口,`run.ts` 只调它一次一个模型。**不保留「步数为一」的退化
 * 路径**:它没有消费者,只有维护成本。
 *
 * ── 终止与落档正交 ──
 *
 * 循环只回答「怎么停」(六个原因,见 `agent/loop.ts`),落档只看「有没有候选」:有候选就是成功
 * 档(成绩取**最后一次** `evaluate` 评的那个版本),一个候选都没有就是失败档。所以墙钟耗尽
 * 不会被判成失败——那是拿资源约束当成绩判据。
 *
 * ── 本文件只做接线,判据在各自的家里 ──
 *
 * | 判据 | 家 |
 * |---|---|
 * | 动作语法、`done` 语义、截断、守卫、步数、历史 | `agent/{action,truncate,limits,loop,history}.ts` |
 * | 配额、会话墙钟、`check` / `evaluate` 服务、块切分 | `agent/host/`(票 04) |
 * | 沙箱隔离与单步墙钟 | `agent/sandbox/`(票 03) |
 * | 档案形状与轮数公式 | `archive.ts` + `packages/schema`(票 01) |
 *
 * 本文件因此只说一件事:**这些零件怎么装在一起**。
 *
 * ── 宿主侧的事实怎么回到步骤上 ──
 *
 * `check` 的 `result`(tsc / 契约错误码)与 `evaluate` 的提交身份都产生在**宿主侧的服务**里,
 * 而 loop 只看得见沙箱那一步的 stdout / stderr。所以本文件把两个服务**包一层**再交给
 * dispatcher:包装器把这次调用的事实记进一个「当前步」的槽,`sandbox.run` 一返回就取走。
 *
 * 这样切的好处是两个方向都干净:票 04 的服务不知道有人在观察它(它们的签名不变),loop 也不
 * 需要理解通道协议的字节形态。夹在中间的这一层只搬运,不判定。
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ArchiveMeta,
  type ArchiveOptimizationAgent,
  type ArchiveOptimizationCandidateAgent,
  type ArchiveStep,
  type ArchiveTermination,
  type ArchiveValidation,
  type FailureRecord,
  type TrialGridScore,
  type TrialPlan,
} from "@model-war/schema";

import type { ModelConfig } from "./config.js";
import {
  projectUsage,
  responseAttemptEvidence,
  transportFailureAttemptEvidence,
  usageCaliberOf,
  type AttemptEvidence,
  type UsageCaliber,
} from "./generation-evidence.js";
import { generationParams, generationRequestEvidence } from "./generation-policy.js";
import type { ChatMessage, ModelClient, ModelParams, ModelResponse } from "./model-client.js";
import {
  SCRIPT_PRODUCT_NAME,
  SCRIPT_SOURCE_NAME,
  buildArchiveMeta,
  commitArchive,
  discardStagingDir,
  openStagingDir,
  sha256Hex,
} from "./archive.js";
import { loadAgentPrompt, type AgentPrompt } from "./agent-prompt.js";
import { harnessIdentity } from "./agent/identity.js";
import { AGENT_MAX_STEPS, AGENT_TOTAL_WALL_CLOCK_MS } from "./agent/limits.js";
import { runAgentSession, type AgentLoopResult } from "./agent/loop.js";
import { sandbox } from "./agent/sandbox/index.js";
import { splitDoneBlock } from "./agent/host/done.js";
import { createCheckService } from "./agent/host/check-service.js";
import {
  candidateObservationsFile,
  candidateScriptFile,
  candidateSourceFile,
  createEvaluateService,
} from "./agent/host/evaluate-service.js";
import { createSessionTools } from "./agent/host/dispatcher.js";
import type { AgentExecRequest, AgentExecResult, AgentExecutor } from "./agent/types.js";
import { retryTransport } from "./retry.js";
import type { GenerationRequest } from "./run.js";
import { prepareTrialPlan, runTrialScript, type TrialProbe } from "./trial.js";
import { gridSummaryPathOf, readTrialGridSummary } from "./trial-grid.js";
import { scriptSizeLimit, validateScript } from "./validate.js";

export type { FailureClassification } from "@model-war/schema";

/**
 * 生成日志一行:一次模型调用一行,只装**发送侧**证据(ADR-0031)。
 *
 * 「这一轮被什么驱动」「编译错误码」属于结果侧,真源在过程记录的条目里——日志不再复写一份。
 * 唯一保留的行内判别符是 `kind`:传输末行与收敛行形状本就不同,它需要说明「这一行按哪种形状读」。
 */
export type GenerationLogEntry = {
  readonly round: number;
  readonly kind: "converged" | "transport";
  readonly model: string;
  readonly params: ModelParams;
  /** 原始用量;规范配置下按口径投影(与既有的 `usage_semantic` / `usage_source` 一脉相承)。 */
  readonly usage?: unknown;
  readonly finishReason?: string;
  /**
   * 这一步用了几次模型调用。
   *
   * 第二次只可能是**截断重试**(ADR-0035):它作为同一步的第二个尝试,日志仍一行。传输重试的
   * 枪数另记在 `attemptEvidence` 里——那是另一件事(退避与状态码分类,ADR-0036)。
   */
  readonly attempts?: number;
  /**
   * 收敛标记:`true` = 这一行是收敛行,`false` = 传输末行。
   *
   * 读侧靠它区分「未收敛日志只能是传输失败末行」这条判据(报告侧 `archive-report.ts` 的那一条
   * 与 `kind` 一起用)。ADR-0031 已裁「行类型」是唯一保留的行内判别符;它是那个判别的既有形状,
   * 不是第二个事实。
   */
  readonly responseConverged: boolean;
  readonly requestEvidence?: ReturnType<typeof generationRequestEvidence>;
  readonly attemptEvidence?: readonly AttemptEvidence[];
  /** 模型段墙钟(含退避)。只作记录,deadline 按不含退避的口径判(ADR-0036)。 */
  readonly sendMs: number;
};

/** 传输末行:形状上的差别只有 `kind` 与缺少用量/停止原因。 */
export type GenerationTransportLogEntry = GenerationLogEntry & { readonly kind: "transport" };

/**
 * 失败结论。
 *
 * agent 形态下 `prompts` **恒为空**:轮数与起始 prompt 由 `steps` 与首条消息推导(ADR-0031 的
 * 同一个公式)。这一栏留在类型里是因为 `FailureRecord` 的形状共用,而 `buildFailureRecord` 会
 * 把「agent 形态又填了 prompts」当成两份会漂的奇据拒掉——所以这里只放空数组。
 */
export type ModelFailure = {
  readonly classification: "tsc" | "contract" | "transport" | "selection";
  readonly prompts: readonly string[];
  readonly generationLog: readonly string[];
  readonly diagnostics: readonly string[];
  readonly message: string;
  readonly candidates?: readonly ArchiveOptimizationCandidateAgent[];
  readonly selectionFailure?: FailureRecord["selectionFailure"];
};

/**
 * v3 档案里那组「模型面对的世界」与「这次会话怎么走完」的字段。
 *
 * 成功档与失败档**同键集合**(ADR-0031):「零候选」是这次会话的结论,不是「少写几个键」的
 * 理由。所以失败档也带这一组,写盘由 `run.ts` 交给 `writeFailureRecord({ agent })`。
 */
export type AgentArchiveFields = {
  readonly steps: readonly ArchiveStep[];
  readonly firstPrompt: string;
  readonly contextLength: number;
  readonly harnessVersion: string;
  readonly harnessDigest: string;
  readonly termination: ArchiveTermination;
  readonly atStep: number;
};

export type ModelOutcome =
  | {
      readonly kind: "frozen";
      readonly slug: string;
      readonly runId: string;
      readonly dir: string;
      readonly meta: ArchiveMeta;
    }
  | {
      readonly kind: "failed";
      readonly slug: string;
      readonly runId: string;
      readonly failure: ModelFailure;
      readonly agent: AgentArchiveFields;
    };

/**
 * 一次 `evaluate` 的**成绩**从哪来:把提交身份换成成绩的那条接缝。
 *
 * ── 为什么是「给提交身份、换成绩」这样一个函数 ──
 *
 * 一次评测的结论由两半拼成,而两半来自不同的地方:提交身份(**评的是哪份字节**)在宿主侧的
 * `evaluate` 服务里,成绩(分数、场数)在网格里。本文件只该知道「两半凑齐了就是一个候选」,
 * 不该知道其中任何一半怎么算。
 *
 * ── 缺省实现就是真网格 ──
 *
 * `scoreFromCandidateEvidence` 从候选证据旁的 `.grid.json` 读成绩(算术真源在 runner,生成侧只搬运)。
 * 测试注入假实现,把「成绩」与「网格」拆开验;注入 `async () => undefined` 就是「一次都不产出
 * 候选」的那条路径(零候选即失败档,ADR-0030)。
 */
export type EvaluateScoring = (
  submission: EvaluateSubmission,
) => Promise<{ readonly score: TrialGridScore; readonly matchCount: number } | undefined>;

/** 一次 `evaluate` 的提交身份(服务算的)与它在会话里的位置(loop 算的)。 */
export type EvaluateSubmission = {
  /** 步号(1 起):候选条目里的 `step` 就是它。 */
  readonly step: number;
  /** 第几次评测(1 起,dispatcher 的计数器)。 */
  readonly call: number;
  /** 源字节的 sha256(评的是哪一版)。 */
  readonly scriptSha256: string;
  readonly hostPath: string;
  /** 编出候选产物的 tsc 版本(冻结时写进 `meta.tscVersion`)。 */
  readonly tscVersion: string;
  /** 观测出口(沙箱视角的**派生视图**路径:聚合对差表 + 逐场 + 最差三场)。 */
  readonly observationsPath: string;
  /** 观测文件相对 `archive/<slug>/` 的 basename(候选条目的 `observationsFile`)。 */
  readonly observationsFile: string;
};

/** 一次都没跑过 `check` 时的校验结论:记「没查」,而不是伪造一次「查过且干净」。 */
const NO_CHECK_VALIDATION: ArchiveValidation = {
  passed: false,
  errors: ["本会话没有跑过 check:没有校验结论可记(这不是「查过且干净」)。"],
};

/**
 * 当前步的事实槽:宿主侧的服务在应答时往里写,`sandbox.run` 一返回就取走。
 *
 * 槽只活一步:每次执行前清空、之后取走。跨步残留会让「上一步的 tsc 错误码」出现在这一步上,
 * 而那种错位在报告里看起来完全正常——所以宁可在每次执行前清一次。
 */
type StepFacts = {
  /** 当前步号(1 起):宿主服务要它给候选证据族起名。 */
  step?: number;
  result?: ArchiveStep["result"];
  submission?: {
    readonly scriptSha256: string;
    readonly hostPath: string;
    readonly observationsPath: string;
    readonly tscVersion: string;
  };
  evaluateCall?: number;
  /**
   * 评测基础设施失败的一句话(计划重建不符 / 试跑子进程异常)。
   *
   * 它不是「模型写错了」,所以**不进这一步的观测**:环境故障解释了模型也没用(ADR-0030
   * 残余风险 3 的同一条理由)。记在这里,由执行器在沙箱返回后大声失败。
   */
  infra?: string;
};

const createStepFacts = (): { readonly current: StepFacts; readonly reset: () => void } => {
  const current: StepFacts = {};
  return {
    current,
    reset: () => {
      delete current.result;
      delete current.submission;
      delete current.evaluateCall;
      delete current.infra;
    },
  };
};

/**
 * 把 `check` / `evaluate` 包一层,让它们的事实落进当前步的槽。
 *
 * 包装器**不改语义**:原样调用、原样返回,只是在返回之前顺手记一笔。所以它在 dispatcher 眼里
 * 与没包一样,配额、墙钟、拒绝语义一个字都没动。
 *
 * 它额外知道两件 dispatcher 不知道的事:当前步号(候选证据族的序号)与「服务抛了」这件事。
 * 前者由执行器在跑这一步之前写进槽里,后者是 infra 的唯一识别点——dispatcher 会把服务异常
 * 折成一条工具响应(它不能让通道挂死),而那会让「sandbox 装坏了」看起来像模型手滑。
 */
const observeServices = (options: {
  readonly root: string;
  readonly model: string;
  readonly runId: string;
  readonly trial: TrialProbe;
  readonly plan: () => TrialPlan;
  readonly facts: StepFacts;
}) => {
  const check = createCheckService({ root: options.root });
  const evaluate = createEvaluateService({
    root: options.root,
    model: options.model,
    runId: options.runId,
    plan: options.plan,
    trial: options.trial,
  });
  return {
    check: async (request: { readonly workspaceDir: string }) => {
      const response = await check(request);
      // 结果侧证据只在这一步的槽里;`result` 缺席 = 没有可归纳的东西(与服务自己的口径一致)。
      if (response.result !== undefined) options.facts.result = response.result;
      return response;
    },
    evaluate: async (request: { readonly workspaceDir: string; readonly call: number }) => {
      let outcome: Awaited<ReturnType<typeof evaluate>>;
      try {
        outcome = await evaluate({
          workspaceDir: request.workspaceDir,
          call: request.call,
          step: options.facts.step ?? Number.NaN,
        });
      } catch (cause) {
        // 计划重建不符与试跑子进程异常都是 infra:候选不该为它背账。记下来,
        // 执行器在沙箱返回后大声失败;这一步回一条**工具响应**只是为了让通道收得住。
        const message = cause instanceof Error ? cause.message : String(cause);
        options.facts.infra = message;
        return { exitCode: 1, stdout: "", stderr: `evaluate:评测基础设施失败:${message}\n` };
      }
      if (outcome.submission !== undefined) {
        options.facts.submission = {
          scriptSha256: outcome.submission.scriptSha256,
          hostPath: outcome.submission.hostPath,
          observationsPath: outcome.submission.observationsPath,
          tscVersion: outcome.submission.tscVersion,
        };
        options.facts.evaluateCall = request.call;
      }
      return outcome;
    },
  };
};

/**
 * 把执行器接到沙箱上。
 *
 * 一次调用 = 一次 `sandbox.run`,块在**宿主侧**先按 `done` 切开(ADR-0032「切掉后半段,整块一次
 * `bash -c`」):切开而不是跑两段,是为了让 shell 状态(`cd`、`set -e`、heredoc)在 `done` 那一行
 * 前后保持连续。
 *
 * 通道端(`requestHandler`)是票 04 的 dispatcher:它是配额的唯一判据源,超限时回一份伪造
 * stderr 且**真执行函数一次都不调**。
 */
const createExecutor =
  (options: {
    readonly workspaceDir: string;
    /** 入库 rootfs 的宿主路径;`undefined` 时执行器按模块位置上溯(源码/`dist` 形态)。 */
    readonly rootfsDir: string | undefined;
    readonly tools: ReturnType<typeof createSessionTools>;
    readonly facts: { readonly current: StepFacts; readonly reset: () => void };
    readonly stepWallClockMs?: number;
  }): AgentExecutor =>
  async (request: AgentExecRequest): Promise<AgentExecResult> => {
    options.facts.reset();
    options.facts.current.step = request.step;
    const split = splitDoneBlock(request.command);
    // `done` 是块内第一行时 body 是空串:不跑空 shell(它的副作用只有一次 `bash` 启动)。
    const executed =
      split.body.trim() === ""
        ? { stdout: "", stderr: "", exitCode: 0, timedOut: false }
        : await sandbox.run({
            command: split.body,
            workspaceDir: options.workspaceDir,
            requestHandler: options.tools.requestHandler,
            ...(options.rootfsDir === undefined ? {} : { rootfsDir: options.rootfsDir }),
            ...(options.stepWallClockMs === undefined
              ? {}
              : { wallClockMs: options.stepWallClockMs }),
          });
    const facts = options.facts.current;
    // 宿主侧报告基础设施失败:这一刻才大声失败(loop 的 executor reject 是 infra 的专用通道),
    // 而不是把它折成模型的一次手滑。既然这次会话的网格身份已经不可信,后面的步也没意义了。
    if (facts.infra !== undefined) {
      throw new Error(`第 ${String(request.step)} 步的评测基础设施失败:${facts.infra}`);
    }
    return {
      stdout: executed.stdout,
      stderr: executed.stderr,
      exitCode: executed.exitCode,
      timedOut: executed.timedOut,
      ...(split.ended ? { done: true } : {}),
      ...(facts.result === undefined ? {} : { result: facts.result }),
      ...(facts.submission === undefined
        ? {}
        : { submission: facts.submission, evaluateCall: facts.evaluateCall ?? 1 }),
    };
  };

/**
 * 一次 `send` 的传输层包装:`retryTransport` 负责 429 / 连接级两套预算(ADR-0036)。
 *
 * ── 截断**不**在这里重试 ──
 *
 * 传输层的截断重试是「半截响应直接丢掉、重发同一份 messages」,它不知道模型能不能自我修正。
 * 而 ADR-0032 要求 agent 形态在**第二次仍截断**时转格式反馈而不是继续退避——所以截断被摘出来
 * 原样交回 loop,由 loop 的「重试一枪 → 转格式反馈」承担。两条裁决因此各落在自己的家里。
 */
const sendWithTransportRetry = async (options: {
  readonly client: ModelClient;
  readonly messages: readonly ChatMessage[];
  readonly params: ModelParams;
  readonly evidence: AttemptEvidence[];
  readonly caliber: UsageCaliber | undefined;
}): Promise<
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly message: string; readonly diagnostics: readonly string[] }
> => {
  const attempt = await retryTransport({
    send: async () => {
      const number = options.evidence.length + 1;
      try {
        const response = await options.client.send(options.messages, options.params);
        options.evidence.push(responseAttemptEvidence(number, response, options.caliber));
        return response;
      } catch (cause) {
        options.evidence.push(transportFailureAttemptEvidence(number, cause));
        throw cause;
      }
    },
    // 截断归 loop:本层把它当一次成功响应交回。
    truncation: "caller",
  });
  return attempt.ok
    ? { ok: true, response: attempt.response }
    : { ok: false, message: attempt.failure.message, diagnostics: attempt.failure.diagnostics };
};

const logLine = (entry: GenerationLogEntry): string => JSON.stringify(entry);

const nonEmptyLines = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

/**
 * 真网格的评分接缝:成绩逐字来自候选证据旁的 `.grid.json`。
 *
 * ── 为什么读盘而不是算 ──
 *
 * 分数的算术唯一真源在 runner 的 `trial-score.ts`(生成侧不得跨过去,门禁钉死),所以这里只
 * 做三件事:按候选证据族找到那份汇总、拿它跟本会话的 expected plan 逐字对(换图/换座位/换
 * 种子/换陪练摘要即 infra)、把 `score` 与场数原样交给候选条目。
 *
 * ── 两个摘要,两件事 ──
 *
 * 汇总里那个 `scriptSha256` 是候选**产物**(`.candidate.js`)的字节摘要——它是网格输入的身份;
 * 这里从盘上重算一遍再交给读入端,于是「盘上那份产物」与「网格说的那份产物」不一致时立即拒。
 */
export const scoreFromCandidateEvidence = (deps: {
  readonly root: string;
  readonly slug: string;
  readonly plan: () => TrialPlan;
}): EvaluateScoring => {
  const archiveDir = join(deps.root, "archive", deps.slug);
  return async (submission: EvaluateSubmission) => {
    const plan = deps.plan();
    const productSha256 = sha256Hex(
      readFileSync(join(archiveDir, candidateScriptFile(submission.observationsFile))),
    );
    const summary = readTrialGridSummary({
      path: gridSummaryPathOf(join(archiveDir, submission.observationsFile)),
      expectedPlan: plan,
      scriptSha256: productSha256,
    });
    return { score: summary.score, matchCount: summary.plan.matchesPerCandidate };
  };
};

/**
 * 单模型生成:读首条 prompt、跑单会话、按「有没有候选」落成功档或失败档。
 *
 * 与旧形态的入参差异:`GenerationRequest` 不再需要 `template` 与 `docs`——契约正文**不进首条
 * 消息**(读契约要花几步,这是设计的一部分,ADR-0030),首条 user 与 system 改成由
 * `agentPrompt` 直接给出(`loadAgentPrompt(root, identity)` 的返回值)。
 */
export const generateOneModel = async (
  request: GenerationRequest,
  config: ModelConfig,
): Promise<ModelOutcome> => {
  const slug = config.slug;
  const runId = request.runId;
  const params: ModelParams = generationParams(config);
  const identity = harnessIdentity();
  const contextLength = config.contextLength;
  // 守卫要窗口大小才能判「再发一次会不会越过 80%」。读不到就不跑,不静默跳过守卫。
  if (contextLength === undefined)
    throw new Error(
      `模型 ${slug} 的配置缺 contextLength:agent 形态的上下文守卫需要窗口大小,读不到就不跑`,
    );

  const prompt: AgentPrompt = request.agentPrompt ?? loadAgentPrompt(request.root);
  // ── 工作区不住在 `archive/` 里 ──
  //
  // 那个目录的发布不变量是「目录存在 ⇔ 三件套完整」(ADR-0031),而工作区是一个**中途"留下来**的
  // 子目录。让它们同层会让那条不变量当场变成假话——失败档那一次尤其明显:删掉失败文件之后
  // `archive/<slug>/` 里剐下一个 `.workspace-*`,
  // 而读侧把它当成一份没有三件套的档。
  //
  // 也不放 `archive/` 之外的对局产物根名字里:那个名字是 gen 的禁字(gen 不得往外看对局产物)。
  const workspaceDir = request.workspaceDir ?? join(request.root, ".workspaces", slug, runId);
  mkdirSync(workspaceDir, { recursive: true });

  const stagingDir = openStagingDir(request.root, slug);
  let committed = false;
  const generationLog: string[] = [];
  const candidates: ArchiveOptimizationCandidateAgent[] = [];
  /** 每个候选产物是用哪一版 tsc 编出来的(冻结时要写进 `meta.tscVersion`)。 */
  const candidateTscVersions = new Map<number, string>();
  let validation: ArchiveValidation = NO_CHECK_VALIDATION;

  const maxSteps = request.maxSteps ?? AGENT_MAX_STEPS;
  const totalWallClockMs = request.totalWallClockMs ?? AGENT_TOTAL_WALL_CLOCK_MS;
  const startedAt = request.now().getTime();

  /**
   * 本次会话的那一张网格(一次会话一张,`evaluate` 与评分接缝共用同一份对象)。
   *
   * **惰性**:搬计划要 spawn 一次试跑入口(`--plan`),而一次会话可能一次 `evaluate` 都不做;
   * 也不在会话起点就把「装不出来」变成整场失败——那会把一次没用到网格的会话也一起赔进去。
   */
  let plan: TrialPlan | undefined;
  const planOf = (): TrialPlan => {
    plan ??= (request.trialPlan ?? ((options) => prepareTrialPlan(options.root, options.model)))({
      root: request.root,
      model: slug,
    });
    return plan;
  };

  // 宿主工具面(票 04):配额、会话墙钟、两个服务都在这里,一次会话一份实例。
  const facts = createStepFacts();
  const services = observeServices({
    root: request.root,
    model: slug,
    runId,
    plan: planOf,
    // 缺省走真试跑子进程(与 one-shot 时代同一个入口):`evaluate` 因此是真网格。
    trial: request.trial ?? runTrialScript,
    facts: facts.current,
  });
  const tools = createSessionTools({
    workspaceDir,
    deadlineAtMs: startedAt + totalWallClockMs,
    check: services.check,
    evaluate: services.evaluate,
    // 会话墙钟与 loop 用**同一个**钟。不传的话 dispatcher 默认走真实 `Date.now()`,
    // 而 `deadlineAtMs` 是从 `request.now()` 算出来的——两个钟一混,在注入了时钟的测试里
    // deadline 恒已过期(而生产上恰好看不出来,因为两者都是真实时间)。
    now: () => request.now().getTime(),
  });
  const executor = createExecutor({
    workspaceDir,
    rootfsDir: request.rootfsDir,
    tools,
    facts,
    ...(request.stepWallClockMs === undefined ? {} : { stepWallClockMs: request.stepWallClockMs }),
  });

  const client = request.createClient(config);
  const caliber =
    config.generationPolicy === undefined ? undefined : usageCaliberOf(config.endpointFamily);
  /**
   * 每次 loop 侧 `send` 的一桶尝试证据,按发生序。
   *
   * 一桶 = 一次 `model.send`(里面可能有若干传输重试),而**一步**可能有两次 `send`
   * (截断重试,ADR-0035)。所以桶与日志行不是一一对应:切行时必须按 `turn.attempts` 数,
   * 不能拿 turn 的下标去取——那样截断那一步的日志会拿到上一步的证据,而第二枪直接丢掉。
   */
  const sendEvidence: AttemptEvidence[][] = [];

  try {
    const loop = await runAgentSession({
      model: {
        send: async (messages: readonly ChatMessage[], sendParams: ModelParams) => {
          const evidence: AttemptEvidence[] = [];
          sendEvidence.push(evidence);
          const outcome = await sendWithTransportRetry({
            client,
            messages,
            params: sendParams,
            evidence,
            caliber,
          });
          // 抛给 loop 就是「传输重试耗尽」:那次调用不进过程记录、不进协议轮数(ADR-0031)。
          if (!outcome.ok) throw new Error(outcome.message);
          return outcome.response;
        },
      },
      executor,
      system: prompt.system,
      firstUser: prompt.user,
      params,
      contextLength,
      maxSteps,
      totalWallClockMs,
      now: () => request.now().getTime(),
    });

    // 生成日志:**一个日志行 = 一步 = 一组 attempts**(ADR-0032)。
    //
    // 轮号 = 步号;`attempts` 是截断重试的枪数(不占步)。所以这一行要装上**这一步全部**的
    // 发送侧证据:按 `turn.attempts` 从发生序里切一段。逐 turn 下标取(`sendEvidence[index]`)
    // 在截断重试时是错的——那一步有两次 send,于是下一行会拿到上一行的证据、第二枪丢掉。
    // 编号在**步内**连续(1..n):读侧(`attemptsOf`)按下标校验 `attempt === index + 1`。
    let cursor = 0;
    for (const turn of loop.turns) {
      const evidence = sendEvidence
        .slice(cursor, cursor + turn.attempts)
        .flat()
        .map((item, index) => ({ ...item, attempt: index + 1 }));
      cursor += turn.attempts;
      generationLog.push(
        logLine(
          turn.kind === "transport"
            ? {
                round: turn.round,
                kind: "transport",
                responseConverged: false,
                model: config.modelId,
                params,
                requestEvidence: generationRequestEvidence(config),
                attemptEvidence: evidence,
                sendMs: 0,
              }
            : {
                round: turn.round,
                kind: "converged",
                responseConverged: true,
                model: config.modelId,
                params,
                usage: caliber === undefined ? turn.usage : projectUsage(turn.usage, caliber),
                finishReason: turn.finishReason,
                attempts: turn.attempts,
                requestEvidence: generationRequestEvidence(config),
                attemptEvidence: evidence,
                sendMs: turn.sendMs,
              },
        ),
      );
    }

    // ── 候选:每一次真评出成绩的 evaluate 产出一个(顺序 = 第几次评测)。──
    //
    // 快照本身已经由 `evaluate` 服务在评测那一刻落进 `archive/<slug>/`(「快照即提交」),
    // 这里只做三件事:找它、读它的**字节**算产物摘要、把成绩拼进候选条目。重读工作区会把
    // 「评完之后又改过」混进成绩里,而模型可能只是想清理一下(ADR-0030)。
    const scoring =
      request.evaluateScoring ??
      scoreFromCandidateEvidence({ root: request.root, slug, plan: planOf });
    const archiveDir = join(request.root, "archive", slug);
    for (const step of loop.steps) {
      const submission = submissionOfStep(loop, step, runId);
      if (submission === undefined) continue;
      const scored = await scoring(submission);
      if (scored === undefined) continue;
      // `scriptSha256` 是**产物**的哈希(报告侧复算的就是 `.candidate.js` 的字节),不是
      // `evaluate` 报的那份源哈希——两者不是同一个数,混用会让每份档都读成 `mismatch`。
      const scriptFile = candidateScriptFile(submission.observationsFile);
      candidateTscVersions.set(step.step, submission.tscVersion);
      candidates.push({
        step: step.step,
        scriptFile,
        observationsFile: submission.observationsFile,
        scriptSha256: sha256Hex(readFileSync(join(archiveDir, scriptFile))),
        params: JSON.parse(JSON.stringify(params)) as never,
        score: scored.score,
        matchCount: scored.matchCount,
      });
    }
    // 校验结论取最后一次确实查过的 check(一次都没查过就记「没查」)。
    for (const step of loop.steps) {
      const result = step.result;
      if (result === undefined) continue;
      validation =
        result.kind === "tsc"
          ? { passed: false, errors: ["最后一次 check 的类型检查没通过", ...result.errorCodes] }
          : { passed: result.errorCodes.length === 0, errors: [...result.errorCodes] };
    }

    const agentFields: AgentArchiveFields = {
      steps: loop.steps,
      firstPrompt: prompt.user,
      contextLength,
      harnessVersion: identity.version,
      harnessDigest: identity.digest,
      termination: loop.termination,
      atStep: loop.atStep,
    };

    // ── 落档:有候选就有成绩,一个都没有就是失败档。──
    if (candidates.length === 0) {
      return {
        kind: "failed",
        slug,
        runId,
        agent: agentFields,
        failure: {
          classification: loop.termination === "transport" ? "transport" : "contract",
          prompts: [],
          generationLog,
          diagnostics: diagnosticLines(loop),
          message: messageOfNoCandidate(slug, loop),
        },
      };
    }

    // 成绩取最后一次 evaluate 的那一版:候选序的末位(ADR-0030)。
    //
    // 冻结的是**评估时那份快照**,不是会话停下时的工作区:模型在最后一次 `evaluate` 之后又改坏
    // 文件不影响成绩(它可能只是想清理一下)。屏幕上的 `script.ts` / `script.js` 与候选条目的
    // `scriptSha256` 因此字节同源。
    const final = candidates[candidates.length - 1]!;
    const frozen = freezeFromCandidate({
      root: request.root,
      slug,
      stagingDir,
      scriptFile: final.scriptFile,
      observationsFile: final.observationsFile,
      tscVersion: candidateTscVersions.get(final.step) ?? "",
    });
    if (!frozen.ok) {
      return {
        kind: "failed",
        slug,
        runId,
        agent: agentFields,
        failure: {
          classification: "contract",
          prompts: [],
          generationLog,
          diagnostics: frozen.diagnostics,
          message: `模型 ${slug}:${frozen.message}`,
          candidates,
        },
      };
    }
    validation = frozen.validation;

    const meta = buildArchiveMeta({
      model: slug,
      modelVersion: config.modelId,
      channelId: config.channelId,
      generatedAt: request.now().toISOString(),
      generationLog,
      validation,
      tscVersion: frozen.tscVersion,
      scriptSha256: frozen.scriptSha256,
      optimization: { version: 3, candidates } satisfies ArchiveOptimizationAgent,
      ...agentFields,
    });

    const commit = commitArchive({ root: request.root, slug, runId, stagingDir, meta });
    if (!commit.ok) {
      return {
        kind: "failed",
        slug,
        runId,
        agent: agentFields,
        failure: {
          classification: "contract",
          prompts: [],
          generationLog,
          diagnostics: [commit.reason],
          message: commit.reason,
          candidates,
        },
      };
    }
    committed = true;
    return { kind: "frozen", slug, runId, dir: commit.dir, meta };
  } finally {
    if (!committed) {
      discardStagingDir(stagingDir);
    }
  }
};

/**
 * 从 loop 的产出里还原那次 `evaluate` 的提交身份。
 *
 * 事实由执行器的回包带来(`AgentExecResult.submission`,见 `createExecutor`),但 `steps` 里只
 * 留过程记录的形状——所以身份是**步骤之外**的事实,它随 `AgentLoopResult.submissions` 走。
 * 这里按步号把它们对起来。
 */
const submissionOfStep = (
  loop: AgentLoopResult,
  step: ArchiveStep,
  runId: string,
): EvaluateSubmission | undefined => {
  const recorded = loop.submissions.find((item) => item.step === step.step);
  if (recorded === undefined) return undefined;
  return {
    step: step.step,
    call: recorded.call,
    scriptSha256: recorded.scriptSha256,
    hostPath: recorded.hostPath,
    tscVersion: recorded.tscVersion,
    observationsPath: recorded.observationsPath,
    // 候选证据族的名字由**步号**与 runId 定,不由派生视图的路径推:两者现在不在一处
    // (观测原料进档案,派生视图留在工作区),从 `.md` 的名字反推会直接拼出一个不存在的 basename。
    observationsFile: candidateObservationsFile(runId, step.step),
  };
};

/**
 * 把「最后一次 evaluate 评的那一版」从候选快照搬成三件套。
 *
 * ── 搬快照,不重读工作区 ──
 *
 * 成绩取**最后一次 `evaluate` 评的那个版本**(ADR-0030):模型可能在评完之后又改坏文件,而它
 * 可能只是想清理一下。所以冻结的字节只能是那次评测当场落下来的两份快照(「快照即提交」),
 * 不是会话停下时工作区里躺着的东西。
 *
 * 也不在这里重新编译:重编一次等于把「评的是哪份产物」换成「现在这段源码编出来是什么」,
 * 而两者一旦不等(编译器换了、配置换了),档案里的 `scriptSha256` 就不再指向被评过的那份。
 * 冻结期静态校验仍然真跑一遍:它是「冻结前最后一栏」的既有判据。
 *
 * 两个哈希在这里各归各位:**源**的 sha256 只在候选快照的文件名里(报告侧对不上时自己算),
 * 而档案契约要的 `meta.scriptSha256` 是**产物**的字节哈希(契约§3「复算认编译产物」)。
 */
const freezeFromCandidate = (options: {
  readonly root: string;
  readonly slug: string;
  readonly stagingDir: string;
  /** 候选条目的 `scriptFile`(产物快照的 basename)。 */
  readonly scriptFile: string;
  /** 候选条目的 `observationsFile`:用它找到同一族里的源码快照。 */
  readonly observationsFile: string;
  /** 那份产物是用哪一版 tsc 编出来的(评测时记的)。 */
  readonly tscVersion: string;
}):
  | {
      readonly ok: true;
      readonly tscVersion: string;
      readonly validation: ArchiveValidation;
      readonly scriptSha256: string;
    }
  | { readonly ok: false; readonly diagnostics: readonly string[]; readonly message: string } => {
  const archiveDir = join(options.root, "archive", options.slug);
  const sourcePath = join(archiveDir, candidateSourceFile(options.observationsFile));
  const scriptPath = join(archiveDir, options.scriptFile);
  const staged: { readonly source: string; readonly script: string } = {
    source: join(options.stagingDir, SCRIPT_SOURCE_NAME),
    script: join(options.stagingDir, SCRIPT_PRODUCT_NAME),
  };
  try {
    copyFileSync(sourcePath, staged.source);
    copyFileSync(scriptPath, staged.script);
  } catch (cause) {
    return {
      ok: false,
      message: "最后一次 evaluate 的候选快照读不到(源码或产物缺了一件)",
      diagnostics: [cause instanceof Error ? cause.message : String(cause)],
    };
  }
  const validated = validateScript({
    root: options.root,
    artifactPath: staged.script,
    maxBytes: scriptSizeLimit(options.root),
    phase: "freeze",
  });
  if (!validated.passed) {
    return {
      ok: false,
      message: "最后一次 evaluate 的那份脚本未通过冻结期静态校验",
      diagnostics: nonEmptyLines(validated.stdout),
    };
  }
  return {
    ok: true,
    tscVersion: options.tscVersion,
    validation: { passed: true, errors: nonEmptyLines(validated.stdout) },
    scriptSha256: sha256Hex(readFileSync(staged.script)),
  };
};

/**
 * 零候选时那一句人话。
 *
 * 三种「没产出」要说得出来,因为它们的处方不同:模型自己收工却没提交、最后一次 `evaluate`
 * 被拦下(值得读诊断)、或者根本没跑到 `evaluate`。
 */
const messageOfNoCandidate = (slug: string, loop: AgentLoopResult): string => {
  const head = `模型 ${slug} 的会话结束于 ${loop.termination}(第 ${String(loop.atStep)} 步),没有产出任何候选`;
  if (loop.termination === "done") return `${head}:模型自己收工了,但从未 evaluate 出成绩`;
  const lastEvaluate = [...loop.steps].reverse().find((step) => step.action.kind === "evaluate");
  if (lastEvaluate !== undefined) {
    return `${head}:最后一次 evaluate(第 ${String(lastEvaluate.step)} 步)没有产出成绩,被拦下或提交被拒,明细见诊断`;
  }
  return head;
};

/**
 * 失败档的诊断行:最后几步到底怎么了。
 *
 * ── 为什么两路输出都要看 ──
 *
 * 「命令失败」的证据常在 `stderr`(tsc 诊断、shell 报错),而 `evaluate` 被拦下的证据在
 * `stdout`(服务的 verdict 与试跑明细都是给模型读的**正常输出**,不是错误流)。只看 `stderr`
 * 会把「试跑拦下」写成一条空诊断——而那正是失败档唯一能回答「为什么没成绩」的东西。
 *
 * 取前两行而不是全量:诊断是给人读的一行提示清单,全文就在 `steps` 里(同一步的两路输出都已
 * 落盘),不在这里再复写一份。
 */
const diagnosticLines = (loop: AgentLoopResult): readonly string[] => {
  if (loop.steps.length === 0) {
    return [`一次模型调用都没有成功(${loop.termination})`];
  }
  return loop.steps.slice(-3).flatMap((step) => {
    const source = step.stderr.trim() === "" ? step.stdout : step.stderr;
    const lines = source
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .slice(0, 2);
    const head = `第 ${String(step.step)} 步(${step.action.kind},exit ${String(step.exitCode)}):`;
    return lines.length === 0
      ? [`${head} 两路输出都是空的`]
      : lines.map((line) => `${head} ${line}`);
  });
};
