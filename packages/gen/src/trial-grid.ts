/**
 * 评测网格汇总（`<观测文件>.grid.json`）的读入端：一次生成跑的是哪张网格、哪份候选。
 *
 * ── 为什么读入端要「认计划」而不是只认形状 ──
 *
 * 汇总里落的是整份计划（含 `planSha256`）。执行器按现场事实重建计划、跑完再写回；生成侧在
 * 推进前拿 `--plan` 取过一次**同一份** expected plan，于是「这次跑的是不是那张网格」只有
 * 逐字比对能回答：换图、换座位、换种子、换一份陪练摘要——任一字段不等即整批失败（infra 错，
 * 不回喂、不当成候选不合格）。
 *
 * ── 为什么这里另留一份规范序列化 ──
 *
 * 计划摘要的序列化真源在 runner 包的 `canonical.ts`（本包不得跨到那一侧，门禁钉死）。
 * 这里只要「结构相等」而不产摘要，所以本格留一份十行的同款实现：对象键排序、数组保序。
 * 两份实现判的是同一件事，改动时两边一起改。
 */

import { readFileSync } from "node:fs";

import {
  TRIAL_GRID_SUMMARY_JSON_SCHEMA,
  TRIAL_GRID_SUMMARY_SUFFIX,
  type TrialGridMatch,
  type TrialGridSummary,
  type TrialPlan,
} from "@model-war/schema";

import { compileProtocolSchema } from "./protocol-schema.js";

const matchesSummary = compileProtocolSchema(TRIAL_GRID_SUMMARY_JSON_SCHEMA);

/** 汇总文件的落点（与执行器同一约定：观测文件同目录、同前缀）。 */
export const gridSummaryPathOf = (observationsPath: string): string =>
  `${observationsPath}${TRIAL_GRID_SUMMARY_SUFFIX}`;

/** 对象键排序、数组保序的规范序列化（只用于结构相等，不产摘要）。 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

/**
 * 汇总里的逐场身份 = 计划的投影（场序、种子、候选座位、地图名与地图摘要）。
 *
 * 两边分开比：`plan` 相等说明「同一张网格」，`matches` 相等说明「这些格子确实是按它跑的」。
 */
const projectMatches = (plan: TrialPlan): readonly TrialGridMatch[] =>
  plan.matches.map((match) => ({
    matchIndex: match.matchIndex,
    seed: match.seed,
    candidateSeat: match.candidateSeat,
    map: match.map,
    mapSha256: match.mapSha256,
  }));

/**
 * 读一次调用的网格汇总，并回答三件事：形状、说的是哪份候选、是否与 expected plan 逐字相同。
 *
 * 任一不符都抛（infra 错）：生成侧据此拒绝推进/冻结，而不是静默降级或换一份计划重跑。
 */
export const readTrialGridSummary = (options: {
  readonly path: string;
  readonly expectedPlan: TrialPlan;
  readonly scriptSha256: string;
}): TrialGridSummary => {
  const { path, expectedPlan, scriptSha256 } = options;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`评测网格汇总读不到（执行器未写或路径不对）：${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`评测网格汇总不是合法 JSON：${path}`);
  }
  if (!matchesSummary(parsed)) throw new Error(`评测网格汇总形状不合法：${path}`);
  const summary = parsed as TrialGridSummary;
  if (summary.scriptSha256 !== scriptSha256)
    throw new Error(`评测网格汇总说的是另一份候选脚本（摘要不符）：${path}`);
  if (!same(summary.plan, expectedPlan))
    throw new Error(
      `评测网格汇总里的计划与本次 expected plan 不同源（换图/换座位/换种子/换陪练）：${path}`,
    );
  if (!same(summary.matches, projectMatches(expectedPlan)))
    throw new Error(`评测网格汇总的逐场身份与计划不一致：${path}`);
  return summary;
};
