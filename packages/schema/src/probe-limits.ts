/**
 * `probe`(探针)的三个数:覆盖几场、贴边阈值、会话上限。
 *
 * ── 为什么它们住在 schema,而不是执行它们的那个包 ──
 *
 * 三个数各有**两个读者,分别在不同包里**:
 * - `PROBE_MATCH_LIMIT`:gen 侧的探针服务拿它决定"跑前几场",并写进工具声明的描述;
 *   `apps/cli` 的试跑入口拿它做默认值与文案("前 8 场")。
 * - `PROBE_NEAR_LIMIT_RATIO`:gen 侧的身份清单要记(`probe.nearLimitRatio`,票 06),
 *   `apps/cli` 的文案渲染要拿它判"贴边 / 充裕"。
 * - `PROBE_CALL_LIMIT`:gen 侧的 dispatcher **执行**它(超限即拒),身份清单**记录**它
 *   (`quotas.probe`,票 06)。
 *
 * 依赖方向只有 gen → schema、cli → schema 两条,所以这几个数只能住在 schema 才不会有第二份。
 * 形状照 `tool-channel.ts` 的 `EVALUATE_CALL_LIMIT`:harness 的执行判据与它的记录格同源。
 *
 * ── 这三个数的来历(都不是随手取的) ──
 *
 * **N = 8**:场序是「组合 → 座位轮转 → 地图」(`packages/runner/src/trial-plan.ts`),所以前 8 场
 * = 第 1 个组合的全部 4 个座位 × 2 张地图,是前缀里覆盖最广的一组;实测 21.6 s,比整张
 * 32 场(74–79 s)便宜约 70%。
 *
 * **0.8**:"最坏 tick 用了 96%"必须能在**没越线**时也说出口。80% 是"换个地图或组合就可能
 * 越线"的那条经验线,低于它就只剩"没超"这一句废话。
 *
 * **5**:探针不是免费的(每次跑 8 场 ≈ 21.6 s),不设上限就是一条免费无限循环的路。
 * 5 次 ≈ 108 s,与一次整张网格同量级——够试错,不够刷。
 *
 * **漏检率 2/4**:真档四例预算触限发生在第 1、8、25、11 场,前 8 场只抓得到前两例。
 * 这条事实写进了给模型的文案(`apps/cli/src/trial/trial.ts` 的 `renderProbeFeedback`),
 * 不许让模型以为"探针绿 == 整张网格通过"。
 */

/**
 * 探针跑计划的前几场。
 *
 * **不许按"最容易触限的场"挑**:它取的是 `plan.matches` 的**前缀**,不手挑种子、不挑地图
 * (那是拿答案调题)。计划对象本身逐字节不动,只是执行时少跑几场。
 */
export const PROBE_MATCH_LIMIT = 8 as const;

/**
 * "贴边"的阈值:任一条预算轨的最坏占用 ≥ 该比例 × 上上限,文案就从"充裕"切成"已经贴边"。
 *
 * 它是**模型看到的世界**的一部分(进身份清单 `probe.nearLimitRatio`),不是渲染细节。
 */
export const PROBE_NEAR_LIMIT_RATIO = 0.8 as const;

/**
 * 一个会话最多调几次探针。
 *
 * 与 `EVALUATE_CALL_LIMIT` 同一条纪律:**计数发生在调用之前**(一次尝试就是一次调用),
 * 否则"让服务失败"就成了一条刷额度的路。判据在 `packages/gen/src/agent/host/dispatcher.ts`。
 *
 * 它与 `evaluate` 的额度**互不侵占**:探针不产出候选、不写观测、不占那三次里的任何一次。
 */
export const PROBE_CALL_LIMIT = 5 as const;
