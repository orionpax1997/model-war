/**
 * 校验失败记录的组装与写盘(票 05;契约 §2 / §3;CONTEXT.md《校验失败记录》)。
 *
 * ── 它是**旁证**,不是存档 ──
 *
 * 一个模型跑满协议轮数仍未过静态校验、或传输重试耗尽时,`pipeline.ts` 收口出一个
 * `ModelFailure`(逐轮 prompt 链 + 生成日志 + 最终诊断 + 分类)。本文件把这份结论落成
 * `archive/<modelSlug>/failed-<runId>.json`,供报告侧(节点 I)只靠文件就渲染出「校验失败名单」。
 *
 * 它**不带编译产物**、**不建** `archive/<modelSlug>/<runId>/`、**不被任何对局装载**(装载段只收
 * 通过校验的三件套)。`archive/` 下的这条 `failed-*.json` 与 `<runId>/` 目录并列,一眼可分辨。
 *
 * ── 为什么形状比 `meta.json` 多几项、又刻意不进 schema ──
 *
 * `meta.json` 的十一键形状冻结在 `@model-war/schema`;失败记录**不走那条装载断言**,也就不该
 * 混进那个真源包。但报告侧要能从记录本身回答「哪个模型的哪一跑、用哪一版规则、哪一类失败」,
 * 所以这里补齐 `model` / `modelVersion` / `generatedAt` / `runId` / `ruleset` 几个标识位,
 * 再嵌 `classification` / `prompts` / `generationLog` / `diagnostics` / `message`。
 *
 * `protocolRounds` 取 `prompts.length`(与 `meta.json` 的「轮数 = prompt 条数」不变量同源):
 * 它记的是**已收敛的协议轮数**,而不是配置里的轮数上限——传输在某一轮耗尽时那一轮没有结论,
 * 故不入 `prompts`,`protocolRounds` 随之落回已收敛的轮数。这样记录自身始终自洽可读。
 *
 * ── 写盘纪律 ──
 *
 * 目录不存在则创建(`archive/<slug>/` 可能与冻结存档共用,也可能首次生成就失败);JSON 稳定
 * 格式化(`2` 空格缩进)且末尾换行,与 `meta.json` 同款,便于入库与 diff。目标文件已存在即拒绝
 * 覆盖(与 `archive.ts` 的 `commitArchive` 同款),写盘异常一律收成 `{ ok:false }` 返回,
 * **不抛给编排层**——写失败按模型失败记账,不崩整批(契约 §3)。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RULESET_VERSION } from "@model-war/schema";

import type { FailureClassification, ModelFailure } from "./pipeline.js";

/** 失败记录文件名的前缀:`failed-<runId>.json` 与存档目录 `<runId>/` 在同一父目录下并列。 */
export const FAILURE_RECORD_PREFIX = "failed-";

/**
 * 一条校验失败记录的 JSON 形状(报告侧读成失败名单的形状真源)。
 *
 * 键序即书写序:先标识(哪个模型 / 哪一跑 / 哪一版规则),再结论(分类 / 已收敛轮数 /
 * 逐轮 prompt / 日志 / 诊断 / 原因)。`writeFailureRecord` 按此序序列化,保证稳定格式化。
 */
export type FailureRecord = {
  /** 模型名,与 `archive/<modelSlug>/` 的目录名同源。 */
  readonly model: string;
  /** 模型版本/快照标识(配置里的 `modelId`),与 `meta.json` 的分工一致。 */
  readonly modelVersion: string;
  /** 失败判定时刻(ISO 字符串),只作留档。 */
  readonly generatedAt: string;
  /** 这一跑的 `runId`,与文件名 `failed-<runId>.json` 同源。 */
  readonly runId: string;
  /** 生成时所用的规则集版本(本仓常量)。 */
  readonly ruleset: string;
  /** 失败分类:`tsc` / `contract` / `transport`。 */
  readonly classification: FailureClassification;
  /** 已收敛的协议轮数,恒等于 `prompts.length`(镜像 `meta.json` 的轮数不变量)。 */
  readonly protocolRounds: number;
  /** 逐轮**完整发出**的 prompt 链(键与含义同 `ModelFailure.prompts`)。 */
  readonly prompts: readonly string[];
  /** 逐轮一行 `JSON.stringify(GenerationLogEntry)`。 */
  readonly generationLog: readonly string[];
  /** 最终诊断(tsc 诊断行,或校验器 stdout 的非空行)。 */
  readonly diagnostics: readonly string[];
  /** 一行人类可读原因。 */
  readonly message: string;
};

/** 组装失败记录所需的一切(不带 `root`:组装与落盘是两件事,便于纯函数直测形状)。 */
export type BuildFailureRecordInput = {
  readonly model: string;
  readonly modelVersion: string;
  readonly generatedAt: string;
  readonly runId: string;
  readonly failure: ModelFailure;
};

/**
 * 组装一条失败记录(纯函数,不落盘)。`ruleset` 从本仓常量填,`protocolRounds` 由
 * `prompts.length` 推得——不给调用方一个填错的口子(与 `buildArchiveMeta` 同款理由)。
 */
export const buildFailureRecord = (input: BuildFailureRecordInput): FailureRecord => ({
  model: input.model,
  modelVersion: input.modelVersion,
  generatedAt: input.generatedAt,
  runId: input.runId,
  ruleset: RULESET_VERSION,
  classification: input.failure.classification,
  protocolRounds: input.failure.prompts.length,
  prompts: input.failure.prompts,
  generationLog: input.failure.generationLog,
  diagnostics: input.failure.diagnostics,
  message: input.failure.message,
});

/** `archive/<modelSlug>/failed-<runId>.json` 的绝对路径。 */
export const failureRecordPath = (root: string, slug: string, runId: string): string =>
  join(root, "archive", slug, `${FAILURE_RECORD_PREFIX}${runId}.json`);

export type WriteFailureRecordResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/** 写盘入参:记录的 `model` 恒等于 `slug`(目录名与记录里的模型名同源),不另设一个可能分叉的键。 */
export type WriteFailureRecordInput = {
  readonly root: string;
  readonly slug: string;
  readonly modelVersion: string;
  readonly generatedAt: string;
  readonly runId: string;
  readonly failure: ModelFailure;
};

/**
 * 把一条失败记录写到 `archive/<modelSlug>/failed-<runId>.json`。
 *
 * 目录不存在则递归创建(失败记录可能与冻结存档共用父目录,也可能一个模型都没通过)。
 * 目标已存在即拒绝覆盖(`wx` 兜底 TOCTOU);任何异常都收成 `{ ok:false }`,不抛——编排层按
 * 「写盘失败也是该模型的一次失败」记账,不因此崩掉整批。
 */
export const writeFailureRecord = (options: WriteFailureRecordInput): WriteFailureRecordResult => {
  const path = failureRecordPath(options.root, options.slug, options.runId);
  try {
    if (existsSync(path)) {
      return { ok: false, reason: `失败记录已存在,拒绝覆盖:${path}` };
    }
    const record = buildFailureRecord({
      model: options.slug,
      modelVersion: options.modelVersion,
      generatedAt: options.generatedAt,
      runId: options.runId,
      failure: options.failure,
    });
    mkdirSync(join(options.root, "archive", options.slug), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ok: true, path };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
