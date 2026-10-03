/**
 * **形状的家已定、字段未交付**的三类数据(ADR-0003、spec《Out of Scope》第 1 条)。
 *
 * 五类数据的家都在真源包(规则集 / 地图 / 存档 meta / result / 回放行),但本 feature
 * 只交付规则集与地图两类。三类留在这里的是**位置与标记**,不是 schema:
 *
 * - 刻意**不**给它们写一份 `additionalProperties: true` 的空 schema 充数。放行额外属性
 *   等于不校验,却会让人以为「存档 meta 已校验」——比不写更坏(FR-10 AC2 的覆盖范围
 *   因此是**刻意不完整**的:今天只兑现规则集与地图两类)。
 * - 刻意**不**给它们写半截字段。半截字段同样会让人以为形状已定稿,而 A / F / H 的
 *   回填是一次「加字段」而不是「改字段」,改字段会波及已经落库的数据。
 *
 * 每个条目的回填触发条件写在各自的注释里;它们是**人读的约定**,不是机器判定的依据。
 */

export type PendingShapeId = "archive-meta" | "match-result" | "replay-line";

/**
 * - `archive-meta`:冻结脚本的 `meta.json`(hld §7.4)。回填归 gen 侧的票;
 *   字段随 gen 管线写出的那一版确定。
 * - `match-result`:回放末行的 `result`(hld §7.5)。回填归 engine 侧的票;
 *   字段与「终局原因」枚举同批定,而那个枚举要靠判别联合拿穷尽性(NFR-1)。
 * - `replay-line`:回放行(hld §7.5 的 meta 行 / tick 行 / result 行)。回填归 replay 侧;
 *   行格式归本包所有,`replay` 包降级为纯编解码层 + 回放**文件格式版本**常量。
 */
export const PENDING_SHAPES: readonly PendingShapeId[] = [
  "archive-meta",
  "match-result",
  "replay-line",
];
