/**
 * 首触探针(gdd §2 时间轴第一段的判据,`gdd.md:123` 那段复核的读数来源)。
 *
 * ── 判据与桩同口径 ──
 *
 * 「首触(任意敌对单位 Chebyshev ≤ 2)」(桩 `tables.mjs` §1 首行 / 取证表 `tables-1336-rerun-2026-10-04.md:51`)。
 * 真引擎里这条判据的实现在 `processor/steps/step2-movement.ts` 的 `FIRST_CONTACT_CHEBYSHEV`
 * (步 2 的槽位收 `first-contact` 事件);本探针**不重判**,只去回放里读那条事件。
 *
 * ── 取首触的两条路,本探针选「扫回放」这条 ──
 *
 * ① 读 `runMatch` 返回的 `finalState.firstContactTick`(引擎自己的记账);
 * ② 扫回放 tick 行的 `events`,找第一条 `{ kind: "first-contact" }` 取它的 `tick`。
 *
 * **本探针选 ②。** 理由是它更贴近「回放可复算」:它只吃**回放字节**(`firstContactTick` 不进
 * tick 行载荷,但 `first-contact` 事件进),于是「从一份已落盘的回放里读出来的首触」与「重新执行
 * 得到的首触」是同一条判据。选 ① 会让读数依赖一个回放里没有的引擎内部栏,复核者拿着同一份回放
 * 无法复算。两条路的一致性由 `fixtures.test.ts` 的一条用例盯着(它断言 ② 与 ① 同值)。
 */

import type { ReplayLine } from "@model-war/replay";

import type { FixtureMatch } from "./harness.js";
import { tickLinesOf } from "./harness.js";

/** 路 ②:扫回放,第一条 `first-contact` 事件所在 tick;整局没有则 `null`。 */
export const firstContactTickOf = (parsed: readonly ReplayLine[]): number | null => {
  for (const line of tickLinesOf(parsed)) {
    if (line.events.some((event) => event.kind === "first-contact")) {
      return line.tick;
    }
  }
  return null;
};

/** 路 ①:引擎返回的终局里的 `firstContactTick`。只用于与路 ② 对账,不进读数。 */
export const finalStateFirstContactOf = (match: FixtureMatch): number | null =>
  match.finalState.firstContactTick;

/** 一局的首触读数(路 ②)。 */
export const firstContactOf = (match: FixtureMatch): number | null =>
  firstContactTickOf(match.parsed);
