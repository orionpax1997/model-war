/**
 * 步 1 · validate:intent 先按单位分组、每单位只留最后一个(静默丢弃、不计异常),
 * 分组后按 `playerIndex 0..3` 再按对象数值 id 升序逐条校验;无效者丢弃(hld §4.3)。
 *
 * ── 本票只做到「分组 + 定序」,校验与执行留给 04–09 ──
 *
 * 分组与定序是**本步前半**,而它的后半(逐条校验、六种 intent 各自的执行)是六个机制票的内容。
 * 分组之所以现在就落:定序是整条管线的地基(第 1、2 条定序规则都在这一步生效),
 * 而六个 intent 各有且只有一个实现,不是缝(hld §4.2)——所以本步**没有**「校验器可插拔」那一层。
 *
 * 重复下单静默丢弃、**没有「产线忙」这个错误码**(hld §4.2):所以这一步的丢弃既不发事件,
 * 也不产出任何诊断。理由写在 `processor/intents.ts` 的头注。
 */

import { groupIntents } from "../intents.js";
import type { Step } from "../context.js";

export const step1Validate: Step = (context) => ({
  ...context,
  intents: groupIntents(context.drained),
});
