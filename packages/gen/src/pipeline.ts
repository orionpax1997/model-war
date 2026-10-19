/**
 * 单模型的生成轮:发一次 → 编译 → 静态校验 → 冻结期试跑 → 原子冻结,失败则**只回喂校验/试跑文本**再试
 * (hld §2.2.6 / §7.4;契约 §2.2 / §4)。
 *
 * ── 票 04 的边界:≤N 轮只回喂校验文本;试跑票追加试跑文本 ──
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
 * `{ kind: "failed", failure }`——失败记录写盘是票 05 的活。
 *
 * ── 传输层错误的边界 ──
 *
 * 一次 `send` 由 `retry.ts` 的 `retryTransport` 包住:429 / 5xx / 网络失败 / 超时(可重试的
 * `TransportError`)与截断(`finishReason === "length"`)退避重发**同一轮**,不追加 messages、
 * 不占用 `protocolRounds`。规范配置在轮日志的 attemptEvidence 保留各次尝试；旧配置日志
 * 语义不变。重试耗尽或遇到不可重试的错误(400 / 缺凭证)→ 轮循环
 * 停在该轮,返回 `transport` 分类的 `failed`(写盘归票 05)。
 *
 * ── `kind` 与 `errorCodes` 的取值(票 07 定稿) ──
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

import { constants, copyFileSync, existsSync, readFileSync } from "node:fs";

import { basename, join } from "node:path";

import {
  OPTIMIZATION_VERSION,
  OPTIMIZATION_FEEDBACK_ROUNDS,
  OPTIMIZATION_STAGES,
  TRIAL_SEEDS,
  type ArchiveMeta,
  type ArchiveSelection,
  type ArchiveOptimizationCandidate,
  type ArchiveValidation,
  type FailureClassification,
  type FailureRecord,
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
  observationsPathOf,
  readTrialObservations,
  renderScoreSourceFeedback,
} from "./observations.js";
import { renderBaseTemplate } from "./prompt.js";
import { retryTransport, type TransportFailure } from "./retry.js";
import type { GenerationRequest } from "./run.js";
import { runTrialScript, type TrialProbe } from "./trial.js";
import {
  prepareSelection,
  runSelection,
  verifySelection,
  type SelectionArtifact,
} from "./selection.js";
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
  /** 编译失败时是诊断里的 `TS####`;合约轮为空(来源与理由见文件头注,票 07 定稿)。 */
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
    }
  | {
      readonly kind: "failed";
      /** 本轮模型回文本(下一轮把它当前置 `assistant` 消息)。 */
      readonly text: string;
      readonly classification: "tsc" | "contract";
      /**
       * 失败发生在哪一段：`static` = 试跑之前的任一栏（编译/tsc 与静态校验），
       * `trial` = 冻结期试跑。只决定人类可读的 `message`（见 `messageOfFailure`），
       * 不进 `generationLog`（那一栏的取值仍是票 07 定稿的两档）。
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
 * 试跑是冻结期校验通过之后的下一栏：用刚编译好的产物跑三场完整对局（子进程，见 `trial.ts`），
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

  // 冻结期试跑：三场完整对局，任一场预算超限即本轮失败（`contract` 分类、`trial` 段）。
  // 回喂试跑 stdout 逐字——它是面向模型的（第几场、第几 tick、哪项预算、超了多少），
  // 不含胜负与名次，走既有回喂通道，不需要新格式。
  const scriptSha256 = sha256Hex(readFileSync(compile.jsPath));
  const sourceSha256 = sha256Hex(readFileSync(join(stagingDir, SCRIPT_SOURCE_NAME)));
  if (request.scoreSourceFeedback === true) {
    // 独占保存每轮候选；下一轮会重写 staging JS，但不能丢掉反馈的来源字节。
    if (existsSync(observationsPath)) {
      throw new Error("本轮试跑观测已存在，拒绝覆盖或复用旧候选证据");
    }
    copyFileSync(compile.jsPath, `${observationsPath}.candidate.js`, constants.COPYFILE_EXCL);
    copyFileSync(
      join(stagingDir, SCRIPT_SOURCE_NAME),
      `${observationsPath}.candidate.ts`,
      constants.COPYFILE_EXCL,
    );
  }
  const trialResult = trial({
    root: request.root,
    artifactPath: compile.jsPath,
    observationsPath,
  });
  if (sha256Hex(readFileSync(join(stagingDir, SCRIPT_SOURCE_NAME))) !== sourceSha256)
    throw new Error("试跑期间 TS 字节改变");
  if (sha256Hex(readFileSync(compile.jsPath)) !== scriptSha256) {
    throw new Error("试跑期间编译 JS 字节改变，拒绝使用错配的试跑结论");
  }
  if (!trialResult.passed) {
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
 * 单模型逐轮回喂环：未启用时直到通过或用尽总尝试数；启用时每阶段独立诊断额度，
 * 前两个有效候选各提供事实回喂；第三阶段完成后可独立选拔并冻结胜者。
 *
 * 失败时**不建** `archive/<slug>/<runId>/`:临时组装目录被清理,只返回 `failed` 结果(携全部
 * 已收敛轮次的 prompts / generationLog，规范配置额外保存传输失败末行证据)。传输层失败
 * (退避重试耗尽 / 不可重试)同样只返回 transport 分类的 failed，不建存档(失败写盘归票 05)。
 */
export const generateOneModel = async (
  request: GenerationRequest,
  config: ModelConfig,
): Promise<ModelOutcome> => {
  if (request.selectBestCandidate === true && request.scoreSourceFeedback !== true)
    throw new Error("--select-best-candidate 要求 --score-source-feedback");
  const expectedPlan =
    request.selectBestCandidate === true ? prepareSelection(request.root) : undefined;
  const slug = config.slug;
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
  // 缺席即真子进程（`trial.ts`）：生产冻结前必跑三场；测试注入桩，保持单测毫秒级。
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
          request.scoreSourceFeedback === true
            ? readTrialObservations(result.observationsPath, result.scriptSha256)
            : undefined;
        if (request.scoreSourceFeedback === true) {
          // 读入边界已严格验证每个存在的摘要；新优化阶段还必须有固定三场完整终局。
          // 历史观测仍可缺摘要读取，但不能据此推进本次反馈或发布最终候选。
          if (
            readings === undefined ||
            readings.length !== TRIAL_SEEDS.length ||
            !TRIAL_SEEDS.every((_, matchIndex) =>
              readings.some(
                (reading) =>
                  reading.matchIndex === matchIndex && reading.terminalSummary !== undefined,
              ),
            )
          ) {
            throw new Error(
              `统一事实反馈缺少完整三场有效终局摘要（matchIndex 0/1/2），优化阶段 ${String(candidates.length)} 未完成，拒绝推进或冻结候选`,
            );
          }
          const stage = OPTIMIZATION_STAGES[candidates.length];
          if (stage === undefined) throw new Error("有效候选阶段超出优化政策");
          candidates.push({
            stage,
            protocolRound: round,
            scriptFile: basename(`${result.observationsPath}.candidate.js`),
            observationsFile: basename(result.observationsPath),
            scriptSha256: result.scriptSha256,
          });
          selectionArtifacts.push({
            stage,
            protocolRound: round,
            scriptSha256: result.scriptSha256,
            sourceSha256: result.sourceSha256,
            scriptPath: `${result.observationsPath}.candidate.js`,
            sourcePath: `${result.observationsPath}.candidate.ts`,
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
        if (readings !== undefined && candidates.length <= OPTIMIZATION_FEEDBACK_ROUNDS) {
          stageAttempts = 0;
          feedback = renderScoreSourceFeedback(readings);
        } else {
          // 现场读编译产物字节算 sha256:复算认的是产物,不是内存里那份源文本。
          let scriptBytes = readFileSync(result.jsPath);
          if (sha256Hex(scriptBytes) !== result.scriptSha256) {
            throw new Error("试跑后编译 JS 字节改变，拒绝冻结未经验证的候选");
          }
          let selection: ArchiveSelection | undefined;
          let validation = result.validation;
          if (expectedPlan !== undefined) {
            const probed: unknown = await (request.selection ?? runSelection)({
              root: request.root,
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
            ...(request.scoreSourceFeedback === true
              ? {
                  optimization: {
                    version: OPTIMIZATION_VERSION,
                    feedbackRounds: OPTIMIZATION_FEEDBACK_ROUNDS,
                    trialSeeds: TRIAL_SEEDS,
                    candidates,
                  },
                }
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
          if (readings !== undefined) {
            try {
              copyFileSync(result.observationsPath, observationsPath);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              process.stderr.write(
                `modelwar gen: 警告：最终试跑观测发布失败 ${observationsPath}: ${message}\n`,
              );
            }
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
