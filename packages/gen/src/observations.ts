/**
 * 试跑逐场观测：旧四栏保持兼容，行动与终局事实经闭合字段和候选身份校验后回喂。
 * opt-in 每个协议 round 独立保存，最终候选才发布到无 round 的兼容路径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_API_NAMES,
  ACTION_ERROR_CODES,
  OBSERVATIONS_FILE_PREFIX,
  TRIAL_CANDIDATE_SEAT,
  TRIAL_OBSERVATION_JSON_SCHEMA,
  TRIAL_SEEDS,
  type TrialActionFacts,
  type TrialObservationLine,
} from "@model-war/schema";

import { compileProtocolSchema } from "./protocol-schema.js";
import { parseTrialTerminalSummary } from "./terminal-summary.js";

const matchesTrialObservation = compileProtocolSchema(TRIAL_OBSERVATION_JSON_SCHEMA);

export { OBSERVATIONS_FILE_PREFIX } from "@model-war/schema";

/** round 是协议轮号，不是传输尝试或试跑调用数。 */
export const observationsPathOf = (
  root: string,
  slug: string,
  runId: string,
  round?: number,
): string =>
  join(
    root,
    "archive",
    slug,
    `${OBSERVATIONS_FILE_PREFIX}${runId}${round === undefined ? "" : `-round-${String(round)}`}.jsonl`,
  );

/** 字段形状已由共享 JSON Schema 验证；这里只校验当前候选与跨字段关系。 */
const validateActionIdentity = (
  facts: TrialActionFacts,
  matchIndex: number,
  scriptSha256: string,
): void => {
  if (
    facts.scriptSha256 !== scriptSha256 ||
    facts.seed !== TRIAL_SEEDS[matchIndex] ||
    facts.seat !== TRIAL_CANDIDATE_SEAT ||
    ACTION_API_NAMES.some((name) => {
      const totalErrors = ACTION_ERROR_CODES.reduce(
        (sum, code) => sum + facts.errors[name][code],
        0,
      );
      return (
        !Number.isSafeInteger(totalErrors) ||
        totalErrors > facts.calls[name] ||
        (facts.observedTicks === 0 && facts.calls[name] > 0)
      );
    })
  ) {
    throw new Error("行动事实协议或候选归属违约");
  }
};

/** 缺文件非致命；损坏、非法载荷、候选错配大声失败，不能变成策略反馈。 */
export const readTrialObservations = (
  path: string,
  scriptSha256: string,
): readonly TrialObservationLine[] | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
  const matchIndexes = new Set<number>();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!matchesTrialObservation(parsed)) {
        throw new Error(`试跑观测协议违约（行动事实协议）：${path}`);
      }
      // 共享 Schema 校验后恢复类型；跨行与业务关系仍在这里检查。
      const reading = parsed as TrialObservationLine;
      const { matchIndex, delivered, captures, noScoreSource, actionFacts } = reading;
      const terminalSummary =
        reading.terminalSummary === undefined
          ? undefined
          : parseTrialTerminalSummary(reading.terminalSummary, matchIndex);
      if (
        terminalSummary === null ||
        (terminalSummary !== undefined &&
          actionFacts !== undefined &&
          terminalSummary.seed !== actionFacts.seed)
      ) {
        throw new Error(`试跑观测协议违约（终局事实协议）：${path}`);
      }
      if (
        !Number.isSafeInteger(matchIndex) ||
        matchIndexes.has(matchIndex) ||
        !Number.isSafeInteger(delivered) ||
        !Number.isSafeInteger(captures) ||
        noScoreSource !== (delivered === 0 && captures === 0)
      ) {
        throw new Error(`试跑观测协议违约：${path}`);
      }
      matchIndexes.add(matchIndex);
      if (actionFacts !== undefined) validateActionIdentity(actionFacts, matchIndex, scriptSha256);
      return {
        matchIndex,
        delivered,
        captures,
        noScoreSource,
        ...(actionFacts === undefined ? {} : { actionFacts }),
        ...(terminalSummary === undefined ? {} : { terminalSummary }),
      };
    });
};

const renderActions = (reading: TrialObservationLine): string => {
  const facts = reading.actionFacts;
  if (facts === undefined) return "  行动事实缺失，未将缺失解释为零。";
  if (!facts.complete) {
    return `  行动事实不完整（已观测 tick=${String(facts.observedTicks)}，缺失 tick=${String(facts.missingTicks)}），不报告行动计数。`;
  }
  return (
    `  行动事实：seed=${String(facts.seed)}，候选座位=${String(facts.seat)}，已观测 tick=${String(facts.observedTicks)}。\n` +
    ACTION_API_NAMES.map((name) => {
      const errors = ACTION_ERROR_CODES.filter((code) => facts.errors[name][code] > 0)
        .map((code) => `${code}=${String(facts.errors[name][code])}`)
        .join("，");
      return `  ${name}：调用=${String(facts.calls[name])}；即时错误返回：${errors || "无"}。`;
    }).join("\n") +
    `\n  独立结算事实：movedSteps=${String(facts.effects.movedSteps)}，harvestedAmount=${String(facts.effects.harvestedAmount)}，deliveredAmount=${String(facts.effects.deliveredAmount)}，captureEvents=${String(facts.effects.captureEvents)}，productionOrdersStarted=${String(facts.effects.productionOrdersStarted)}。`
  );
};

const renderTerminal = (reading: TrialObservationLine): string => {
  const summary = parseTrialTerminalSummary(reading.terminalSummary, reading.matchIndex);
  if (
    summary === null ||
    (reading.actionFacts !== undefined && summary.seed !== reading.actionFacts.seed)
  ) {
    return "  终局成绩未知（缺少有效终局事实），未将缺失解释为零。";
  }
  return (
    `  终局事实：seed=${String(summary.seed)}，已执行 tick=${String(summary.tick)}，结束原因=${summary.reason}。\n` +
    `  计分权重：基地=${String(summary.weights.baseScore)}，资源点=${String(summary.weights.resourceScore)}，单位造价除数=${String(summary.weights.unitCostDivisor)}；单位造价：worker=${String(summary.unitCosts.worker)}，melee=${String(summary.unitCosts.melee)}，ranged=${String(summary.unitCosts.ranged)}，cavalry=${String(summary.unitCosts.cavalry)}；名次积分表=${summary.rankPoints.map(String).join(" / ")}。\n` +
    summary.players
      .map(
        (player) =>
          `  座位=${String(player.seat)}，身份=${player.player}，控制基地=${String(player.controlledBases)}，控制资源点=${String(player.controlledResources)}，存活单位：worker=${String(player.survivingUnits.worker)}，melee=${String(player.survivingUnits.melee)}，ranged=${String(player.survivingUnits.ranged)}，cavalry=${String(player.survivingUnits.cavalry)}；存活单位总造价=${String(player.survivingUnitCost)}，基地分=${String(player.score.bases)}，资源点分=${String(player.score.resources)}，单位分=${String(player.score.units)}，领土分=${String(player.territoryScore)}，名次=${String(player.rank)}，名次积分=${String(player.rankPoints)}，存活=${String(player.alive)}，淘汰 tick=${player.eliminatedAtTick === null ? "无" : String(player.eliminatedAtTick)}。`,
      )
      .join("\n")
  );
};

/** 只陈述本候选的白名单事实；不从读数推断原因或给策略建议。 */
export const renderScoreSourceFeedback = (readings: readonly TrialObservationLine[]): string =>
  `试跑观测：本候选实际完成的 ${String(readings.length)} 个对局。\n` +
  readings
    .map(
      (reading) =>
        `- 第 ${String(reading.matchIndex + 1)} 个对局：快照 delivered=${String(reading.delivered)}，captures=${String(reading.captures)}，noScoreSource=${String(reading.noScoreSource)}。\n${renderActions(reading)}\n${renderTerminal(reading)}`,
    )
    .join("\n") +
  "\n调用、即时错误返回与结算事实分别计量；undefined 返回不代表行动生效。movedSteps 是实际格移动次数，captureEvents 是占点事件次数，productionOrdersStarted 是开始订单数。快照读数不覆盖全部结算变化。终局 tick 是已执行 tick 数；淘汰 tick 为从零开始的编号。名次积分按并列占用名次区间均分；timeout 的第一名不代表胜利。这些观测不说明原因；依据既有契约返回完整脚本。";
