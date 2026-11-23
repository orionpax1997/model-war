/**
 * 校验失败记录的组装与写盘(契约 §2 / §3;CONTEXT.md《校验失败记录》)。
 *
 * ── 它是**旁证**,不是存档 ──
 *
 * 一个模型跑满协议轮数仍未过静态校验、或传输重试耗尽时,`pipeline.ts` 收口出一个
 * `ModelFailure`(逐轮 prompt 链 + 生成日志 + 最终诊断 + 分类)。本文件把这份结论落成
 * `archive/<modelSlug>/failed-<runId>.json`,供报告侧(`packages/runner/src/reporter.ts` 的
 * `readFailureRecords`)只靠文件就渲染出「校验失败名单」。
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
  ARCHIVE_SCHEMA_VERSION,
  FAILURE_RECORD_PREFIX,
  RULESET_VERSION,
  type FailureIdentity,
  type FailureRecord,
} from "@model-war/schema";

import { archiveRoundFieldsOf, type AgentArchiveInput } from "./archive.js";
import type { ModelFailure } from "./pipeline.js";

/**
 * 组装失败记录所需的一切(不带 `root`:组装与落盘是两件事,便于纯函数直测形状)。
 *
 * `agent` 与 `meta.json` 的 `AgentArchiveInput` 是**同一份类型**（与成功档同键集合的前提）；
 * 缺它 = one-shot 形态的历史记录，代价不变。
 */
export type BuildFailureRecordInput = FailureIdentity & {
  /** 渠道身份(含档位);与 `meta.json` 同一格,失败记录同样不能缺这一维。 */
  readonly channelId: string;
  readonly failure: ModelFailure;
  readonly agent?: AgentArchiveInput;
};

/**
 * 组装一条失败记录(纯函数,不落盘)。`ruleset` 从本仓常量填,`protocolRounds` 与 `prompts`
 * 由**与成功档相同的公式**推得——不给调用方一个填错的口子(与 `buildArchiveMeta` 同款理由)。
 *
 * agent（v3）形态下 `failure.prompts` 不参与：轮数与起始 prompt 由 `steps` 与首条消息推导，
 * 于是「零步会话 = 过程记录为空、起始 prompt 为空、协议轮数为零」这条就自动成立。调用方若仍
 * 填了 `failure.prompts`，就当作两份会漂的奇据拒掉，而不是默默选一份。
 */
export const buildFailureRecord = (input: BuildFailureRecordInput): FailureRecord => {
  const agent = input.agent;
  if (agent !== undefined && input.failure.prompts.length > 0)
    throw new Error("agent 形态的 prompts 由过程记录与首条消息推导，调用方不得同时填 prompts");
  const rounds =
    agent === undefined
      ? { protocolRounds: input.failure.prompts.length, prompts: input.failure.prompts }
      : archiveRoundFieldsOf(agent);
  return {
    // 形状版本写在第一个键上（与 `meta.json` 同序）：读档按它分派。
    ...(agent === undefined ? {} : { archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION }),
    model: input.model,
    modelVersion: input.modelVersion,
    channelId: input.channelId,
    generatedAt: input.generatedAt,
    runId: input.runId,
    ruleset: RULESET_VERSION,
    classification: input.failure.classification,
    protocolRounds: rounds.protocolRounds,
    prompts: rounds.prompts,
    ...(agent === undefined ? {} : { steps: agent.steps }),
    generationLog: input.failure.generationLog,
    ...(agent === undefined
      ? {}
      : {
          contextLength: agent.contextLength,
          harnessVersion: agent.harnessVersion,
          harnessDigest: agent.harnessDigest,
          termination: agent.termination,
          atStep: agent.atStep,
        }),
    diagnostics: input.failure.diagnostics,
    message: input.failure.message,
    ...(input.failure.selectionFailure === undefined
      ? {}
      : { selectionFailure: input.failure.selectionFailure }),
    ...(input.failure.candidates !== undefined ? { candidates: input.failure.candidates } : {}),
  };
};

/** `archive/<modelSlug>/failed-<runId>.json` 的绝对路径。 */
export const failureRecordPath = (root: string, slug: string, runId: string): string =>
  join(root, "archive", slug, `${FAILURE_RECORD_PREFIX}${runId}.json`);

export type WriteFailureRecordResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/** 写盘入参:身份字段见 `FailureIdentity`,另加渠道身份、写盘根、失败结论与可选的 agent 字段。 */
export type WriteFailureRecordInput = FailureIdentity & {
  readonly channelId: string;
  readonly root: string;
  readonly failure: ModelFailure;
  readonly agent?: AgentArchiveInput;
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
      channelId: options.channelId,
      generatedAt: options.generatedAt,
      runId: options.runId,
      failure: options.failure,
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    mkdirSync(join(options.root, "archive", options.model), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ok: true, path };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
