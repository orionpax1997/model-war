/**
 * v2 选拔（评测网格）：**排序用生成阶段的分数，复算只校不对**。
 *
 * ── 一句话语义 ──
 *
 * 在确定性引擎里，同一脚本 + 同一计划必然产出同一组数字。于是能独立的是**执行**（进程隔离、
 * 全量重跑），不能独立的是**测量**：选拔不产生新的判别依据，候选的高低直接来自生成阶段那张
 * 网格的分数（`optimization.candidates[].score`，算术真源是 `trial-score.ts`）。选拔做两件事：
 *
 * 1. **定版**：按四条决胜顺序（`selection-order.ts`）选出胜者并给出理由；
 * 2. **校验**：让三份候选在独立子进程里重跑同一张网格，把每场的观测行与生成阶段的那一行
 *    **逐字**比对，并比对分数三元组。任一处不同即整次生成失败（`classification: "selection"`）。
 *
 * 只比总分是不够的：总分相同但某一场不同，同样说明「这条链不确定」，而存档一旦写下去就
 * 永久地声称那 32 场是它跑出来的。
 *
 * ── 为什么证据是观测行的摘要，而不是再存一份观测 ──
 *
 * 观测行（`TrialObservationLine`）是逐场事实：终局四方、领土分、行动事实、超时原因。复算比对的
 * 判定对象是「这一场是不是同一场」，所以落的是它按 `canonical.ts` 序列化后的 sha256
 * （`observationSha256`）与单场身份 `inputSha256`（计划摘要 + 候选脚本摘要 + 该场）。
 * 生成阶段的 32 行原文在存档目录里另有一份（`observationsFile`），不在这里抄第三遍。
 *
 * ── 复用只省「跑」，不省「查」 ──
 *
 * 三份候选里编译产物字节完全相同的，重跑是纯粹的浪费：同一计划 + 同一字节 + 同一运行时，
 * 跑出来必须逐场相同。所以复用更早阶段那份复算结果（`reusedFromStage` 落档）。但**每个阶段的
 * 那份证据都必须被验证**：本阶段自己的观测行与汇总要逐场等于来源那一份，才允许把来源的复算
 * 结果记到本阶段名下。复用不是「跳过校验」的另一种写法。
 */

import { z } from "zod";
import {
  ARCHIVE_GRID_SELECTION_JSON_SCHEMA,
  SELECTION_GRID_VERSION,
  type ArchiveGridSelection,
  type JsonValue,
  type SelectionCandidateIdentity,
  type SelectionGridCandidate,
  type SelectionGridMatch,
  type TrialGridScore,
  type TrialPlan,
  type TrialPlanMatch,
} from "@model-war/schema";

import { canonicalJson, hashOf, same } from "./canonical.js";
import { competitiveRankingIssue, perMatchScores } from "./ranker.js";
import { selectionReasonOf, compareSelectionCandidates } from "./selection-order.js";
import { checkTrialPlan, trialMatchInputSha256 } from "./trial-plan.js";

/** 复算比对与证据落档只吃这两样：这个格子是哪一格、跑出来的一行观测。 */
export type SelectionGridEvidenceRow = JsonValue;

/** 一个候选交上来的证据（身份 + 分数 + 逐场摘要）；与存档里的候选同形。 */
export type SelectionGridCandidateEvidence = SelectionGridCandidate;

/** 拒绝理由统一带「哪一票的口径」前缀；声明成函数而不是箭头，TS 才肯按「返回 never」收窄类型。 */
function fail(reason: string): never {
  throw new Error(`选拔网格证据不合法：${reason}`);
}

const isObject = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 一行的 `matchIndex`（不是整数即拒：拿不到场次就无从对齐，也不许猜）。 */
const matchIndexOf = (row: JsonValue): number => {
  if (!isObject(row)) fail("观测行必须是对象");
  const matchIndex = row["matchIndex"];
  if (typeof matchIndex !== "number" || !Number.isSafeInteger(matchIndex))
    fail("观测行的 matchIndex 必须是整数");
  return matchIndex;
};

/** 逐场对齐：重复、计划外、缺场一律拒绝（不缩分母、不补零、不挑一份好看的）。 */
const rowsByMatchIndex = (
  rows: readonly JsonValue[],
  plan: TrialPlan,
  what: string,
): ReadonlyMap<number, JsonValue> => {
  const byIndex = new Map<number, JsonValue>();
  for (const row of rows) {
    const matchIndex = matchIndexOf(row);
    if (byIndex.has(matchIndex)) fail(`${what}的第 ${String(matchIndex)} 场出现了多行观测`);
    byIndex.set(matchIndex, row);
  }
  const planned = new Set(plan.matches.map((match) => match.matchIndex));
  const unknown = [...byIndex.keys()].filter((matchIndex) => !planned.has(matchIndex));
  if (unknown.length > 0) fail(`${what}多出计划之外的第 ${unknown.join(" / ")} 场`);
  const missing = plan.matches
    .filter((match) => !byIndex.has(match.matchIndex))
    .map((match) => match.matchIndex);
  if (missing.length > 0)
    fail(
      `${what}缺少计划里的第 ${missing.join(" / ")} 场` +
        `（计划 ${String(plan.matchesPerCandidate)} 场，不缩分母、不补零）`,
    );
  return byIndex;
};

/** 一行观测的内容摘要（生成阶段与复算各算一次，逐场比它）。 */
export const observationRowSha256 = (row: JsonValue): string => hashOf(row);

/**
 * 一行观测的终局 → 这一场候选挣到的名次积分。
 *
 * 身份与名次都按计划校验：终局里的座位身份、种子、四座竞争排名只要有一处说的不是这一格，
 * 这一行就不属于这个格子——把它算进来等于悄悄换了一场比赛。
 */
const candidatePointsOf = (plan: TrialPlan, match: TrialPlanMatch, row: JsonValue): number => {
  if (!isObject(row)) fail(`第 ${String(match.matchIndex)} 场的观测行必须是对象`);
  const terminal = row["terminalSummary"];
  if (terminal === undefined || !isObject(terminal))
    fail(`第 ${String(match.matchIndex)} 场缺少终局事实（缺失不当成零分）`);
  const seed = terminal["seed"];
  if (seed !== match.seed)
    fail(
      // oxlint-disable-next-line typescript/no-base-to-string -- 值域真源是 `TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA.seed`（`COUNT_JSON_SCHEMA`：整数 0..MAX_SAFE_INTEGER）；`JsonValue` 只是读入前的宽类型，两份读入侧（`readTrialObservations` / `validateTrialObservation`）已按该 Schema 拒过非整数行。
      `第 ${String(match.matchIndex)} 场的终局种子 ${String(seed)}` +
        `与本场计划种子 ${String(match.seed)} 不符`,
    );
  const players = terminal["players"];
  if (!Array.isArray(players) || players.length !== 4)
    fail(`第 ${String(match.matchIndex)} 场的终局必须是四方四座`);
  const ranks = players.map((player: JsonValue, seat: number): number => {
    if (!isObject(player))
      fail(`第 ${String(match.matchIndex)} 场的终局第 ${String(seat)} 格不是对象`);
    if (player["seat"] !== seat)
      fail(
        // oxlint-disable-next-line typescript/no-base-to-string -- 值域真源是 `TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA.players[].seat`（`{ type: "integer", minimum: 0, maximum: 3 }`），只可能是 0..3 的整数，不可能是对象。
        `第 ${String(match.matchIndex)} 场的终局第 ${String(seat)} 格记的是座位 ${String(player["seat"])}`,
      );
    const expected = match.seats[seat]!;
    if (player["player"] !== expected)
      fail(
        `第 ${String(match.matchIndex)} 场座位 ${String(seat)} 的终局身份 ` +
          // oxlint-disable-next-line typescript/no-base-to-string -- 值域真源是 `TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA.players[].player`（string，minLength 1、maxLength 128、`^[a-z0-9][a-z0-9:.-]*$`），只可能是脚本 id 文本。
          `${String(player["player"])} 与本场座位表的 ${expected} 不符`,
      );
    const rank = player["rank"];
    if (typeof rank !== "number" || !Number.isSafeInteger(rank))
      fail(`第 ${String(match.matchIndex)} 场的名次必须是整数`);
    return rank;
  });
  const issue = competitiveRankingIssue(ranks);
  if (issue !== undefined) fail(`第 ${String(match.matchIndex)} 场：${issue}`);
  const standings = match.seats.map((player, seat) => ({ player, rank: ranks[seat]! }));
  return perMatchScores(String(match.matchIndex), standings)[match.candidateSeat]!;
};

/** 分数的整数记账：每场名次积分是「十二分之一」的整数倍，所以乘 12 后逐位比，不引入容差。 */
const milliOf = (points: number): number => Math.round(points * 12);

/**
 * 生成阶段那 32 行观测 + 它的分数 → 逐场证据表。
 *
 * 这是**唯一**一处「观测行 → 存档证据」的转换：执行（CLI）、校验（`--validate`）与测试都走它，
 * 于是同一份观测不可能在两处被解释出两个答案。逐场身份、逐场积分与「积分之和 = 总分」在这里
 * 一并钉住。
 */
export const selectionGridMatchEvidence = (options: {
  readonly plan: TrialPlan;
  readonly scriptSha256: string;
  readonly rows: readonly SelectionGridEvidenceRow[];
  readonly score: TrialGridScore;
}): readonly SelectionGridMatch[] => {
  const { plan, scriptSha256, rows, score } = options;
  const byIndex = rowsByMatchIndex(rows, plan, "生成阶段的观测");
  if (score.countedMatches !== plan.matchesPerCandidate)
    fail(
      `分数的分母是 ${String(score.countedMatches)}，` +
        `计划声明 ${String(plan.matchesPerCandidate)} 场（不缩分母、不补零）`,
    );
  const matches = plan.matches.map((match): SelectionGridMatch => {
    const row = byIndex.get(match.matchIndex);
    if (row === undefined) fail(`生成阶段缺少第 ${String(match.matchIndex)} 场观测行`);
    return {
      matchIndex: match.matchIndex,
      inputSha256: trialMatchInputSha256(plan, scriptSha256, match),
      observationSha256: observationRowSha256(row),
      candidatePoints: candidatePointsOf(plan, match, row),
    };
  });
  const total = matches.reduce((sum, match) => sum + milliOf(match.candidatePoints), 0);
  if (total !== milliOf(score.totalPoints))
    fail(`逐场名次积分之和 ${String(total / 12)} 与分数总分 ${String(score.totalPoints)} 不一致`);
  return matches;
};

/** 分数三元组逐位比（`countedMatches` 也在内：分母不许悄悄变）。 */
const sameScore = (left: TrialGridScore, right: TrialGridScore): boolean =>
  left.totalPoints === right.totalPoints &&
  left.averagePoints === right.averagePoints &&
  left.countedMatches === right.countedMatches;

const describeScore = (score: TrialGridScore): string =>
  `总分 ${String(score.totalPoints)}、均分 ${String(score.averagePoints)}、` +
  `分母 ${String(score.countedMatches)}`;

/**
 * 复算比对：**逐场逐字**比观测行，再比分数三元组。
 *
 * 场的对齐按 `matchIndex`，不按行序：生成阶段与复算的行序不保证相同（执行器的写法是同一份，
 * 但「同一批事实换了顺序」不该被当成不一致）。任一处不同即抛，并指名第几场。
 */
export const compareSelectionGridRecompute = (options: {
  readonly plan: TrialPlan;
  readonly generated: readonly SelectionGridEvidenceRow[];
  readonly recomputed: readonly SelectionGridEvidenceRow[];
  readonly generatedScore: TrialGridScore;
  readonly recomputedScore: TrialGridScore;
}): void => {
  const { plan, generated, recomputed, generatedScore, recomputedScore } = options;
  const expected = rowsByMatchIndex(generated, plan, "生成阶段的观测");
  const actual = rowsByMatchIndex(recomputed, plan, "复算的观测");
  for (const match of plan.matches) {
    const line = expected.get(match.matchIndex)!;
    const again = actual.get(match.matchIndex)!;
    if (canonicalJson(line) !== canonicalJson(again))
      fail(
        `第 ${String(match.matchIndex)} 场的观测行与生成阶段不一致` +
          `（同一脚本、同一计划、同一运行时必须逐场相同；总分相同也不算一致）`,
      );
  }
  if (!sameScore(generatedScore, recomputedScore))
    fail(
      `复算分数与生成阶段的分数不一致（生成阶段 ${describeScore(generatedScore)}，` +
        `复算 ${describeScore(recomputedScore)}）`,
    );
};

/**
 * 存档里的候选证据 ↔ 生成阶段观测行：**逐场逐字**校一遍。
 *
 * `--validate` 用它回答「这份记录说的那些场次，真的是盘上那 32 行观测吗」：不是重跑，而是
 * 把证据文件重新解释一遍再与记录比。执行路径也用它——复用同字节候选时，本阶段自己的那份
 * 证据必须与来源完全一致，正是靠这一步。
 */
export const verifyGridSelectionEvidence = (options: {
  readonly plan: TrialPlan;
  readonly candidate: SelectionGridCandidate;
  readonly rows: readonly SelectionGridEvidenceRow[];
  readonly score: TrialGridScore;
}): void => {
  const { plan, candidate, rows, score } = options;
  if (!sameScore(candidate.score, score))
    fail(
      `阶段 ${String(candidate.stage)} 记录的分数与它自己的网格汇总不一致` +
        `（记录 ${describeScore(candidate.score)}，汇总 ${describeScore(score)}）`,
    );
  const expected = selectionGridMatchEvidence({
    plan,
    scriptSha256: candidate.scriptSha256,
    rows,
    score,
  });
  if (expected.length !== candidate.matches.length)
    fail(`阶段 ${String(candidate.stage)} 的逐场证据条数与其网格汇总不一致`);
  for (const [index, match] of expected.entries()) {
    const recorded = candidate.matches[index];
    if (recorded === undefined || !same(recorded, match))
      fail(
        `阶段 ${String(candidate.stage)} 第 ${String(match.matchIndex)} 场的证据` +
          `（单场身份 / 观测行摘要 / 名次积分）与生成阶段的观测不一致`,
      );
  }
};

const identityOf = (candidate: SelectionCandidateIdentity): SelectionCandidateIdentity => ({
  stage: candidate.stage,
  protocolRound: candidate.protocolRound,
  scriptSha256: candidate.scriptSha256,
  sourceSha256: candidate.sourceSha256,
});

/** 决胜：四条顺序由 `selection-order.ts` 定，v2 只用新结果的语义（没有 `earlier-stage`）。 */
const decisionOf = (
  candidates: readonly SelectionGridCandidate[],
): Pick<ArchiveGridSelection, "selected" | "reason"> => {
  const [winner, second] = [...candidates].sort((left, right) =>
    compareSelectionCandidates(
      { ...left, averagePoints: left.score.averagePoints },
      { ...right, averagePoints: right.score.averagePoints },
      "later-stage",
    ),
  );
  if (winner === undefined || second === undefined) fail("选拔缺少三个有效候选");
  return {
    selected: identityOf(winner),
    reason: selectionReasonOf(
      { ...winner, averagePoints: winner.score.averagePoints },
      { ...second, averagePoints: second.score.averagePoints },
      "later-stage",
    ),
  };
};

const selectionSchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(ARCHIVE_GRID_SELECTION_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

/**
 * v2 选拔记录的**完整复算**（纯函数：不读盘、不起 VM）。
 *
 * 判据分四层：形状 → 计划能否由事实重建 → 候选证据自洽（逐场身份、积分之和、复用来源）→
 * 胜者与理由。复算「与生成阶段逐场相同」这一层不在这里：那要真重跑，归 CLI 执行侧
 * （`compareSelectionGridRecompute`）。
 */
export const validateGridSelection = (value: unknown): ArchiveGridSelection => {
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) fail("记录形状不合法或缺少完整网格证据");
  const selection = parsed.data as ArchiveGridSelection;
  checkTrialPlan(selection.plan);
  const { plan } = selection;
  for (const [index, candidate] of selection.candidates.entries()) {
    if (
      candidate.stage !== index ||
      candidate.protocolRound <= (selection.candidates[index - 1]?.protocolRound ?? 0)
    )
      fail("候选阶段或协议轮不一致");
    // 分数必须自洽，且分母就是计划声明的场数。
    if (candidate.score.countedMatches !== plan.matchesPerCandidate)
      fail(
        `阶段 ${String(index)} 的分数分母是 ${String(candidate.score.countedMatches)}，` +
          `计划声明 ${String(plan.matchesPerCandidate)} 场（不缩分母、不补零）`,
      );
    if (candidate.score.averagePoints !== candidate.score.totalPoints / plan.matchesPerCandidate)
      fail(`阶段 ${String(index)} 的均分与总分不一致`);
    // 逐场证据必须与计划一一对齐，且单场身份能由计划 + 候选脚本摘要重算出来。
    if (candidate.matches.length !== plan.matches.length)
      fail(`阶段 ${String(index)} 的逐场证据条数与计划场数不一致（不缩分母、不补零）`);
    let sum = 0;
    for (const [position, match] of plan.matches.entries()) {
      const recorded = candidate.matches[position];
      if (recorded === undefined || recorded.matchIndex !== match.matchIndex)
        fail(`阶段 ${String(index)} 的第 ${String(match.matchIndex)} 场证据缺失或场次不符`);
      if (recorded.inputSha256 !== trialMatchInputSha256(plan, candidate.scriptSha256, match))
        fail(`阶段 ${String(index)} 第 ${String(match.matchIndex)} 场的单场身份摘要不一致`);
      sum += milliOf(recorded.candidatePoints);
    }
    if (sum !== milliOf(candidate.score.totalPoints))
      fail(`阶段 ${String(index)} 的逐场名次积分之和与分数总分不一致`);
    // 复用：来源必须是更早的同字节阶段，且证据与分数逐字相同。
    const earliestSame = selection.candidates
      .slice(0, index)
      .findIndex((earlier) => earlier.scriptSha256 === candidate.scriptSha256);
    if (candidate.reusedFromStage === undefined) {
      if (earliestSame >= 0)
        fail(`阶段 ${String(index)} 与其他阶段字节相同，必须复用更早阶段的复算结果`);
      continue;
    }
    const source = selection.candidates[candidate.reusedFromStage];
    if (
      candidate.reusedFromStage >= index ||
      source === undefined ||
      source.scriptSha256 !== candidate.scriptSha256
    )
      fail(`阶段 ${String(index)} 的复用来源必须指向更早的同字节候选`);
    if (candidate.reusedFromStage !== earliestSame)
      fail(`阶段 ${String(index)} 的复用来源必须是更早的同字节阶段里最早的那一份`);
    if (!same(source.matches, candidate.matches) || !sameScore(source.score, candidate.score))
      fail(`阶段 ${String(index)} 的复用证据必须与来源逐场、逐位相同`);
  }
  const decision = decisionOf(selection.candidates);
  if (!same(decision.selected, selection.selected) || decision.reason !== selection.reason)
    fail("胜者身份或选择理由与决胜顺序不一致");
  return selection;
};

/**
 * 证据 → 记录：排序用**生成阶段**的分数（不重算），定版与校验在这里一并做。
 *
 * 调用方（CLI）负责在此之前把「复算与生成阶段逐场相同」校过；本函数只做纯数据的定版与
 * 自洽校验，于是「probe 决定胜者」这条路根本不存在。
 */
export const buildArchiveGridSelection = (
  plan: TrialPlan,
  evidence: readonly SelectionGridCandidateEvidence[],
): ArchiveGridSelection => {
  checkTrialPlan(plan);
  const candidates = [...evidence]
    .sort((left, right) => left.stage - right.stage)
    .map((candidate): SelectionGridCandidate => ({
      ...identityOf(candidate),
      score: candidate.score,
      matches: candidate.matches,
      ...(candidate.reusedFromStage === undefined
        ? {}
        : { reusedFromStage: candidate.reusedFromStage }),
    }));
  return validateGridSelection({
    version: SELECTION_GRID_VERSION,
    plan,
    candidates,
    ...decisionOf(candidates),
  });
};
