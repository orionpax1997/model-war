/**
 * **形状的行格式已定、取值域与语义未交付**的一类数据(ADR-0003、spec《Out of Scope》第 1 条)。
 *
 * 五类数据的家都在真源包(规则集 / 地图 / 存档 meta / result / 回放行)。**已落库四类**:
 * 规则集(`ruleset.ts`)、地图(`map.ts`)、存档 meta(`archive-meta.ts`,本 feature 提前定死,
 * 见下面 `archive-meta` 那条销账说明)、对局输入 `input.json`(`match-input.ts`)与回放行
 * (`replay-line.ts`,本 feature 的 02b 落)。**仍挂着的只有 `result`**。
 *
 * - 刻意**不**给它写一份 `additionalProperties: true` 的空 schema 充数。放行额外属性
 *   等于不校验,却会让人以为「存档 meta 已校验」——比不写更坏(FR-10 AC2 的覆盖范围
 *   因此是**刻意不完整**的)。
 * - 刻意**不**给它写半截字段。半截字段同样会让人以为形状已定稿,而回填是一次「加字段」
 *   而不是「改字段」,改字段会波及已经落库的数据。
 * - 刻意**不**把一个还没定稿的取值域抄进已经落库的形状:那会是同一个事实第二个家,
 *   而两个家里总有一个不更新。
 *
 * 每个条目的回填触发条件写在各自的注释里;它们是**人读的约定**,不是机器判定的依据。
 */

export type PendingShapeId = "match-result";

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
 * - `match-result`:回放末行 `result` 的**终局原因取值域与名次语义**(hld §7.5)。回填归 engine 侧;
 *   那个枚举要靠判别联合拿穷尽性(NFR-1)。注意边界:**行格式**(三栏的名字与类型)已随
 *   `replay-line.ts` 定死,留在这里的只是「`reason` 收哪几个取值」与「名次怎么算」;
 *   在它定稿之前不把四个取值抄进 `replay-line.ts`,就是给一个还没定稿的事实写第二个家。
 * - `replay-line`:**已销账(本 feature 的 02b 票)**:三行的形状由 `replay-line.ts` 定死
 *   (`type` 与 `additionalProperties: false` 的判别读入、逐字逐栏的类型与 JSON Schema),
 *   `pending.ts` 原来记着的理由是「字段随那一票的实现才确定」——而写出侧早就在写它了,
 *   所以「字段还可能变」这件事已经不成立,剩下没落的只是「没落库」。
 */
export const PENDING_SHAPES: readonly PendingShapeId[] = ["match-result"];
