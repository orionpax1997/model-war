/**
 * 单模型的生成轮:发一次 → 编译 → 静态校验 → 原子冻结,失败则**只回喂校验文本**再试(hld §2.2.6 / §7.4;契约 §2.2 / §4)。
 *
 * ── 票 04 的边界:≤N 轮只回喂校验文本 ──
 *
 * 一轮的全部动作(发 → 编译 → 迭代期校验 → 冻结期校验)收在 `sendOneRound` 里,吃**这一轮
 * 完整发出的 messages**,吐这一轮的结论(`RoundResult`)。`generateOneModel` 把它包进
 * `for` 循环:第 1 轮 = 初次生成;第 r>1 轮把上一轮驱动失败的**面向模型文本**逐字追加为一条
 * **新增的 user 消息**(前置一条 `assistant` = 上一轮模型回文本),每轮把**整个 messages 全量
 * 重发**——不依赖 provider 会话状态(契约 §2.2)。
 *
 * 回喂内容**只有**校验文本:合约静态校验失败 = 校验器 stdout;编译失败 = tsc 诊断文本。不加
 * 前后缀、不加引擎诊断、不含任何对局信息。轮数上限 `protocolRounds` 是**模型调用总轮数,
 * 含第 1 轮**(`config.protocolRounds ?? request.maxRounds ?? 5`),用尽即止。
 *
 * ── `prompts` / `generationLog` 逐轮追加 ──
 *
 * `meta.prompts[r]` = 第 r 轮那整份 transcript 的 `messages.map((m) => m.content).join("\n\n")`,
 * 长度 === 实际调用轮数(`buildArchiveMeta` 由它推 `protocolRounds`,两者相等是装载期不变量)。
 * `generationLog` 逐轮一行。轮数用尽仍失败时,**不建** `archive/<slug>/<runId>/`,只返回
 * `{ kind: "failed", failure }`——失败记录写盘是票 05 的活。
 *
 * ── 传输层错误的边界 ──
 *
 * 一次 `send` 由 `retry.ts` 的 `retryTransport` 包住:429 / 5xx / 网络失败 / 超时(可重试的
 * `TransportError`)与截断(`finishReason === "length"`)退避重发**同一轮**,不追加 messages、
 * 不写生成日志、不占用 `protocolRounds`。重试耗尽或遇到不可重试的错误(400 / 缺凭证)→ 轮循环
 * 停在该轮,返回 `transport` 分类的 `failed`(写盘归票 05)。
 *
 * ── `kind` 与 `errorCodes` 的取值(票 07 定稿) ──
 *
 * `kind` 取「驱动本轮结论的那一栏」:编译没过 → `tsc`;编译过了 → `contract`(校验阶段,
 * 过或不过都算它驱动,所以**成功轮的 kind 也是 `contract`**)。这一栏是「哪一栏驱动」的唯一可读标记。
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

import { readFileSync } from "node:fs";

import type { ArchiveMeta, ArchiveValidation, FailureClassification } from "@model-war/schema";

import {
  buildArchiveMeta,
  commitArchive,
  discardStagingDir,
  openStagingDir,
  sha256Hex,
} from "./archive.js";
import { compileScript } from "./compile.js";
import type { ModelConfig } from "./config.js";
import type { ChatMessage, ModelParams } from "./model-client.js";
import { renderBaseTemplate } from "./prompt.js";
import { retryTransport, type TransportFailure } from "./retry.js";
import type { GenerationRequest } from "./run.js";
import { scriptSizeLimit, validateScript } from "./validate.js";

/** 未在配置里给 `protocolRounds` 时的 gen 内部默认:模型调用总轮数,含第 1 轮。 */
const DEFAULT_PROTOCOL_ROUNDS = 5;

/**
 * `meta.generationLog` 的每行形状(hld §2.2.6;契约 §2)。**形状冻结**,票 07 定稿了 `kind`
 * 与 `errorCodes` 的取值来源(见文件头注)。
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
  /** 编译失败时是诊断里的 `TS####`;合约轮为空(来源与理由见文件头注,票 07 定稿)。 */
  readonly errorCodes: readonly string[];
};

// 取值域的家在真源包(报告侧要按它分节渲染,是跨进程数据形状而非 gen 私有参数);
// 这里只是别名,不重列第二份取值表(同 `replay/index.ts` 的 `TickPayload = ReplayTickPayload` 先例)。
export type { FailureClassification };

export type ModelFailure = {
  readonly classification: FailureClassification;
  /** 该模型逐轮**完整发出**的 prompt 链(每轮一条 `messages.map(m => m.content).join("\n\n")`)。 */
  readonly prompts: readonly string[];
  /** 逐轮一行 `JSON.stringify(GenerationLogEntry)`。 */
  readonly generationLog: readonly string[];
  /** 最终诊断(tsc 诊断行,或校验器 stdout 的非空行)。 */
  readonly diagnostics: readonly string[];
  /** 一行人类可读原因。 */
  readonly message: string;
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
      /** 记的迭代期(`--phase iteration`)那一次的结论:非 blocking 提示只在这一相存在。 */
      readonly validation: ArchiveValidation;
      readonly log: GenerationLogEntry;
    }
  | {
      readonly kind: "failed";
      /** 本轮模型回文本(下一轮把它当前置 `assistant` 消息)。 */
      readonly text: string;
      readonly classification: "tsc" | "contract";
      readonly log: GenerationLogEntry;
      /** 逐字回喂的**面向模型文本**:tsc 诊断,或校验器 stdout(契约 §2.2)。 */
      readonly feedback: string;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: "transport";
      /** 退避重试耗尽 / 不可重试的错误,由 `retry.ts` 收口(轮循环据此返回 `transport` 失败)。 */
      readonly failure: TransportFailure;
    };

/**
 * 跑一轮:发一次 → 编译 → 迭代期校验 → 冻结期校验。
 *
 * 它吃**这一轮完整发出的 messages**(第 r>1 轮已含前置 `assistant` 与新增 `user` 回喂),
 * 把整份 transcript 全量重发。**传输层收口**:一次 `send` 由 `retryTransport` 包住,退避重试
 * 同一轮;重试耗尽 / 不可重试时返回 `kind:"transport"`(轮循环不涨轮数、不建存档)。落盘与失败
 * 清理归 `generateOneModel`。
 */
const sendOneRound = async (options: {
  readonly request: GenerationRequest;
  readonly config: ModelConfig;
  readonly stagingDir: string;
  readonly messages: readonly ChatMessage[];
  readonly params: ModelParams;
  readonly maxBytes: number;
  readonly round: number;
}): Promise<RoundResult> => {
  const { request, config, stagingDir, messages, params, maxBytes, round } = options;
  // 一轮一个客户端:重试在**同一次 `send` 之内**完成(同一份 messages),协议轮数不动(契约 §2.1)。
  const client = request.createClient(config);
  const attempt = await retryTransport({ send: () => client.send(messages, params) });
  if (!attempt.ok) {
    return { kind: "transport", failure: attempt.failure };
  }
  const response = attempt.response;
  const text = response.text;

  const base = {
    round,
    model: config.modelId,
    params,
    usage: response.usage,
    finishReason: response.finishReason,
  } as const;

  const compile = compileScript({ root: request.root, stagingDir, source: text });
  if (!compile.ok) {
    return {
      kind: "failed",
      text,
      classification: "tsc",
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
      log: { ...base, kind: "contract", errorCodes: [] },
      feedback: freeze.stdout,
      diagnostics: nonEmptyLines(freeze.stdout),
    };
  }

  return {
    kind: "passed",
    text,
    tscVersion: compile.tscVersion,
    jsPath: compile.jsPath,
    // 记迭代期的结论(不是冻结期那一相):通过判据就是迭代期,非 blocking 提示也只在这一相存在。
    validation: { passed: iteration.passed, errors: iteration.errors },
    log: { ...base, kind: "contract", errorCodes: [] },
  };
};

const messageOfFailure = (slug: string, result: RoundResult & { kind: "failed" }): string =>
  result.classification === "tsc"
    ? `模型 ${slug} 第 ${String(result.log.round)} 轮 tsc 编译失败`
    : `模型 ${slug} 第 ${String(result.log.round)} 轮静态校验未通过`;

/**
 * 单模型逐轮回喂环(契约 §2.2):第 1 轮初次生成,之后每轮**只回喂上一轮的校验文本**,
 * 直到冻结期校验通过或用尽 `protocolRounds` 轮。
 *
 * 失败时**不建** `archive/<slug>/<runId>/`:临时组装目录被清理,只返回 `failed` 结果(携全部
 * 已收敛轮次的 `prompts` / `generationLog`)。传输层失败(退避重试耗尽 / 不可重试)同样只返回
 * `transport` 分类的 `failed`,不建存档(失败写盘归票 05)。
 */
export const generateOneModel = async (
  request: GenerationRequest,
  config: ModelConfig,
): Promise<ModelOutcome> => {
  const slug = config.slug;
  const runId = request.runId;
  const params: ModelParams = config.params ?? {};
  // 契约 §2.2:配置优先;`maxRounds` 是编排层可注入的缺省替代(测试用),最后才是 gen 默认 5。
  const protocolRounds = config.protocolRounds ?? request.maxRounds ?? DEFAULT_PROTOCOL_ROUNDS;
  const maxBytes = scriptSizeLimit(request.root);

  const basePrompt = renderBaseTemplate(request.template, request.docs, config.strategy);
  // 无状态全量重发:每轮把整个 messages 发出,后续轮在其后追加 assistant + user(契约 §2.2)。
  let messages: readonly ChatMessage[] = [{ role: "user", content: basePrompt }];
  const prompts: string[] = [];
  const generationLog: string[] = [];

  const stagingDir = openStagingDir(request.root, slug);
  let committed = false;
  try {
    for (let round = 1; round <= protocolRounds; round += 1) {
      const result = await sendOneRound({
        request,
        config,
        stagingDir,
        messages,
        params,
        maxBytes,
        round,
      });

      // 传输层收口:该轮没有收敛(重试耗尽 / 不可重试),不进 prompts / generationLog、不占
      // 用协议轮数,只返回结构——不建存档目录(写盘归票 05)。
      if (result.kind === "transport") {
        return {
          kind: "failed",
          slug,
          runId,
          failure: {
            classification: "transport",
            prompts,
            generationLog,
            diagnostics: result.failure.diagnostics,
            message: `模型 ${slug} 第 ${String(round)} 轮传输失败:${result.failure.message}`,
          },
        };
      }

      // 该轮已收敛(通过 / 校验失败):现在才把**这一轮完整发出**的 transcript 与日志记下。
      // 传输失败的轮次不在此列(它没有结论),`prompts` 与 `generationLog` 因此逐条对齐。
      prompts.push(transcriptOf(messages));
      generationLog.push(logLine(result.log));

      if (result.kind === "passed") {
        // 现场读编译产物字节算 sha256:复算认的是产物,不是内存里那份源文本。
        const scriptBytes = readFileSync(result.jsPath);
        const meta = buildArchiveMeta({
          model: slug,
          // modelId 是带 provider 前缀的快照标识(配置里唯一能标识「哪一版模型」的字段)。
          modelVersion: config.modelId,
          generatedAt: request.now().toISOString(),
          prompts,
          generationLog,
          validation: result.validation,
          tscVersion: result.tscVersion,
          scriptSha256: sha256Hex(scriptBytes),
        });

        const commit = commitArchive({ root: request.root, slug, runId, stagingDir, meta });
        if (!commit.ok) {
          return {
            kind: "failed",
            slug,
            runId,
            failure: {
              classification: "contract",
              prompts,
              generationLog: meta.generationLog,
              diagnostics: [commit.reason],
              message: commit.reason,
            },
          };
        }
        committed = true;
        return { kind: "frozen", slug, runId, dir: commit.dir, meta };
      }

      // 用尽轮数仍失败:照旧返回 failed(写盘归票 05),prompts / generationLog 覆盖全部轮。
      if (round === protocolRounds) {
        return {
          kind: "failed",
          slug,
          runId,
          failure: {
            classification: result.classification,
            prompts,
            generationLog,
            diagnostics: result.diagnostics,
            message: messageOfFailure(slug, result),
          },
        };
      }

      // 回喂:前置 assistant(上一轮回文本)+ 新增 user(上一轮驱动失败的面向模型文本),
      // 两者都逐字入 transcript,下一轮全量重发。
      messages = [
        ...messages,
        { role: "assistant", content: result.text },
        { role: "user", content: result.feedback },
      ];
    }
    // `protocolRounds >= 1`,循环必然在上面某轮 return;这里只是让类型收口。
    throw new Error(`模型 ${slug} 的回喂环没有产出结论(protocolRounds=${String(protocolRounds)})`);
  } finally {
    // 成功时 rename 已经把临时目录搬走,这里是空操作;失败 / 抛错时整棵清掉,不留半截。
    if (!committed) {
      discardStagingDir(stagingDir);
    }
  }
};
