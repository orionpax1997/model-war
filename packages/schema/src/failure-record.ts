/**
 * 校验失败记录的 `failed-<runId>.json` 形状(hld §7.4;CONTEXT.md《校验失败记录》)。
 *
 * ── 它是旁证,不是存档,但形状家归真源包 ──────────────────────────────────────
 *
 * 一个模型跑满协议轮数仍未过静态校验、或传输重试耗尽时,生成管线把结论落成
 * `archive/<modelSlug>/failed-<runId>.json`(与冻结存档目录并列),供报告侧(赛季调度 I)只靠
 * 文件就渲染出「校验失败名单」。它**不走** `meta.json` 那条 ajv 装载断言,但按 hld §2.2.5
 *「每类形状的家只有这一个」,这份形状仍落在真源包:报告侧要能从记录本身回答「哪个模型的哪一跑、
 * 用哪一版规则、哪一类失败」,而不新增一条 `runner → gen` 的反向依赖边(§3.2)。
 *
 * ── 键序即书写序 ──────────────────────────────────────────────────────────────
 *
 * 先标识(哪个模型 / 哪一版 / 哪条渠道 / 哪一跑 / 哪一版规则),再结论(分类 / 已收敛轮数 / 逐轮 prompt / 日志 /
 * 诊断 / 原因 / 已有候选(仅统一优化中途失败时有))。`writeFailureRecord`(住 `packages/gen/src/failure.ts`)按此序序列化,
 * `2` 空格缩进且末尾换行——键序是本文件承诺的对外契约,不是 gen 侧的实现细节。
 *
 * ── 刻意不带 JSON Schema ──────────────────────────────────────────────────────
 *
 * 失败记录**不走** `apps/cli` 的 ajv 装载校验(`archive-meta.ts` / `match-input.ts` 那条缝),
 * 读它的一方只做防御式读栏。给它配一份半截 schema——放行额外属性的空 schema,或一份没有读入端
 * 调用点的 schema——正是 `pending.ts` 头注所禁的「半截校验」:比不写更坏,因为它会让人以为
 * 「失败记录已校验」。故本模块只交类型、文件名前缀常量与那份分类列表(见下一条界线)。
 *
 * ── 本模块含运行时代码:一个文件名前缀常量与一份分类列表 ──────────────────────────
 *
 * 其余导出一律是类型。`FAILURE_CLASSIFICATIONS` 是这条界线上的第二个例外:读侧
 * (`packages/runner/src/archive-report-evidence.ts`)要在**运行期**拿一份白名单验证外部字节,
 * 而 runner 不得 import gen(hld §3.2)。分类的家在这里,于是白名单只能从同一份字面量派生。
 */

import type { SelectionCandidateIdentity, SelectionPlan } from "./selection-plan.js";
import type { TrialPlan } from "./trial-plan.js";
import type {
  AnyArchiveOptimizationCandidate,
  ArchiveStep,
  ArchiveTermination,
  ARCHIVE_SCHEMA_VERSIONS,
} from "./archive-meta.js";

/** 失败记录文件名的前缀:`failed-<runId>.json` 与存档目录 `<runId>/` 在同一父目录下并列。 */
export const FAILURE_RECORD_PREFIX = "failed-";

/**
 * 失败分类的**运行期**列表(类型从它派生,不另写一份)。
 *
 * 两侧都读它:写入侧(`packages/gen/src/pipeline.ts`)按 `termination` 分派时用类型
 * `FailureClassification`,读侧(`packages/runner`)用它验证外部字节里的分类文本。
 * 加一档只改这里——之前读侧自带一份同值数组,两处得同时改,而漏一处没有任何判据会红。
 *
 * - `tsc`:编译没过。
 * - `contract`:静态校验没过,或会话以其它非预算原因收尾(协议不服从、上下文守卫等)。
 * - `budget`:**会话预算耗尽**(步数或墙钟用完)。它不是「模型违反契约」,只是这一场没跑完。
 * - `transport`:传输重试耗尽。
 * - `selection`:三阶段后的选拔未完成。
 */
export const FAILURE_CLASSIFICATIONS = [
  "tsc",
  "contract",
  "budget",
  "transport",
  "selection",
] as const;

/** 失败分类。由上面的列表派生:类型与白名单不可能不同步。 */
export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

/**
 * 失败记录的**身份字段**(哪个模型 / 哪一版 / 哪一跑 / 何时,渠道身份见 `FailureRecord.channelId`):生成侧 `buildFailureRecord` 与
 * `writeFailureRecord` 的共同前缀。抽出来只为一件事——两处不再各列一遍这四项,免得其一漏改时
 * 两边的身份字段悄悄分叉。
 *
 * `model` 一名两用:既是记录里的模型名(`FailureRecord.model`),也是 `archive/<modelSlug>/`
 * 的目录名——两者同源,由同一个键承载,不给「记录名」与「目录名」各留一个可能分叉的名字。
 */
export type FailureIdentity = {
  /** 模型名,与 `archive/<modelSlug>/` 的目录名同源。 */
  readonly model: string;
  /** 模型版本/快照标识(配置里的 `modelId`),与 `meta.json` 的分工一致。 */
  readonly modelVersion: string;
  /** 失败判定时刻(ISO 字符串),只作留档。 */
  readonly generatedAt: string;
  /** 这一跑的 `runId`,与文件名 `failed-<runId>.json` 同源。 */
  readonly runId: string;
};

/**
 * 一条校验失败记录的 JSON 形状(报告侧读成失败名单的形状真源)。
 *
 * 键序即书写序:先标识(哪个模型 / 哪一跑 / 哪一版规则),再结论(分类 / 已收敛轮数 /
 * 逐轮 prompt / 日志 / 诊断 / 原因)。`writeFailureRecord` 按此序序列化,保证稳定格式化。
 */
export type FailureRecord = FailureIdentity & {
  /**
   * 渠道身份(含档位,如 `commandcode-goat-2026-11`),与 `meta.json` 同格。
   *
   * **可选**:本字段出现前写下的 `failed-*.json` 没有它,那些记录仍要能被报告侧读。
   * 新记录由 `writeFailureRecord` 必写——失败也是数据,缺了这一维就分不清哪次失败
   * 属于哪条渠道,只能靠 `generatedAt` 猜。
   */
  readonly channelId?: string;
  /** 生成时所用的规则集版本(本仓常量)。 */
  readonly ruleset: string;
  /** 失败分类:`tsc` / `contract` / `budget` / `transport` / `selection`;`budget` 是会话预算耗尽,不是模型违反契约。 */
  readonly classification: FailureClassification;
  /** 已收敛的协议轮数,恒等于 `prompts.length`(镜像 `meta.json` 的轮数不变量)。 */
  readonly protocolRounds: number /** 逐轮**完整发出**的 prompt 链(键与含义同 `ModelFailure.prompts`)。 */;
  readonly prompts: readonly string[];
  /** 逐轮一行 `JSON.stringify(GenerationLogEntry)`。 */
  readonly generationLog: readonly string[];
  /** 最终诊断(tsc 诊断行,或校验器 stdout 的非空行)。 */
  readonly diagnostics: readonly string[];
  /** 一行人类可读原因。 */
  readonly message: string;
  /**
   * 统一优化中途失败时已验证的有效候选描述（stage 0 起，与 `ArchiveMeta.optimization.candidates`
   * 同形状；缺席 = 无有效候选或旧记录）。报告侧据此分别标识初次/中间候选并核对 hash，
   * selection 失败可以保留三个有效阶段；失败档没有冻结脚本。
   */
  readonly candidates?: readonly AnyArchiveOptimizationCandidate[];
  /** 完成三阶段后选拔失败的预定输入与不可变候选身份，不伪造部分胜者。 */
  readonly selectionFailure?: {
    /** 预定计划：v1 选拔是它自己的 12 场计划，v2 是生成阶段那张网格（`TrialPlan`）。 */
    readonly plan: SelectionPlan | TrialPlan;
    readonly candidates: readonly SelectionCandidateIdentity[];
  };
  /**
   * ── 以下是 agent（v3）形态的字段：与成功档**同键集合、同一公式** ────────
   *
   * 失败档恰恰是校准 harness 的主要证据（读契约读了几步、命令全挂在编译上、动作没解析出来），
   * 所以「失败档存少点」这条特殊化被 ADR-0031 否掉了：它与成功档同形，读侧才不需要长分支。
   *
   * 七格同进同出；缺 `archiveSchemaVersion` = one-shot 形态的历史记录。
   */
  readonly archiveSchemaVersion?: (typeof ARCHIVE_SCHEMA_VERSIONS)[number];
  /** 过程记录：一步一条；零步会话为空数组。 */
  readonly steps?: readonly ArchiveStep[];
  readonly contextLength?: number;
  readonly harnessVersion?: string;
  readonly harnessDigest?: string;
  readonly termination?: ArchiveTermination;
  readonly atStep?: number;
};
