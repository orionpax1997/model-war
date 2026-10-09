/**
 * engine 包的对外导出面。**外部缝唯一是 `runMatch`**(hld §2.2.6 的脊柱)。
 * 依赖方向单向:engine → replay → schema;不得 import runner / gen(hld §3.2)。
 * 运行时只允许 `node:crypto` 一个内置模块;wasm 字节由上层读盘后传入,本包不做磁盘 I/O。
 *
 * ── 运行时导出**只有 `runMatch`** ──
 *
 * hld《模块的深度》那条验收是「**调用方要学的东西少于它拿到的能力**」。而导出面就是这句话的
 * 落点:每多导出一个**运行时**符号,调用方就多一样必须先读懂才能用对的东西。`runMatch` 是
 * 唯一的那一样——「跑完一局、给出回放」。`processTick` 是处理器私有的内部缝,六个 intent 各有
 * 唯一实现因而不构成缝,把它们导出等于对外承诺可替换性(ADR-0005 逐条裁掉的正是这类平行表示)。
 * 明确**不**导出的(每一条都有理由,不是「暂时没写」):
 * - `processTick` 与六个 intent:见上。
 * - `buildSnapshot` / `groupIntents` / `createEventCollector`:各只有一个实现,只在管线内部被用到。
 * - `buildTickLine` / `buildMetaLine`:写出路径的**内部**一步。行组装是 `runMatch` 的实现细节。
 *
 * `runMatch` 的入参形状(`RunMatchParams` / 返回 `RunMatchResult`)随它导出:调用方要构造入参,
 * 就必须看得懂那几个字段,而它们是这条缝的**全部**表面(座席四元组、策略签名、sink)。
 * 状态模型(`GameState` / `Snapshot` / `Outcome`)与上文那些内部符号一样**不**导出:调用方经
 * `RunMatchResult.finalState` 拿得到值、拿不到名字,少学的正是这一份名字面。
 *
 * 状态模型用 `type` 而非 `interface`,理由归 ADR-0002:全仓语法须可擦除,且要进回放的形状
 * 必须可赋给 schema 的 `JsonValue`(只有类型别名拿得到隐式索引签名)。
 */

export { runMatch } from "./run-match.js";
export type { RunMatchParams, RunMatchResult } from "./run-match.js";
export type { JsonValue, MapDefinition, Ruleset, RulesetVersion } from "@model-war/replay";
