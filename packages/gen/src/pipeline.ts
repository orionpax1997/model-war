/**
 * 单模型的生成轮:发一次 → 编译 → 静态校验 → 冻结期试跑 → 原子冻结,失败则**只回喂校验/试跑文本**再试
 * (hld §2.2.6 / §7.4;契约 §2.2 / §4)。
 *
 * ── 边界:≤N 轮只回喂校验文本;试跑轮次追加试跑文本 ──
 *
 * 一轮的全部动作(发 → 编译 → 迭代期校验 → 冻结期校验 → 冻结期试跑)收在 `sendOneRound` 里,吃**这一轮
 * 完整发出的 messages**,吐这一轮的结论(`RoundResult`)。`generateOneModel` 把它包进
 * `for` 循环:第 1 轮 = 初次生成;第 r>1 轮把上一轮驱动失败的**面向模型文本**逐字追加为一条
 * **新增的 user 消息**(前置一条 `assistant` = 上一轮模型回文本),每轮把**整个 messages 全量
 * 重发**——不依赖 provider 会话状态(契约 §2.2)。
 *
 * 回喂内容**只有**校验/试跑文本:合约静态校验失败 = 校验器 stdout;编译失败 = tsc 诊断文本;
 * 试跑拦下 = 试跑子进程 stdout（第几场、第几 tick、哪项预算、超了多少）。不加
 * 前后缀、不加引擎诊断、不含任何对局信息（试跑 stdout 本身就是面向模型的，不含胜负与名次）。轮数上限 `protocolRounds` 是**模型调用总轮数,
 * 含第 1 轮**(`config.protocolRounds ?? request.maxRounds ?? 5`),用尽即止。
 *
 * 显式 `scoreSourceFeedback` 固定生成三个有效候选，前两个各回喂自身事实。
 * 编译、静态与预算失败只消耗当前阶段诊断额度，每阶段统一沿用原默认五次响应；
 * 逐模型 `protocolRounds` 与测试注入的 `maxRounds` 只影响未启用时的总轮数。
 *
 * ── `prompts` / `generationLog` 逐轮追加 ──
 *
 * `meta.prompts[r]` = 第 r 轮那整份 transcript 的 `messages.map((m) => m.content).join("\n\n")`,
 * 长度 === 已收敛协议轮数(`buildArchiveMeta` 由它推 `protocolRounds`,两者相等是装载期不变量)。
 * `generationLog` 逐收敛轮一行；规范配置传输失败另有未收敛的末行证据。轮数用尽仍失败时,**不建** `archive/<slug>/<runId>/`,只返回
 * `{ kind: "failed", failure }`——失败记录写盘是 `packages/gen/src/failure.ts` 的活。
 *
 * ── 传输层错误的边界 ──
 *
 * 一次 `send` 由 `retry.ts` 的 `retryTransport` 包住:429 / 5xx / 网络失败 / 超时(可重试的
 * `TransportError`)与截断(`finishReason === "length"`)退避重发**同一轮**,不追加 messages、
 * 不占用 `protocolRounds`。规范配置在轮日志的 attemptEvidence 保留各次尝试；旧配置日志
 * 语义不变。重试耗尽或遇到不可重试的错误(400 / 缺凭证)→ 轮循环
 * 停在该轮,返回 `transport` 分类的 `failed`(写盘归 `packages/gen/src/failure.ts`)。
 *
 * ── `kind` 与 `errorCodes` 的取值 ──
 *
 * `kind` 取「驱动本轮结论的那一栏」:编译没过 → `tsc`;编译过了 → `contract`(校验与试跑阶段,
 * 过或不过都算它驱动,所以**成功轮的 kind 也是 `contract`**)。试跑拦下的轮与静态校验拦下的轮
 * 同属 `contract`（日志形状不为试跑另开一栏）；两者的区分只在人类可读的 `message`（见 `messageOfFailure`），
 * 不进机器字段。这一栏是「哪一栏驱动」的唯一可读标记。
 *
 * `errorCodes` 的来源**只有一处**:编译失败时从 tsc 诊断文本里拾取 `TS####`(可复算:同一份
 * 诊断文本总能捞出同一组码)。合约失败时**留空数组**,这是**有意写死的决定**,不是留白:
 * 校验器对本包只暴露三样——退出码、stdout、参数;stdout 是**面向模型的合并中文文本**,
 * 每条违规渲染成 `- [拦截|提示] <面向模型的说法> · …`,**没有机器码**。规则层的机器类别名
 * (`forbidden-global` 等)按渲染层的设计**刻意不进 stdout**(「类别名属于机器层……不进面向模型
 * 层的文字」,见 `packages/tools/src/validate/render-violations.ts` 头注),所以从 stdout 里取不到
 * 一个稳定的机器码;渲染层那张 `RULE_LABELS` 中文标签表是「面向模型的说法」而不是机器码,把它抬进
 * 这个机器字段等于把刻意分开的两侧又拆了回去。故本包不猜、不硬编码:合约轮 `errorCodes` 为空,
 * 靠 `kind` 告诉读者哪些轮由 `tsc` 驱动、哪些轮由 `contract` 驱动。
 *
 * `meta.validation` 记的是**判定本轮通过的相位**——迭代期(`--phase iteration`):通过判据就是它
 * (hld §2.2.6;契约 §3):tsc 零错误 **且** 迭代期无 blocking 违规;**只剩非 blocking 提示也算通过**,
 * 那些提示必须进 `validation.errors`(所以这里取 `iteration` 而不是 `freeze`;后述冻结期那一相
 * 的 blocking 判定已经把体积超限挡在提交前,故走到这里时迭代期也不会有 blocking 违规)。
 */

import { randomUUID } from "node:crypto";

import { constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";

import { basename, join } from "node:path";

import {
  OPTIMIZATION_GRID_VERSION,
  OPTIMIZATION_FEEDBACK_ROUNDS,
  OPTIMIZATION_STAGES,
  type ArchiveGridSelection,
  type ArchiveMeta,
  type TrialPlan,
  type ArchiveOptimizationCandidate,
  type ArchiveOptimizationGrid,
  type ArchiveValidation,
  type FailureClassification,
  type FailureRecord,
  type JsonValue,
} from "@model-war/schema";

import {
  buildArchiveMeta,
  commitArchive,
  discardStagingDir,
  openStagingDir,
  sha256Hex,
  SCRIPT_SOURCE_NAME,
  SCRIPT_PRODUCT_NAME,
} from "./archive.js";
import { compileScript } from "./compile.js";
import { extractScriptSource } from "./extract.js";
import type { ModelConfig } from "./config.js";
import { generationParams, generationRequestEvidence } from "./generation-policy.js";
import {
  projectUsage,
  responseAttemptEvidence,
  type AttemptEvidence,
} from "./generation-evidence.js";
import type { ChatMessage, ModelParams } from "./model-client.js";
import {
  missingTrialGridMatches,
  observationsPathOf,
  readTrialObservations,
  renderScoreSourceFeedback,
} from "./observations.js";
import { renderBaseTemplate } from "./prompt.js";
import { retryTransport, type TransportFailure } from "./retry.js";
import type { GenerationRequest } from "./run.js";
import { prepareTrialPlan, runTrialScript, type TrialProbe } from "./trial.js";
import { gridSummaryPathOf, readTrialGridSummary } from "./trial-grid.js";
import { gridEvidenceDigests, reuseTrialGrid, type ReusableGridEvidence } from "./trial-reuse.js";
import { runSelection, verifySelection, type SelectionArtifact } from "./selection.js";
import { scriptSizeLimit, validateScript } from "./validate.js";

/** 未在配置里给 `protocolRounds` 时的 gen 内部默认:模型调用总轮数,含第 1 轮。 */
const DEFAULT_PROTOCOL_ROUNDS = 5;

/** opt-in 批次统一：每阶段一次候选生成，再允许最多四次诊断修复。 */
const REPAIR_CALLS_PER_STAGE = 4;

/**
 * `meta.generationLog` 的收敛行形状(hld §2.2.6;契约 §2)。`kind`
 * 与 `errorCodes` 沿用既有取值；规范配置增加白名单请求与逐尝试证据。
 */
export type GenerationLogEntry = {
  /** 1 起;第 1 轮 = 初次生成。 */
  readonly round: number;
  /** 驱动本轮结论的那一栏:编译没过是 `tsc`,否则是 `contract`(校验阶段)。 */
  readonly kind: "tsc" | "contract";
  /** 实际调用的模型标识(与 `meta.model` / `meta.modelVersion` 的分工见 `generateOneModel`)。 */
  readonly model: string;
  readonly params: ModelParams;
  readonly usage: unknown;
  readonly finishReason: string;
  readonly requestEvidence?: ReturnType<typeof generationRequestEvidence>;
  readonly responseConverged?: true;
  readonly stopDetails?: import("./model-client.js").ModelResponse["stopDetails"];
  /** 收敛响应和所有尝试分别计数；逐尝试字段可能重叠，不作为账单求和。 */
  readonly attemptEvidence?: readonly AttemptEvidence[];
  /**
   * 本轮模型调用段的墙钟毫秒(整数):从发出第一次 `send` 到拿到回文本,**含退避重试的等待**
   * (重试是模型端延迟的一部分,也是用户真等的时间)。不含编译、校验与冻结期试跑——那些是本地
   * 动作,计进来会把对局时长灌进「模型耗时」。规范配置传输耗尽的耗时另记在传输末行。
   */
  readonly sendMs: number;
  /** 编译失败时是诊断里的 `TS####`;合约轮为空(来源与理由见文件头注)。 */
  readonly errorCodes: readonly string[];
};

/** 仅规范配置的失败记录可带此末行；不增加 prompts / protocolRounds，也不伪造收敛 usage。 */
export type GenerationTransportLogEntry = {
  readonly round: number;
  readonly kind: "transport";
  readonly model: string;
  readonly params: ModelParams;
  readonly requestEvidence: ReturnType<typeof generationRequestEvidence>;
  readonly responseConverged: false;
  readonly attemptEvidence: readonly AttemptEvidence[];
  readonly sendMs: number;
};

// 取值域的家在真源包(报告侧要按它分节渲染,是跨进程数据形状而非 gen 私有参数);
// 这里只是别名,不重列第二份取值表(同 `replay/index.ts` 的 `TickPayload = ReplayTickPayload` 先例)。
export type { FailureClassification };

export type ModelFailure = {
  readonly classification: FailureClassification;
  /** 该模型逐轮**完整发出**的 prompt 链(每轮一条 `messages.map(m => m.content).join("\n\n")`)。 */
  readonly prompts: readonly string[];
  /** 收敛日志；规范配置在传输失败时可另有一行 GenerationTransportLogEntry。 */
  readonly generationLog: readonly string[];
  /** 最终诊断(tsc 诊断行,或校验器 stdout 的非空行)。 */
  readonly diagnostics: readonly string[];
  /** 一行人类可读原因。 */
  readonly message: string;
  /**
   * 统一优化中途失败时已验证的有效候选描述（缺席 = 无有效候选或未开启优化）；
   * 写盘时原样进失败记录，供报告标识已有阶段；选拔失败保留全部三个候选。
   */
  readonly candidates?: readonly ArchiveOptimizationCandidate[];
  readonly selectionFailure?: FailureRecord["selectionFailure"];
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
    };

const nonEmptyLines = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

/** 从 tsc 诊断文本里拾取 `TS####` 错误码(去重,保持出现序)。 */
const tsErrorCodes = (diagnostics: string): readonly string[] => [
  ...new Set(diagnostics.match(/TS\d+/g) ?? []),
];

/** 一行日志条目(`meta.generationLog` 的每条一行就是这个序列化结果)。 */
const logLine = (entry: GenerationLogEntry): string => JSON.stringify(entry);

/** 契约 §2.2:一轮「完整发出的 prompt 文本」= 该轮整份 transcript 的 content 拼接。 */
const transcriptOf = (messages: readonly ChatMessage[]): string =>
  messages.map((message) => message.content).join("\n\n");

/** 一轮的结论:要么走到「冻结期校验通过」,要么在某一栏失败并带上**回喂文本**与诊断,
 * 要么一次 `send` 退避重试后仍失败(传输层收口,不消耗协议轮数)。 */
type RoundResult =
  | {
      readonly kind: "passed";
      /** 本轮模型回文本(下一轮把它当前置 `assistant` 消息)。 */
      readonly text: string;
      readonly tscVersion: string;
      readonly jsPath: string;
      /** 试跑前实际编译 JS 字节的身份，归属校验与冻结前复核共用。 */
      readonly scriptSha256: string;
      readonly sourceSha256: string;
      /** 记的迭代期(`--phase iteration`)那一次的结论:非 blocking 提示只在这一相存在。 */
      readonly validation: ArchiveValidation;
      readonly log: GenerationLogEntry;
      readonly observationsPath: string;
      /**
       * 本轮没有重跑网格：证据来自这一阶段的同字节候选（`reusedFromStage` 落进存档）。
       * 缺席 = 本轮自己跑满了整张网格。
       */
      readonly reusedFromStage?: 0 | 1 | 2;
    }
  | {
      readonly kind: "failed";
      /** 本轮模型回文本(下一轮把它当前置 `assistant` 消息)。 */
      readonly text: string;
      readonly classification: "tsc" | "contract";
      /**
       * 失败发生在哪一段：`static` = 试跑之前的任一栏（编译/tsc 与静态校验），
       * `trial` = 冻结期试跑。只决定人类可读的 `message`（见 `messageOfFailure`），
       * 不进 `generationLog`（那一栏的取值是两档）。
       */
      readonly stage: "static" | "trial";
      readonly log: GenerationLogEntry;
      /** 逐字回喂的**面向模型文本**:tsc 诊断、校验器 stdout 或试跑 stdout(契约 §2.2)。 */
      readonly feedback: string;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: "transport";
      /** 退避重试耗尽 / 不可重试的错误,由 `retry.ts` 收口(轮循环据此返回 `transport` 失败)。 */
      readonly failure: TransportFailure;
      readonly log?: GenerationTransportLogEntry;
    };

/**
 * 跑一轮:发一次 → 编译 → 迭代期校验 → 冻结期校验 → 冻结期试跑。
 *
 * 它吃**这一轮完整发出的 messages**(第 r>1 轮已含前置 `assistant` 与新增 `user` 回喂),
 * 把整份 transcript 全量重发。**传输层收口**:一次 `send` 由 `retryTransport` 包住,退避重试
 * 同一轮;重试耗尽 / 不可重试时返回 `kind:"transport"`(轮循环不涨轮数、不建存档)。落盘与失败
 * 清理归 `generateOneModel`。
 *
 * 试跑是冻结期校验通过之后的下一栏：用刚编译好的产物跑完整张评测网格（子进程，见 `trial.ts`），
 * 拦下即本轮失败（`contract` 分类、`trial` 段），回喂试跑 stdout 逐字。试跑子进程抛错
 *（infra，非 0/1 退出）不在这里收口——它不是候选的错，直接抛给编排层大声失败。
 */
const sendOneRound = async (options: {
  readonly request: GenerationRequest;
  readonly config: ModelConfig;
  readonly stagingDir: string;
  readonly messages: readonly ChatMessage[];
  readonly params: ModelParams;
  readonly maxBytes: number;
  readonly round: number;
  readonly trial: TrialProbe;
  /** 本轮 trial invocation 的观测落盘点（`observations.ts` 是路径真源）。 */
  readonly observationsPath: string;
  /** 本次生成共用的评测网格计划（`prepareTrialPlan` 那一次的输出，逐字交给入口）。 */
  readonly plan?: TrialPlan;
  /**
   * 同字节候选的网格复用：给一个 `scriptSha256`，回答「本次生成里更早的哪一阶段跑过它」。
   *
   * 查得到就不调试跑入口（省下一次 32 场），而是把那阶段的观测与 `.grid.json` 搬过来；
   * 查不到就照旧跑满整张网格。
   */
  readonly findReusable?: (scriptSha256: string) => ReusableGridEvidence | undefined;
}): Promise<RoundResult> => {
  const {
    request,
    config,
    stagingDir,
    messages,
    params,
    maxBytes,
    round,
    trial,
    observationsPath,
    plan,
    findReusable,
  } = options;
  // 一轮一个客户端:重试在**同一次 `send` 之内**完成(同一份 messages),协议轮数不动(契约 §2.1)。
  const client = request.createClient(config);
  const startedAt = performance.now();
  const attemptEvidence: AttemptEvidence[] = [];
  const attempt = await retryTransport({
    send: async () => {
      const number = attemptEvidence.length + 1;
      try {
        const response = await client.send(messages, params);
        attemptEvidence.push(responseAttemptEvidence(number, response));
        return response;
      } catch (cause) {
        attemptEvidence.push({ attempt: number, outcome: "transport-error" });
        throw cause;
      }
    },
  });
  const sendMs = Math.round(performance.now() - startedAt);
  if (!attempt.ok) {
    return {
      kind: "transport",
      failure: attempt.failure,
      ...(config.generationPolicy === undefined
        ? {}
        : {
            log: {
              round,
              kind: "transport" as const,
              model: config.modelId,
              params,
              requestEvidence: generationRequestEvidence(config),
              responseConverged: false as const,
              attemptEvidence,
              sendMs,
            },
          }),
    };
  }
  const response = attempt.response;
  const text = response.text;

  const base = {
    round,
    model: config.modelId,
    params,
    usage: config.generationPolicy === undefined ? response.usage : projectUsage(response.usage),
    finishReason: response.finishReason,
    ...(config.generationPolicy === undefined
      ? {}
      : {
          requestEvidence: generationRequestEvidence(config),
          responseConverged: true as const,
          stopDetails: responseAttemptEvidence(1, response).stopDetails,
          attemptEvidence,
        }),
    sendMs,
  } as const;

  // 模型裸文本先进剥包装再进编译(ADR-0012):围栏/引导语只包在头尾,剥后行号自第一行代码起算,
  // 诊断仍对得上;transcript 里留原文(回喂链可解释),落盘与校验都吃剥后文本。
  const compile = compileScript({
    root: request.root,
    stagingDir,
    source: extractScriptSource(text),
  });
  if (!compile.ok) {
    return {
      kind: "failed",
      text,
      classification: "tsc",
      stage: "static",
      log: { ...base, kind: "tsc", errorCodes: tsErrorCodes(compile.diagnostics) },
      // 编译失败的回喂文本 = tsc 诊断文本,逐字回喂(契约 §2.2)。
      feedback: compile.diagnostics,
      diagnostics: nonEmptyLines(compile.diagnostics),
    };
  }

  // 迭代期:体积只提示、不拦;blocking 违规才算失败。
  const iteration = validateScript({
    root: request.root,
    artifactPath: compile.jsPath,
    maxBytes,
    phase: "iteration",
  });
  if (!iteration.passed) {
    return {
      kind: "failed",
      text,
      classification: "contract",
      stage: "static",
      log: { ...base, kind: "contract", errorCodes: [] },
      // 合约失败的回喂文本 = 校验器 stdout,逐字回喂(契约 §2.2)。
      feedback: iteration.stdout,
      diagnostics: nonEmptyLines(iteration.stdout),
    };
  }

  // 冻结期:体积超限在这里硬拦。
  const freeze = validateScript({
    root: request.root,
    artifactPath: compile.jsPath,
    maxBytes,
    phase: "freeze",
  });
  if (!freeze.passed) {
    return {
      kind: "failed",
      text,
      classification: "contract",
      stage: "static",
      log: { ...base, kind: "contract", errorCodes: [] },
      feedback: freeze.stdout,
      diagnostics: nonEmptyLines(freeze.stdout),
    };
  }

  // 冻结期试跑：按计划跑完整张评测网格，任一场预算超限即本轮失败（`contract` 分类、`trial` 段）。
  // 回喂试跑 stdout 逐字——它是面向模型的（第几场、第几 tick、哪项预算、超了多少），
  // 不含胜负与名次，走既有回喂通道，不需要新格式。
  const scriptSha256 = sha256Hex(readFileSync(compile.jsPath));
  const sourceSha256 = sha256Hex(readFileSync(join(stagingDir, SCRIPT_SOURCE_NAME)));
  if (request.scoreSourceFeedback === true) {
    // 独占保存每轮候选；下一轮会重写 staging JS，但不能丢掉反馈的来源字节。
    // 网格汇总与观测同源，也按同一条纪律：任一已存在就整轮拒绝，不覆盖既有证据。
    if (existsSync(observationsPath) || existsSync(gridSummaryPathOf(observationsPath))) {
      throw new Error("本轮试跑观测已存在，拒绝覆盖或复用旧候选证据");
    }
    copyFileSync(compile.jsPath, `${observationsPath}.candidate.js`, constants.COPYFILE_EXCL);
    copyFileSync(
      join(stagingDir, SCRIPT_SOURCE_NAME),
      `${observationsPath}.candidate.ts`,
      constants.COPYFILE_EXCL,
    );
  }
  // 字节守卫之后先看能不能复用：同一次生成里更早阶段跑过**完全相同**的编译产物时，
  // 网格的输入身份（计划摘要 + 候选摘要 + 运行时）与那次逐字相同，所以不必重跑 32 场。
  // 复用只省「跑」不省「查」：搬证据前逐关校验（来源字节摘要、计划同源、观测完整、
  // 搬完逐场逐字比对），见 `trial-reuse.ts` 头注。
  const reusable = findReusable?.(scriptSha256);
  if (reusable !== undefined && plan === undefined)
    throw new Error("复用网格证据需要本次生成的评测计划（计划是它的身份）");
  const trialResult =
    reusable === undefined
      ? trial({
          root: request.root,
          model: config.slug,
          artifactPath: compile.jsPath,
          observationsPath,
          ...(plan === undefined ? {} : { plan }),
        })
      : undefined;
  if (reusable !== undefined && plan !== undefined) {
    reuseTrialGrid({ source: reusable, targetObservationsPath: observationsPath, plan });
  }
  if (sha256Hex(readFileSync(join(stagingDir, SCRIPT_SOURCE_NAME))) !== sourceSha256)
    throw new Error("试跑期间 TS 字节改变");
  if (sha256Hex(readFileSync(compile.jsPath)) !== scriptSha256) {
    throw new Error("试跑期间编译 JS 字节改变，拒绝使用错配的试跑结论");
  }
  if (trialResult !== undefined && !trialResult.passed) {
    return {
      kind: "failed",
      text,
      classification: "contract",
      stage: "trial",
      log: { ...base, kind: "contract", errorCodes: [] },
      feedback: trialResult.stdout,
      diagnostics: nonEmptyLines(trialResult.stdout),
    };
  }

  return {
    kind: "passed",
    text,
    tscVersion: compile.tscVersion,
    jsPath: compile.jsPath,
    scriptSha256,
    sourceSha256,
    // 记迭代期的结论(不是冻结期那一相):通过判据就是迭代期,非 blocking 提示也只在这一相存在。
    validation: { passed: iteration.passed, errors: iteration.errors },
    log: { ...base, kind: "contract", errorCodes: [] },
    observationsPath,
    ...(reusable === undefined ? {} : { reusedFromStage: reusable.stage }),
  };
};

const messageOfFailure = (slug: string, result: RoundResult & { kind: "failed" }): string => {
  if (result.classification === "tsc") {
    return `模型 ${slug} 第 ${String(result.log.round)} 轮 tsc 编译失败`;
  }
  return result.stage === "trial"
    ? `模型 ${slug} 第 ${String(result.log.round)} 轮冻结期试跑未通过`
    : `模型 ${slug} 第 ${String(result.log.round)} 轮静态校验未通过`;
};

/**
 * 成对发布旁挂证据：观测与它旁挂的 `.grid.json` **要么都在、要么都不在**。
 *
 * 为什么不能逐份 `copyFileSync` 然后各管各的：两份是一件事的两个面（「这份最终候选跑了哪张
 * 网格、得多少分」），只发观测会在兼容路径上留下一份没有计划的读数；只发汇总则留下一个说不清
 * 谁跑过的分数。所以先全部复制到同目录的临时名，再依次 rename 成真名：任一步失败就把本次已
 * 发布的那份与剩下所有临时文件都清掉，绝不留下半套。
 *
 * 失败不抛：发布只属**旁证**（候选已通过、存档已原子落盘），所以沿用「复制失败只警告」的语义，
 * 一行一句地写 stderr。清理失败也不掩盖原始原因。
 */
const publishPairedEvidence = (
  pairs: readonly (readonly [from: string, to: string])[],
  warn: (message: string) => void,
): void => {
  const temporaries: string[] = [];
  const published: string[] = [];
  let target = pairs[0]?.[1] ?? "";
  try {
    for (const [from, to] of pairs) {
      // 临时名取 `to` 的同目录兄弟：rename 不会跨设备，目标名也不会被别人的同名文件认领。
      const temporary = `${to}.${randomUUID()}.tmp`;
      copyFileSync(from, temporary, constants.COPYFILE_EXCL);
      temporaries.push(temporary);
    }
    for (const [index, pair] of pairs.entries()) {
      target = pair[1];
      renameSync(temporaries[index]!, target);
      published.push(target);
    }
  } catch (cause) {
    // 已 rename 成真的那份也要撤回：留下它就是半套。
    for (const path of [...temporaries, ...published]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // 清理失败不抛，也不掩盖原始原因；下一次生成会重新写这两份。
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    warn(
      `modelwar gen: 警告：最终试跑观测发布失败 ${target}（已撤回本次发布的全部旁证）：${message}\n`,
    );
  }
};

/**
 * 这次生成的优化旁证（v2）：整张计划与四份陪练身份入档，每个候选带网格分数与场数。
 *
 * 陪练身份**从计划的 `scripts` 搬**（不另写一份）：计划的这两栏是同一格事实，
 * 装载期会逐项比对（`archive-optimization.ts`）。
 *
 * 不写 `trialSeeds`：v1 那三个固定种子在网格里根本不是一个数（每格一个，见 `plan.matches[].seed`
 * 与 `planSha256`）。再存一份就是同一件事的第二个家，还会让人以为「种子只有三个」。
 */
const archiveOptimizationOf = (
  plan: TrialPlan,
  candidates: readonly ArchiveOptimizationCandidate[],
): ArchiveOptimizationGrid => ({
  version: OPTIMIZATION_GRID_VERSION,
  feedbackRounds: OPTIMIZATION_FEEDBACK_ROUNDS,
  plan,
  sparring: plan.scripts.map(({ id, role, source, scriptSha256 }) => ({
    id,
    role,
    source,
    scriptSha256,
  })),
  candidates,
});

/**
 * 单模型逐轮回喂环：未启用时直到通过或用尽总尝试数；启用时每阶段独立诊断额度，
 * 前两个有效候选各提供事实回喂；第三阶段完成后可独立选拔并冻结胜者。
 *
 * 失败时**不建** `archive/<slug>/<runId>/`:临时组装目录被清理,只返回 `failed` 结果(携全部
 * 已收敛轮次的 prompts / generationLog，规范配置额外保存传输失败末行证据)。传输层失败
 * (退避重试耗尽 / 不可重试)同样只返回 transport 分类的 failed，不建存档(失败写盘归
 * `packages/gen/src/failure.ts`)。
 */
export const generateOneModel = async (
  request: GenerationRequest,
  config: ModelConfig,
): Promise<ModelOutcome> => {
  if (request.selectBestCandidate === true && request.scoreSourceFeedback !== true)
    throw new Error("--select-best-candidate 要求 --score-source-feedback");
  const slug = config.slug;
  // 一次生成只定义一张评测网格：三份候选都按它跑，读观测与判完整性也按它（不逐轮重造）。
  // 造计划要读盘算摘要，所以生产路径只能经子进程搬（本包不得跨到 runner 那一侧）；
  // 测试注入同形状的纯函数，保持单测毫秒级。
  const preparePlan =
    request.trialPlan ??
    ((options: { readonly root: string; readonly model: string }) =>
      prepareTrialPlan(options.root, options.model));
  const trialPlan =
    request.scoreSourceFeedback === true
      ? preparePlan({ root: request.root, model: slug })
      : undefined;
  /**
   * 选拔用的计划就是生成阶段这张网格的**同一份对象**（`planSha256` 必然相等，不存在
   * 「两份计划之间有时间窗」的坑）。选拔子进程会按安装面重建一遍并与它逐字比：
   * 换图、换座位、换种子、换一份陪练摘要都在那里被指到具体位置。
   */
  const expectedPlan = request.selectBestCandidate === true ? trialPlan : undefined;
  const runId = request.runId;
  const params: ModelParams = generationParams(config);
  // 优化机会与修复上限对全部模型统一；旧模式仍按配置优先并接受 maxRounds 替代默认值。
  const protocolRounds =
    request.scoreSourceFeedback === true
      ? 1 + REPAIR_CALLS_PER_STAGE
      : (config.protocolRounds ?? request.maxRounds ?? DEFAULT_PROTOCOL_ROUNDS);
  const totalRounds =
    protocolRounds * (request.scoreSourceFeedback === true ? OPTIMIZATION_STAGES.length : 1);
  const maxBytes = scriptSizeLimit(request.root);
  // 缺席即真子进程（`trial.ts`）：生产冻结前必跑整张网格；测试注入桩，保持单测毫秒级。
  const trial: TrialProbe = request.trial ?? runTrialScript;
  // 默认每轮重写原路径；opt-in trial 写独立 round 文件，最终候选才发布到原路径。
  const observationsPath = observationsPathOf(request.root, slug, runId);

  const basePrompt = renderBaseTemplate(request.template, request.docs, config.strategy);
  // 无状态全量重发:每轮把整个 messages 发出,后续轮在其后追加 assistant + user(契约 §2.2)。
  let messages: readonly ChatMessage[] = [{ role: "user", content: basePrompt }];
  const prompts: string[] = [];
  const generationLog: string[] = [];

  const stagingDir = openStagingDir(request.root, slug);
  let committed = false;
  const candidates: ArchiveOptimizationCandidate[] = [];
  const selectionArtifacts: SelectionArtifact[] = [];
  const candidateValidations: ArchiveValidation[] = [];
  // 本次生成里已收录的网格证据：下一轮候选字节与其中哪个阶段相同，就复用那一份（不重跑网格）。
  const acceptedGrids: ReusableGridEvidence[] = [];
  let stageAttempts = 0;
  try {
    for (let round = 1; round <= totalRounds; round += 1) {
      stageAttempts += 1;
      const result = await sendOneRound({
        request,
        config,
        stagingDir,
        messages,
        params,
        maxBytes,
        round,
        trial,
        observationsPath:
          request.scoreSourceFeedback === true
            ? observationsPathOf(request.root, slug, runId, round)
            : observationsPath,
        ...(trialPlan === undefined ? {} : { plan: trialPlan }),
        ...(trialPlan === undefined
          ? {}
          : {
              findReusable: (scriptSha256: string) =>
                acceptedGrids.find((evidence) => evidence.scriptSha256 === scriptSha256),
            }),
      });

      // 未收敛轮不增加 prompts / protocolRounds；规范配置另记白名单传输末行。
      if (result.kind === "transport") {
        if (result.log !== undefined) generationLog.push(JSON.stringify(result.log));
        return {
          kind: "failed",
          slug,
          runId,
          failure: {
            classification: "transport",
            prompts,
            generationLog,
            diagnostics: result.failure.diagnostics,
            ...(candidates.length > 0 ? { candidates } : {}),
            message:
              `模型 ${slug} 第 ${String(round)} 轮传输失败:${result.failure.message}` +
              (request.scoreSourceFeedback === true
                ? `（优化阶段 ${String(candidates.length)}）`
                : ""),
          },
        };
      }

      // 该轮已收敛(通过 / 校验失败):完整 transcript 与日志逐条对齐。
      // 规范配置传输末行是额外尝试证据，不属于已收敛轮次。
      prompts.push(transcriptOf(messages));
      generationLog.push(logLine(result.log));

      let feedback: string;
      if (result.kind === "passed") {
        const readings =
          request.scoreSourceFeedback === true && trialPlan !== undefined
            ? readTrialObservations(result.observationsPath, result.scriptSha256, trialPlan)
            : undefined;
        if (request.scoreSourceFeedback === true && trialPlan !== undefined) {
          // 读入边界已严格验证每个存在的摘要；新优化阶段还必须有**整张网格**的完整终局。
          // 历史观测仍可缺摘要读取，但不能据此推进本次反馈或发布最终候选。
          // 复用路径同样跑这一道：复用不是不校验的借口（`trial-reuse.ts` 已校过来源，
          // 这里校的是「搬到本阶段落点后的那份证据」）。
          const missing = missingTrialGridMatches(readings ?? [], trialPlan);
          if (readings === undefined || missing.length > 0) {
            throw new Error(
              `统一事实反馈缺少完整评测网格的有效终局摘要（计划 ${String(trialPlan.matches.length)} 场，缺 matchIndex ${missing.map(String).join(" / ")}），优化阶段 ${String(candidates.length)} 未完成，拒绝推进或冻结候选`,
            );
          }
          // 旁挂的网格汇总必须与本次 expected plan 逐字相同：换图/换座位/换种子/换陪练即整批失败。
          // 汇总里的 `score` 只过形状（分母恒等于计划声明的场数）：生成侧**不重算分数**，
          // 复算与逐位比对落在选拔，落档落在存档——这一份的 `score` 就是该候选唯一的成绩。
          const summary = readTrialGridSummary({
            path: gridSummaryPathOf(result.observationsPath),
            expectedPlan: trialPlan,
            scriptSha256: result.scriptSha256,
          });
          const stage = OPTIMIZATION_STAGES[candidates.length];
          if (stage === undefined) throw new Error("有效候选阶段超出优化政策");
          candidates.push({
            stage,
            protocolRound: round,
            scriptFile: basename(`${result.observationsPath}.candidate.js`),
            observationsFile: basename(result.observationsPath),
            scriptSha256: result.scriptSha256,
            // 参数原样落档：日后查证「这份候选当时用什么参数生成的」不必翻四行 log，
            // 也不必猜 mapping。与 `generationLog[].params` 同源（同一个 `params` 变量）。
            // `JSON.parse(JSON.stringify(...))` 保证落档的是 JSON 值（不携带 undefined / 共享引用）。
            params: JSON.parse(JSON.stringify(params)) as JsonValue,
            // 成绩与反馈同源：分数与场数逐字来自这一轮的 `.grid.json`。
            score: summary.score,
            matchCount: trialPlan.matchesPerCandidate,
            ...(result.reusedFromStage === undefined
              ? {}
              : { reusedFromStage: result.reusedFromStage }),
          });
          // 收录本阶段证据，供后续同字节候选复用（摘要取的就是刚校过的那份字节）。
          acceptedGrids.push({
            stage,
            scriptSha256: result.scriptSha256,
            observationsPath: result.observationsPath,
            ...gridEvidenceDigests(result.observationsPath),
          });
          selectionArtifacts.push({
            stage,
            protocolRound: round,
            scriptSha256: result.scriptSha256,
            sourceSha256: result.sourceSha256,
            scriptPath: `${result.observationsPath}.candidate.js`,
            sourcePath: `${result.observationsPath}.candidate.ts`,
            // 选拔复算的比对基准：这一阶段的观测行与它旁挂的网格汇总（分数与计划都来自它）。
            observationsPath: result.observationsPath,
            gridSummaryPath: gridSummaryPathOf(result.observationsPath),
          });
          candidateValidations.push(result.validation);
          // 每次推进前复核已有旁证；下一阶段不能替换首次候选后仍发布成功存档。
          for (const candidate of candidates) {
            const savedPath = join(request.root, "archive", slug, candidate.scriptFile);
            if (sha256Hex(readFileSync(savedPath)) !== candidate.scriptSha256) {
              throw new Error("旁挂候选 JS 字节改变，拒绝使用错配的优化历史");
            }
          }
        }
        if (
          readings !== undefined &&
          trialPlan !== undefined &&
          candidates.length <= OPTIMIZATION_FEEDBACK_ROUNDS
        ) {
          stageAttempts = 0;
          // 上一层候选的读数作为「上一阶段」的对照：对差表据此给出同一格的变化。
          // 第一次回喂（刚跑完第 0 阶段）没有上一阶段，所以传 undefined。
          const earlier = candidates[candidates.length - 2];
          const previousReadings =
            earlier === undefined
              ? undefined
              : readTrialObservations(
                  join(request.root, "archive", slug, earlier.observationsFile),
                  earlier.scriptSha256,
                  trialPlan,
                );
          // 对照看观测读不到就不回喂：只给本阶段数字会让「差距在缩小还是扩大」变成猜的。
          if (earlier !== undefined && previousReadings === undefined)
            throw new Error("上一阶段观测读不到（无法给出与上一阶段同一格的变化），拒绝回喂");
          // 候选自己的字节摘要第四个交：反馈据此把「与某位对手字节相同」的场逐场标出来。
          feedback = renderScoreSourceFeedback(
            readings,
            trialPlan,
            previousReadings,
            result.scriptSha256,
          );
        } else {
          // 现场读编译产物字节算 sha256:复算认的是产物,不是内存里那份源文本。
          let scriptBytes = readFileSync(result.jsPath);
          if (sha256Hex(scriptBytes) !== result.scriptSha256) {
            throw new Error("试跑后编译 JS 字节改变，拒绝冻结未经验证的候选");
          }
          let selection: ArchiveGridSelection | undefined;
          let validation = result.validation;
          if (expectedPlan !== undefined) {
            const probed: unknown = await (request.selection ?? runSelection)({
              root: request.root,
              model: slug,
              candidates: structuredClone(selectionArtifacts),
              expectedPlan: structuredClone(expectedPlan),
            });
            selection = verifySelection({
              root: request.root,
              candidates: selectionArtifacts,
              expectedPlan,
              selection: probed,
            });
            const winner = selectionArtifacts[selection.selected.stage];
            if (winner === undefined) throw new Error("选拔缺少胜者字节");
            copyFileSync(winner.sourcePath, join(stagingDir, SCRIPT_SOURCE_NAME));
            copyFileSync(winner.scriptPath, join(stagingDir, SCRIPT_PRODUCT_NAME));
            const freeze = validateScript({
              root: request.root,
              artifactPath: join(stagingDir, SCRIPT_PRODUCT_NAME),
              maxBytes,
              phase: "freeze",
            });
            if (!freeze.passed) throw new Error("选拔胜者冻结期校验失败");
            scriptBytes = readFileSync(join(stagingDir, SCRIPT_PRODUCT_NAME));
            validation = candidateValidations[selection.selected.stage]!;
          }
          const meta = buildArchiveMeta({
            model: slug,
            // modelId 是带 provider 前缀的快照标识(配置里唯一能标识「哪一版模型」的字段)。
            modelVersion: config.modelId,
            generatedAt: request.now().toISOString(),
            prompts,
            generationLog,
            validation,
            ...(selection === undefined ? {} : { selection }),
            tscVersion: result.tscVersion,
            scriptSha256: sha256Hex(scriptBytes),
            ...(request.scoreSourceFeedback === true && trialPlan !== undefined
              ? { optimization: archiveOptimizationOf(trialPlan, candidates) }
              : {}),
          });

          if (selection !== undefined && expectedPlan !== undefined)
            verifySelection({
              root: request.root,
              candidates: selectionArtifacts,
              expectedPlan,
              selection,
            });
          const commit = commitArchive({ root: request.root, slug, runId, stagingDir, meta });
          if (!commit.ok) {
            return {
              kind: "failed",
              slug,
              runId,
              failure: {
                classification: selection === undefined ? "contract" : "selection",
                ...(expectedPlan === undefined
                  ? {}
                  : {
                      selectionFailure: {
                        plan: expectedPlan,
                        candidates: selectionArtifacts.map(
                          ({ stage, protocolRound, scriptSha256, sourceSha256 }) => ({
                            stage,
                            protocolRound,
                            scriptSha256,
                            sourceSha256,
                          }),
                        ),
                      },
                    }),
                prompts,
                generationLog: meta.generationLog,
                diagnostics: [selection === undefined ? commit.reason : "选拔胜者原子发布失败"],
                ...(candidates.length > 0
                  ? {
                      candidates:
                        selection === undefined
                          ? candidates.filter((candidate) => candidate.stage < 2)
                          : candidates,
                    }
                  : {}),
                message:
                  selection !== undefined
                    ? "选拔胜者原子发布失败"
                    : request.scoreSourceFeedback === true
                      ? `${commit.reason}（优化阶段 2：候选已通过，最终存档发布失败）`
                      : commit.reason,
              },
            };
          }
          committed = true;
          // 拒绝撞名时不发布：既有候选的最终观测不能被失败尝试覆盖。
          // 发布只属旁证：复制失败只警告，不改变已通过候选的结论。
          // `.grid.json` 与观测同源，必须**成对**发布：只发观测会让「这份最终候选跑了哪张网格、
          // 得多少分」在兼容路径上断掉（报告侧读最终档时只剩一份没有计划的观测）。
          if (readings !== undefined) {
            const summaryPath = gridSummaryPathOf(result.observationsPath);
            publishPairedEvidence(
              [
                [result.observationsPath, observationsPath],
                [summaryPath, gridSummaryPathOf(observationsPath)],
              ],
              (message) => process.stderr.write(message),
            );
          }
          return { kind: "frozen", slug, runId, dir: commit.dir, meta };
        }
      } else {
        feedback = result.feedback;
      }

      // 当前阶段用尽总尝试数仍失败；诊断修复不推进有效候选阶段。
      if (result.kind === "failed" && stageAttempts === protocolRounds) {
        return {
          kind: "failed",
          slug,
          runId,
          failure: {
            classification: result.classification,
            prompts,
            generationLog,
            diagnostics: result.diagnostics,
            ...(candidates.length > 0 ? { candidates } : {}),
            message:
              request.scoreSourceFeedback === true
                ? `${messageOfFailure(slug, result)}（优化阶段 ${String(candidates.length)}，已用尽 ${String(protocolRounds)} 次阶段响应，含至多 ${String(REPAIR_CALLS_PER_STAGE)} 次诊断修复）`
                : messageOfFailure(slug, result),
          },
        };
      }

      // 回喂:前置 assistant(上一轮回文本)+ 新增 user(上一轮驱动失败的面向模型文本),
      // 两者都逐字入 transcript,下一轮全量重发。
      messages = [
        ...messages,
        { role: "assistant", content: result.text },
        { role: "user", content: feedback },
      ];
    }
    // `protocolRounds >= 1`,循环必然在上面某轮 return;这里只是让类型收口。
    throw new Error(`模型 ${slug} 的回喂环没有产出结论(protocolRounds=${String(protocolRounds)})`);
  } catch (cause) {
    if (expectedPlan !== undefined && candidates.length === 3) {
      return {
        kind: "failed",
        slug,
        runId,
        failure: {
          classification: "selection",
          prompts,
          generationLog,
          candidates,
          diagnostics: ["选拔执行或完整证据校验失败"],
          message: "完成三阶段后选拔失败，未发布冻结档",
          selectionFailure: {
            plan: expectedPlan,
            candidates: selectionArtifacts.map(
              ({ stage, protocolRound, scriptSha256, sourceSha256 }) => ({
                stage,
                protocolRound,
                scriptSha256,
                sourceSha256,
              }),
            ),
          },
        },
      };
    }
    throw cause;
  } finally {
    // 成功时 rename 已经把临时目录搬走,这里是空操作;失败 / 抛错时整棵清掉,不留半截。
    if (!committed) {
      discardStagingDir(stagingDir);
    }
  }
};
