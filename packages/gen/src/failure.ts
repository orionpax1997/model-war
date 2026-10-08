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
 * ── 形状家归真源包,本文件只组装与落盘 ──
 *
 * `FailureRecord` / `FailureIdentity` / `FailureClassification` 与文件名前缀常量
 * `FAILURE_RECORD_PREFIX` 的**形状真源在 `@model-war/schema`**(`packages/schema/src/
 * failure-record.ts`,hld §2.2.5):报告侧要能只靠记录回答「哪个模型的哪一跑、用哪一版规则、
 * 哪一类失败」,让生成侧与报告侧读同一份定义,不再新增 `runner → gen` 的反向依赖边(§3.2)。
 * 本文件从 schema 导入记录形状与文件名前缀常量,只负责把 `ModelFailure` 组装成记录、按固定键序
 * 落盘,不在此重声明第二份形状。
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

import {
  FAILURE_RECORD_PREFIX,
  RULESET_VERSION,
  type FailureIdentity,
  type FailureRecord,
} from "@model-war/schema";

import type { ModelFailure } from "./pipeline.js";

/** 组装失败记录所需的一切(不带 `root`:组装与落盘是两件事,便于纯函数直测形状)。 */
export type BuildFailureRecordInput = FailureIdentity & {
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

/** 写盘入参:身份字段见 `FailureIdentity`,另加写盘根与失败结论。 */
export type WriteFailureRecordInput = FailureIdentity & {
  readonly root: string;
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
  const path = failureRecordPath(options.root, options.model, options.runId);
  try {
    if (existsSync(path)) {
      return { ok: false, reason: `失败记录已存在,拒绝覆盖:${path}` };
    }
    const record = buildFailureRecord({
      model: options.model,
      modelVersion: options.modelVersion,
      generatedAt: options.generatedAt,
      runId: options.runId,
      failure: options.failure,
    });
    mkdirSync(join(options.root, "archive", options.model), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ok: true, path };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
