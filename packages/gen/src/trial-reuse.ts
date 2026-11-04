/**
 * 同字节候选的网格复用：这一轮**不重跑网格**，把更早阶段的观测与 `.grid.json` 搬过来。
 *
 * ── 为什么可以复用，以及为什么不许「因为字节相同就跳过校验」 ──
 *
 * 网格的输入身份由三样东西唯一决定：计划（`planSha256`）、候选编译产物（`scriptSha256`）与
 * 沙箱运行时。三者相同，跑出来就必须逐场相同——所以在同一次生成里，一份**字节完全相同**的
 * 候选不需要再花一到两分钟重跑 32 场。这是本票唯一的省时手段（`sendOneRound` 每轮跑满网格的
 * 形状不变，见 06/07 补充裁决第一条）。
 *
 * 但复用只省「跑」，不省「查」。搬之前要四关全过：
 *
 * 1. **来源没被改过**：收录来源那一轮时记下了两份文件的字节摘要，这里重算并比对。只比
 *    「形状」不比对字节，等于相信任何同名的文件。
 * 2. **计划同源**：来源的 `.grid.json` 必须与本次 expected plan 逐字相同（换图/换座位/换种子/
 *    换陪练即失败），且它说的是**这份**候选的摘要。
 * 3. **观测完整**：计划里的每一场都有一行**带终局**的读数；缺场不补零、不缩分母。
 * 4. **搬完逐场逐字一致**：读回来的每一场与来源的那一场按规范序列化逐字比对。
 *
 * 任一条不过都抛（infra 错）：整次生成失败，不留半份存档——错配的网格结果一旦被当成
 * 「这份候选的成绩」，反馈与选拔都会建在别人的数字上。
 *
 * ── 复用来源为什么要落档 ──
 *
 * 事后看一份存档时，「为什么两个阶段的分数一模一样」必须能从档里读出来，而不是靠猜。
 * 所以复用那一轮在候选记录上写 `reusedFromStage`，装载期再按它核对来源、字节与分数
 * （`packages/runner/src/archive-optimization.ts`）。
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { TrialPlan } from "@model-war/schema";

import { sha256Hex } from "./archive.js";
import { missingTrialGridMatches, readTrialObservations } from "./observations.js";
import { canonicalText, gridSummaryPathOf, parseTrialGridSummary } from "./trial-grid.js";

/** 一份**已收录**的网格证据：哪个阶段、跑的是哪份候选、两份文件在收录时的字节摘要。 */
export type ReusableGridEvidence = {
  readonly stage: 0 | 1 | 2;
  readonly scriptSha256: string;
  /** 观测文件路径（本阶段自己的那份，不是最终发布的兼容路径）。 */
  readonly observationsPath: string;
  /** 收录时观测文件的字节摘要；复用前重算并比对，来源被改过即失败。 */
  readonly observationsSha256: string;
  /** 收录时 `<观测文件>.grid.json` 的字节摘要。 */
  readonly gridSummarySha256: string;
};

/** 收录一份证据的两份字节摘要（复用路径只认这一处算出来的摘要，不各自现算一遍）。 */
export const gridEvidenceDigests = (
  observationsPath: string,
): { readonly observationsSha256: string; readonly gridSummarySha256: string } => ({
  observationsSha256: sha256Hex(readFileSync(observationsPath)),
  gridSummarySha256: sha256Hex(readFileSync(gridSummaryPathOf(observationsPath))),
});

const readOr = (path: string, what: string): Buffer => {
  try {
    return readFileSync(path);
  } catch {
    throw new Error(`复用来源的${what}读不到（更早阶段的证据不在了）：${path}`);
  }
};

/**
 * 把来源阶段的网格证据搬到本阶段的落点，并逐场逐字校验。
 *
 * `targetObservationsPath` 是本轮候选自己的观测路径（`observations.ts` 是路径真源）：
 * 每个阶段仍有自己独占的观测与汇总，只是内容来自更早的同字节候选。
 */
export const reuseTrialGrid = (options: {
  readonly source: ReusableGridEvidence;
  readonly targetObservationsPath: string;
  readonly plan: TrialPlan;
}): void => {
  const { source, targetObservationsPath, plan } = options;
  const sourceSummaryPath = gridSummaryPathOf(source.observationsPath);

  // ① 来源没被改过：字节摘要与收录时一致。
  const observationsBytes = readOr(source.observationsPath, "网格观测");
  if (sha256Hex(observationsBytes) !== source.observationsSha256)
    throw new Error(`复用来源的网格观测已被改动（摘要不符）：${source.observationsPath}`);
  const summaryBytes = readOr(sourceSummaryPath, "网格汇总");
  if (sha256Hex(summaryBytes) !== source.gridSummarySha256)
    throw new Error(`复用来源的网格汇总已被改动（摘要不符）：${sourceSummaryPath}`);

  // ② 计划同源 + 说的是同一份候选。
  parseTrialGridSummary({
    path: sourceSummaryPath,
    text: summaryBytes.toString("utf8"),
    expectedPlan: plan,
    scriptSha256: source.scriptSha256,
  });

  // ③ 观测完整（身份校验在 `readTrialObservations` 里按计划逐场做）。
  const sourceReadings =
    readTrialObservations(source.observationsPath, source.scriptSha256, plan) ?? [];
  const missing = missingTrialGridMatches(sourceReadings, plan);
  if (missing.length > 0)
    throw new Error(
      `复用来源的网格观测不完整（计划 ${String(plan.matches.length)} 场，缺 matchIndex ${missing.join(" / ")}），拒绝复用`,
    );

  // ④ 搬字节，再读回来逐场逐字比对。
  const targetSummaryPath = gridSummaryPathOf(targetObservationsPath);
  writeFileSync(targetObservationsPath, observationsBytes);
  writeFileSync(targetSummaryPath, summaryBytes);
  if (!readFileSync(targetObservationsPath).equals(observationsBytes))
    throw new Error(`复用搬过来的网格观测与来源不一致（逐字节）：${targetObservationsPath}`);
  if (!readFileSync(targetSummaryPath).equals(summaryBytes))
    throw new Error(`复用搬过来的网格汇总与来源不一致（逐字节）：${targetSummaryPath}`);
  const targetReadings =
    readTrialObservations(targetObservationsPath, source.scriptSha256, plan) ?? [];
  if (targetReadings.length !== sourceReadings.length)
    throw new Error(
      `复用后的网格观测场数 ${String(targetReadings.length)} 与来源 ${String(sourceReadings.length)} 不一致`,
    );
  for (const [index, reading] of targetReadings.entries()) {
    const origin = sourceReadings[index];
    if (origin === undefined || canonicalText(origin) !== canonicalText(reading))
      throw new Error(
        `复用后的第 ${String(reading.matchIndex)} 场观测与来源不一致（复用结果必须与来源逐场相同）`,
      );
  }
};
