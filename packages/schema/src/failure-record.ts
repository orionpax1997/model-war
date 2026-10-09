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
 * 先标识(哪个模型 / 哪一跑 / 哪一版规则),再结论(分类 / 已收敛轮数 / 逐轮 prompt / 日志 /
 * 诊断 / 原因)。`writeFailureRecord`(住 `packages/gen/src/failure.ts`)按此序序列化,
 * `2` 空格缩进且末尾换行——键序是本文件承诺的对外契约,不是 gen 侧的实现细节。
 *
 * ── 刻意不带 JSON Schema ──────────────────────────────────────────────────────
 *
 * 失败记录**不走** `apps/cli` 的 ajv 装载校验(`archive-meta.ts` / `match-input.ts` 那条缝),
 * 读它的一方只做防御式读栏。给它配一份半截 schema——放行额外属性的空 schema,或一份没有读入端
 * 调用点的 schema——正是 `pending.ts` 头注所禁的「半截校验」:比不写更坏,因为它会让人以为
 * 「失败记录已校验」。故本模块只交类型与文件名前缀常量。
 *
 * ── 本模块含运行时代码:只有末尾那一个前缀常量 ────────────────────────────────
 */

/** 失败记录文件名的前缀:`failed-<runId>.json` 与存档目录 `<runId>/` 在同一父目录下并列。 */
export const FAILURE_RECORD_PREFIX = "failed-";

/** 失败分类:`tsc`(编译没过)/ `contract`(静态校验没过)/ `transport`(传输重试耗尽)。 */
export type FailureClassification = "tsc" | "contract" | "transport";

/**
 * 失败记录的**身份字段**(哪个模型 / 哪一版 / 哪一跑 / 何时):生成侧 `buildFailureRecord` 与
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
