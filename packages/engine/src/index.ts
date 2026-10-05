/**
 * engine 包的对外导出面。**外部缝唯一是 `runMatch`**(02b 落,本票尚不存在)。
 * 依赖方向单向:engine → replay → schema;不得 import runner / gen(hld §3.2)。
 * 运行时只允许 `node:crypto` 一个内置模块;wasm 字节由上层读盘后传入,本包不做磁盘 I/O。
 *
 * ── 运行时导出当前是**空的**,这是有意的 ──
 *
 * hld《模块的深度》那条验收是「**调用方要学的东西少于它拿到的能力**」。而导出面就是这句话的
 * 落点:每多导出一个**运行时**符号,调用方就多一样必须先读懂才能用对的东西。02b 把 `runMatch`
 * 接进来之前,引擎内核**没有一个**外部缝可给——`processTick` 是处理器自己的私有内部缝,
 * 六个 intent 各有**且只有一个**实现因而**不构成缝**。
 * 下面这些是 `export type`:类型不产生运行时能力,它们是 02b 接线时要用到的真源包形状的中转。
 *
 * 明确**不**导出的(每一条都有理由,不是「暂时没写」):
 * - `processTick` 与六个 intent:`processTick` 对外即等于给「跑一局」开了第二条路,
 *   而 ADR-0005 逐条裁掉的正是这类平行表示;六个 intent 不可替换,导出等于对外承诺可替换性。
 * - `buildSnapshot` / `groupIntents` / `createEventCollector`:各只有一个实现,只在管线内部被用到。
 * - `buildTickLine` / `buildMetaLine`:写出路径的**内部**一步。行组装是 `runMatch` 的实现细节,
 *   不是调用方要组装的东西。
 *
 * 状态模型(`GameState` / `Snapshot` / `Outcome`)随 `runMatch` 一起在 02b 进来时再定导出面:
 * 现在导出一份没人用的形状,等于在 02b 改形状时多一处要改的地方。
 *
 * 状态模型用 `type` 而非 `interface`:要进入回放的形状必须可赋给 schema 的 `JsonValue`,
 * 而只有类型别名拿得到隐式索引签名。
 */

export type { JsonValue, MapDefinition, Ruleset, RulesetVersion } from "@model-war/replay";
