/**
 * 单模型的生成轮:发一次 → 编译 → 静态校验 → 原子冻结(hld §2.2.6;契约 §2 / §4)。
 *
 * ── 票 02 的边界:只跑「第 1 轮」 ──
 *
 * 本票把 01 回得的脚本文本一路送到 `archive/<slug>/<runId>/` 三件套。第 1 轮 = 初次生成:
 * **不超时、不重试、不回喂**(那是票 04 的回喂环与票 06 的传输韧性)。失败即返回
 * `{ kind: "failed", failure }`,分类只可能是 `tsc`(编译过不了)或 `contract`(静态校验拦下)——
 * 传输层失败此刻直接向上抛,由编排层记账,`transport` 分类归票 06/08。
 *
 * ── 票 04 的扩展点:把 `sendOneRound` 包进一个循环 ──
 *
 * 一轮的全部动作(发 → 编译 → 迭代期校验 → 冻结期校验)收在 `sendOneRound` 里,它吃**这一轮
 * 完整发出的 prompt**,吐这一轮的结论(`RoundResult`)。票 04 只需把它包进 `for` 循环、把上一轮
 * 的 `result.diagnostics`(即校验器 stdout)拼进下一条 user 消息,并让 `prompts` / `generationLog`
 * 按轮追加——`GenerationLogEntry` / `ModelFailure` 这两个形状现在定死,不必再动。
 *
 * ── `kind` 与 `errorCodes` 的取值(票 07 会继续改) ──
 *
 * `kind` 取「驱动本轮结论的那一栏」:编译没过 → `tsc`;编译过了 → `contract`(校验阶段,
 * 过或不过都算它驱动,所以**成功轮的 kind 也是 `contract`**)。`errorCodes`:编译失败时从 tsc
 * 诊断文本里拾取 `TS####`;静态校验失败时留空数组(校验器只经由子进程的 stdout 给出面向模型的
 * 中文文本,没有机器码可拾,票 07 再定它的来源);成功轮为空数组。
 */

import { readFileSync } from "node:fs";

import type { ArchiveMeta, ArchiveValidation } from "@model-war/schema";

import {
  buildArchiveMeta,
  commitArchive,
  discardStagingDir,
  openStagingDir,
  sha256Hex,
} from "./archive.js";
import { compileScript } from "./compile.js";
import type { ModelConfig } from "./config.js";
import type { ModelParams } from "./model-client.js";
import { renderBaseTemplate } from "./prompt.js";
import type { GenerationRequest } from "./run.js";
import { scriptSizeLimit, validateScript } from "./validate.js";

/**
 * `meta.generationLog` 的每行形状(hld §2.2.6;契约 §2)。**形状冻结**,票 07 会继续填 `kind`
 * 与 `errorCodes` 的取值来源。
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
  readonly errorCodes: readonly string[];
};

export type FailureClassification = "tsc" | "contract" | "transport";

export type ModelFailure = {
  readonly classification: FailureClassification;
  /** 该模型逐轮**完整发出**的 prompt 链(票 02 只有第 1 轮)。 */
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

/** 一轮的结论:要么走到「冻结期校验通过」,要么在某一栏失败并带上诊断。 */
type RoundResult =
  | {
      readonly kind: "passed";
      readonly tscVersion: string;
      readonly jsPath: string;
      readonly validation: ArchiveValidation;
      readonly log: GenerationLogEntry;
    }
  | {
      readonly kind: "failed";
      readonly classification: "tsc" | "contract";
      readonly log: GenerationLogEntry;
      readonly diagnostics: readonly string[];
    };

/**
 * 跑一轮:发一次 → 编译 → 迭代期校验 → 冻结期校验。
 *
 * 这是票 04 回喂环要包起来的最小单元。它**不吞传输层错误**(端口抛错向上抛),也不负责
 * 落盘——落盘与失败清理归 `generateOneModel`。
 */
const sendOneRound = async (options: {
  readonly request: GenerationRequest;
  readonly config: ModelConfig;
  readonly stagingDir: string;
  readonly prompt: string;
  readonly params: ModelParams;
  readonly maxBytes: number;
  readonly round: number;
}): Promise<RoundResult> => {
  const { request, config, stagingDir, prompt, params, maxBytes, round } = options;
  const response = await request
    .createClient(config)
    .send([{ role: "user", content: prompt }], params);

  const base = {
    round,
    model: config.modelId,
    params,
    usage: response.usage,
    finishReason: response.finishReason,
  } as const;

  const compile = compileScript({ root: request.root, stagingDir, source: response.text });
  if (!compile.ok) {
    return {
      kind: "failed",
      classification: "tsc",
      log: { ...base, kind: "tsc", errorCodes: tsErrorCodes(compile.diagnostics) },
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
      classification: "contract",
      log: { ...base, kind: "contract", errorCodes: [] },
      diagnostics: iteration.errors,
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
      classification: "contract",
      log: { ...base, kind: "contract", errorCodes: [] },
      diagnostics: freeze.errors,
    };
  }

  return {
    kind: "passed",
    tscVersion: compile.tscVersion,
    jsPath: compile.jsPath,
    validation: { passed: freeze.passed, errors: freeze.errors },
    log: { ...base, kind: "contract", errorCodes: [] },
  };
};

const messageOfFailure = (slug: string, result: RoundResult & { kind: "failed" }): string =>
  result.classification === "tsc"
    ? `模型 ${slug} 第 ${String(result.log.round)} 轮 tsc 编译失败`
    : `模型 ${slug} 第 ${String(result.log.round)} 轮静态校验未通过`;

/**
 * 单模型逐轮循环(票 02 = 单轮)。第 1 轮:发一次 → 编译 → 迭代期校验 → 冻结期校验 → 冻结。
 *
 * 失败时**不建** `archive/<slug>/<runId>/`:临时组装目录被清理,只返回 `failed` 结果。
 * 传输层错误(端口抛错)此刻向上抛,不在这里吞。
 */
export const generateOneModel = async (
  request: GenerationRequest,
  config: ModelConfig,
): Promise<ModelOutcome> => {
  const slug = config.slug;
  const runId = request.runId;
  const params: ModelParams = config.params ?? {};
  const prompt = renderBaseTemplate(request.template, request.docs, config.strategy);
  const prompts = [prompt];
  const maxBytes = scriptSizeLimit(request.root);

  const stagingDir = openStagingDir(request.root, slug);
  let committed = false;
  try {
    const round = await sendOneRound({
      request,
      config,
      stagingDir,
      prompt,
      params,
      maxBytes,
      round: 1,
    });

    if (round.kind === "failed") {
      return {
        kind: "failed",
        slug,
        runId,
        failure: {
          classification: round.classification,
          prompts,
          generationLog: [logLine(round.log)],
          diagnostics: round.diagnostics,
          message: messageOfFailure(slug, round),
        },
      };
    }

    // 现场读编译产物字节算 sha256:复算认的是产物,不是内存里那份源文本。
    const scriptBytes = readFileSync(round.jsPath);
    const meta = buildArchiveMeta({
      model: slug,
      // modelId 是带 provider 前缀的快照标识(配置里唯一能标识「哪一版模型」的字段)。
      modelVersion: config.modelId,
      generatedAt: request.now().toISOString(),
      prompts,
      generationLog: [logLine(round.log)],
      validation: round.validation,
      tscVersion: round.tscVersion,
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
  } finally {
    // 成功时 rename 已经把临时目录搬走,这里是空操作;失败 / 抛错时整棵清掉,不留半截。
    if (!committed) {
      discardStagingDir(stagingDir);
    }
  }
};
