/**
 * **「形状的行格式已定、取值域与语义未交付」那类数据的清单(现已清空)**。
 *
 * 五类数据的家都在真源包(规则集 / 地图 / 存档 meta / result / 回放行),现在**五类全部落库**:
 * 规则集(`ruleset.ts`)、地图(`map.ts`)、存档 meta(`archive-meta.ts`)、对局输入 `input.json`
 * (`match-input.ts`)与回放行(`replay-line.ts`,含末行 `result` 的终局原因取值域)。
 *
 * ── 本文件为什么还留着 ──
 * 它曾经挂着 `match-result`(末行 `result` 的终局原因取值域与名次语义),由本 feature 的 **09 票**
 * 销账:四个取值收成封闭联合、写进 `replay-line.ts` 的 `ReplayOutcomeReason`,JSON Schema 收成
 * `enum`,读入端校验落在 `apps/cli/src/validator.ts` 的 `validateReplayResultLine`。文件名与文件头
 * 保留,是为了让「有没有一条还没定稿的形状」这个问题**有一个固定的落点**——而不是让它散在
 * 各域文件里靠人记。将来真出现一条尚未定稿的形状,在这里加回一个取值并写清回填触发条件即可。
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

/**
 * 待回填形状的取值集合。**现在是空集(`never`)**——所有形状已销账。
 *
 * 用 `never` 而不是留一个空数组:空数组的类型仍是「某个取值联合的数组」,读起来像「还有几条
 * 只是没列出来」;`never` 是一句能让编译器复核的话——「没有待回填的形状」。加回一条时,
 * 这里写回那个取值,`PENDING_SHAPES` 的数组字面量才编得过。
 */
export type PendingShapeId = never;

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
 * - `match-result`:**已销账(本 feature 的 09 票)**:末行 `result` 的终局原因取值域由
 *   `replay-line.ts` 的 `ReplayOutcomeReason` 与它旁边的 `enum` 定死,名次语义由
 *   `packages/engine/src/processor/outcome.ts` 按 gdd《胜利与淘汰》四条实现,读入端校验由
 *   `apps/cli/src/validator.ts` 的 `validateReplayResultLine` 提供。那四条取值不再有第二个家:
 *   engine 侧是从本包派生的**别名**。
 * - `replay-line`:**已销账(本 feature 的 02b 票)**:三行的形状由 `replay-line.ts` 定死
 *   (`type` 与 `additionalProperties: false` 的判别读入、逐字逐栏的类型与 JSON Schema),
 *   `pending.ts` 原来记着的理由是「字段随那一票的实现才确定」——而写出侧早就在写它了,
 *   所以「字段还可能变」这件事已经不成立,剩下没落的只是「没落库」。
 */
export const PENDING_SHAPES: readonly PendingShapeId[] = [];
