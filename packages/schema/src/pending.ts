/**
 * **形状的家已定、字段未交付**的两类数据(ADR-0003、spec《Out of Scope》第 1 条)。
 *
 * 五类数据的家都在真源包(规则集 / 地图 / 存档 meta / result / 回放行)。**已落库四类**:
 * 规则集(`ruleset.ts`)、地图(`map.ts`)、存档 meta(`archive-meta.ts`,本 feature 提前定死,
 * 见下面 `archive-meta` 那条销账说明)与对局输入 `input.json`(`match-input.ts`)。
 * **仍挂着的两类**是回放行与 `result`:它们的字段随本 feature 后面几张票的实现才确定,
 * 留在这里的是**位置与标记**,不是 schema:
 *
 * - 刻意**不**给它们写一份 `additionalProperties: true` 的空 schema 充数。放行额外属性
 *   等于不校验,却会让人以为「存档 meta 已校验」——比不写更坏(FR-10 AC2 的覆盖范围
 *   因此是**刻意不完整**的)。
 * - 刻意**不**给它们写半截字段。半截字段同样会让人以为形状已定稿,而 F / H 的
 *   回填是一次「加字段」而不是「改字段」,改字段会波及已经落库的数据。
 *
 * 每个条目的回填触发条件写在各自的注释里;它们是**人读的约定**,不是机器判定的依据。
 */

export type PendingShapeId = "match-result" | "replay-line";

/**
 * **`archive-meta` 已销账(本 feature 的 01 票)**:形状由 `archive-meta.ts` 定死,
 * **字段值随生成管线落库**。生成管线(gen 侧)落地时只填值、不改形状;改字段要走一次
 * 有意的变更,像改一个错误码名那样。
 *
 * 为什么这一条能提前销:hld §7.4(`docs/hld.md:714-715`)已经把 `meta.json` 的十一项
 * 逐项列全,而本文件原来记着「字段随 gen 管线写出的那一版确定」——**那是一个事实两个家**,
 * 按本仓采信顺序 `hld > …`,本文件是错的一方,故据 hld 定死。
 *
 * **为什么 `input.json` 干脆不加进来**:pending 那两条的共同特征是「字段随那一票的实现
 * 才确定」,而 `input.json` 的五项字段同样已被 hld §7.4(`docs/hld.md:721`)**逐项列全**
 * (4 × 存档路径 + 地图 + 种子 + 规则集版本 + 各文件 hash),**不属「随那一票的实现才确定」
 * 那一类**。留成 pending 意味着 F 要么写一份本文件头注明令禁止的放行额外属性的空 schema,
 * 要么跳过读入端校验,两条都是那条纪律点名要拒的——而 `modelwar match` 的第一件事就是装载
 * 输入,拖到脊柱那张票之后等于让脊柱带着一个它被禁止自己用的东西往前走。
 *
 * - `match-result`:回放末行的 `result`(hld §7.5)。回填归 engine 侧的票;
 *   字段与「终局原因」枚举同批定,而那个枚举要靠判别联合拿穷尽性(NFR-1)。
 * - `replay-line`:回放行(hld §7.5 的 meta 行 / tick 行 / result 行)。回填归 replay 侧;
 *   行格式归本包所有,`replay` 包降级为纯编解码层 + 回放**文件格式版本**常量。
 */
export const PENDING_SHAPES: readonly PendingShapeId[] = ["match-result", "replay-line"];
