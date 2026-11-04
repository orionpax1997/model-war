/**
 * 试跑逐场观测：旧四栏保持兼容，行动与终局事实经闭合字段和候选身份校验后回喂。
 * opt-in 每个协议 round 独立保存，最终候选才发布到无 round 的兼容路径。
 *
 * ── 反馈为什么是三层而不是逐场展开 ──
 *
 * 网格一场候选就是一整张 32 场的表（4 陪练组合 × 4 座位 × 2 图），逐场展开会把每场四方全套
 * 计分依据都塞进 prompt——08 实测「三场」约 3.5 千字符，照搬 32 场就是约 25 千字符。所以回喂分三层
 * （三层之前先给一行陪练池身份与一句覆盖声明）：
 *
 * 0. **陪练池身份**：本阶段对的是哪四份（角色、`role:slug`、装载来源），以及有没有**代位**
 *    （来源带 `#substitute` 时明写「本阶段以 X 代位」）。这一块不是第四层，它是「跟谁打」的
 *    唯一出处（与那句覆盖声明一起站在三层之外）。
 * 1. **对差表**：按 `座位 × 地图` 聚合（网格 8 格），每格给平均名次、平均名次积分、平均领土分与
 *    第一名的分差、末位局数，并给出**与上一阶段同一格的变化**（Δ 平均名次积分 / Δ 分差）。
 * 2. **逐场一行**：图、候选座位、组合（该场轮空的是哪一份陪练）、候选名次、四方领土分、结束原因；
 *    候选与该场某位对手**字节相同**时逐场加一句「本场对手与你字节相同」（确定性镜像，照跑不回避）。
 * 3. **最差三场**：只对这三场展开原有的三栏明细（行动调用数与即时错误码、独立结算效果、终局事实）。
 *
 * ── 各层共同守的两条口径 ──
 *
 * - **缺失不补零**：行动事实缺失/不完整、终局未知都如实写「未知」，既不算作零分也不参与排序；
 *   覆盖缺失（读数少于计划场数、行动事实的缺失与不完整）单独用一行声明说明，而且是**全网格**
 *   的账，不只最差三场。
 * - **只陈述事实**：不出现因果结论与策略建议，回喂文本里也没有「请检查 / 建议 / 应该」这类话。
 *
 * 渲染是**代码内拼接**（`prompts/` 只留给初次生成模板），文案本身不引模板文件。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_API_NAMES,
  ACTION_ERROR_CODES,
  OBSERVATIONS_FILE_PREFIX,
  TRIAL_OBSERVATION_JSON_SCHEMA,
  TRIAL_SCRIPT_ID_SEPARATOR,
  TRIAL_SUBSTITUTE_SOURCE_SUFFIX,
  type TrialActionFacts,
  type TrialObservationLine,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanSeat,
  type TrialSparringRole,
  type TrialTerminalSummary,
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

/**
 * 字段形状已由共享 JSON Schema 验证；这里只校验当前候选与跨字段关系。
 *
 * 期望的种子与候选座位由**计划**给（`plan.matches[matchIndex]`），不由常量表给：网格里
 * matchIndex ↔ 种子/座位是计划里的函数，不再是「下标即种子 / 候选恒 0 号位」。
 */
const validateActionIdentity = (
  facts: TrialActionFacts,
  match: TrialPlanMatch,
  scriptSha256: string,
): void => {
  if (
    facts.scriptSha256 !== scriptSha256 ||
    facts.seed !== match.seed ||
    facts.seat !== match.candidateSeat ||
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

/**
 * 计划里的一场；`matchIndex` 不在计划里即协议违约（不许出现的场次）。
 *
 * 观测行不带地图（行形状与版本不变），地图身份由旁挂的 `.grid.json` 与计划对账。
 * `where` 只进错误信息（文件名或「反馈渲染」），不影响判据。
 */
const matchOf = (plan: TrialPlan, matchIndex: number, where: string): TrialPlanMatch => {
  const match = plan.matches.find((candidate) => candidate.matchIndex === matchIndex);
  if (match === undefined) throw new Error(`试跑观测协议违约（计划里没有这一场）：${where}`);
  return match;
};

/** 缺文件非致命；损坏、非法载荷、候选错配大声失败，不能变成策略反馈。 */
export const readTrialObservations = (
  path: string,
  scriptSha256: string,
  plan: TrialPlan,
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
      const match = matchOf(plan, matchIndex, path);
      const terminalSummary =
        reading.terminalSummary === undefined
          ? undefined
          : parseTrialTerminalSummary(reading.terminalSummary, plan, match);
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
      if (actionFacts !== undefined) validateActionIdentity(actionFacts, match, scriptSha256);
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

/**
 * 网格证据的完整性：计划里的哪些场次缺一行或**缺终局摘要**。
 *
 * 空数组 = 整张网格齐了。两个消费端共用这一条判据：本轮刚跑完的证据，与**复用**更早阶段
 * 的那份证据（复用不是不校验的借口：字节守卫、计划一致性、观测完整性照旧）。
 * 不把缺场当成零分——少一场就拒绝，不缩分母、不补零。
 */
export const missingTrialGridMatches = (
  readings: readonly TrialObservationLine[],
  plan: TrialPlan,
): readonly number[] =>
  plan.matches
    .filter(
      (match) =>
        !readings.some(
          (reading) =>
            reading.matchIndex === match.matchIndex && reading.terminalSummary !== undefined,
        ),
    )
    .map((match) => match.matchIndex);

const renderActions = (reading: TrialObservationLine | undefined): string => {
  const facts = reading?.actionFacts;
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

/** 终局未知（含没有读数、摘要非法、与行动身份错配）一律走这一句；不把缺失写成零。 */
const renderTerminal = (summary: TrialTerminalSummary | null): string => {
  if (summary === null) return "  终局成绩未知（缺少有效终局事实），未将缺失解释为零。";
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

/** 一场的四方可比事实；终局未知时全部字段不存在（不补零，也不参与排序）。 */
type ObservedMatch = {
  readonly kind: "observed";
  readonly match: TrialPlanMatch;
  readonly reading: TrialObservationLine | undefined;
  readonly summary: TrialTerminalSummary;
  /** 四方领土分，按座位 0..3。 */
  readonly territories: readonly number[];
  readonly rank: number;
  readonly points: number;
  readonly territory: number;
  /** 第一名的领土分（分差的被减数）。 */
  readonly firstTerritory: number;
  /** 本场四方里排在最后（名次等于最大名次，含并列末位；四方全并列时不算末位）。 */
  readonly last: boolean;
};

type UnknownMatch = {
  readonly kind: "unknown";
  readonly match: TrialPlanMatch;
  readonly reading: TrialObservationLine | undefined;
};

type MatchFacts = ObservedMatch | UnknownMatch;

/**
 * 终局摘要：非法、缺失、与行动事实不同种子都归为 `null`（未知）。
 *
 * 与读入端同一套校验（`parseTrialTerminalSummary`），所以**渲染不会因摘要损坏而崩**，
 * 也不会把不可信的数字展示成成绩。
 */
const summaryOf = (reading: TrialObservationLine, plan: TrialPlan): TrialTerminalSummary | null => {
  const summary = parseTrialTerminalSummary(
    reading.terminalSummary,
    plan,
    matchOf(plan, reading.matchIndex, "反馈渲染"),
  );
  if (summary === null) return null;
  if (reading.actionFacts !== undefined && summary.seed !== reading.actionFacts.seed) return null;
  return summary;
};

/**
 * 第一名的领土分（分差的被减数）：**名次为 1** 的那一方，不是「领土分最高的那一方」——
 * 名次是先按存活分层再按领土分排的，异常淘汰方可能留下高单位分却不占第一名。
 * 并列第一的领土分本已相同；名次校验保证至少有一个 rank 1，为空时退回全体最高值。
 */
const firstTerritoryOf = (summary: TrialTerminalSummary): number => {
  const first = summary.players.filter((player) => player.rank === 1);
  const basis = first.length === 0 ? summary.players : first;
  return Math.max(...basis.map((player) => player.territoryScore));
};

/**
 * 逐场事实按**计划场序**铺开（输入读数的顺序不影响输出）：计划之外的场次是协议违约，直接抛。
 */
const factsOf = (
  plan: TrialPlan,
  readings: readonly TrialObservationLine[],
): readonly MatchFacts[] => {
  const byIndex = new Map<number, TrialObservationLine>();
  for (const reading of readings) {
    matchOf(plan, reading.matchIndex, "反馈渲染");
    byIndex.set(reading.matchIndex, reading);
  }
  return plan.matches.map((match): MatchFacts => {
    const reading = byIndex.get(match.matchIndex);
    const summary = reading === undefined ? null : summaryOf(reading, plan);
    if (reading === undefined || summary === null) return { kind: "unknown", match, reading };
    const candidate = summary.players[match.candidateSeat];
    const worstRank = Math.max(...summary.players.map((player) => player.rank));
    return {
      kind: "observed",
      match,
      reading,
      summary,
      territories: summary.players.map((player) => player.territoryScore),
      rank: candidate.rank,
      points: candidate.rankPoints,
      territory: candidate.territoryScore,
      firstTerritory: firstTerritoryOf(summary),
      // 四方全并列时既是第一也是最后，写进末位会自相矛盾，所以那一局不算末位。
      last: candidate.rank === worstRank && worstRank > 1,
    };
  });
};

/** 两位小数前先抹掉浮点噪声（负数用 ASCII 减号，模型侧的文本不引入排版字符）。 */
const number2 = (value: number): string => (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);

/** 带符号的变化量；四舍五入后为零的变化写成 `+0.00`，不写 `-0.00`（也不写两个减号）。 */
const signed2 = (value: number): string =>
  Math.abs(value) < 0.005 || value > 0 ? `+${number2(value)}` : number2(value);

const averageOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** 一格（座位 × 地图）的聚合；`known === 0` 时数值字段不被渲染。 */
type CellAverage = {
  readonly total: number;
  readonly known: number;
  readonly rank: number;
  readonly points: number;
  readonly territory: number;
  readonly first: number;
  readonly gap: number;
  readonly lastPlace: number;
};

const averageOfCell = (matches: readonly MatchFacts[]): CellAverage => {
  const known = matches.filter((match): match is ObservedMatch => match.kind === "observed");
  const empty = known.length === 0;
  return {
    total: matches.length,
    known: known.length,
    rank: empty ? 0 : averageOf(known.map((match) => match.rank)),
    points: empty ? 0 : averageOf(known.map((match) => match.points)),
    territory: empty ? 0 : averageOf(known.map((match) => match.territory)),
    first: empty ? 0 : averageOf(known.map((match) => match.firstTerritory)),
    // 分差按「第一名 − 候选」逐场算再平均，与「先平均再相减」等价（同一批局）。
    gap: empty ? 0 : averageOf(known.map((match) => match.firstTerritory - match.territory)),
    lastPlace: known.filter((match) => match.last).length,
  };
};

/** 与上一阶段同一格的变化：没有上一阶段、或任一侧该格终局未知时明确说出来。 */
const changeOf = (current: CellAverage, previous: CellAverage | undefined): string => {
  const head = "与上一阶段同一格：";
  if (previous === undefined) return `${head}无上一阶段。`;
  if (current.known === 0) return `${head}本阶段该格终局未知，不给变化。`;
  if (previous.known === 0) return `${head}上一阶段该格终局未知，不给变化。`;
  return `${head}Δ平均名次积分 ${signed2(current.points - previous.points)}，Δ分差 ${signed2(current.gap - previous.gap)}。`;
};

/**
 * 第一层：对差表。行 = 计划里实际出现的 `座位 × 地图` 格（网格 4 × 2 = 8 行），
 * 行序先座位后地图；缩小网格时按计划里实际出现的格。
 */
const renderDiffTable = (
  plan: TrialPlan,
  facts: readonly MatchFacts[],
  previous: readonly MatchFacts[] | undefined,
): string => {
  const mapOrder = [
    ...new Set([...plan.maps.map((map) => map.name), ...plan.matches.map((match) => match.map)]),
  ];
  const rows: string[] = [];
  for (const seat of SEATS) {
    for (const map of mapOrder) {
      const matches = facts.filter(
        (fact) => fact.match.candidateSeat === seat && fact.match.map === map,
      );
      if (matches.length === 0) continue;
      const cell = averageOfCell(matches);
      const earlierMatches = (previous ?? []).filter(
        (fact) => fact.match.candidateSeat === seat && fact.match.map === map,
      );
      const earlier = previous === undefined ? undefined : averageOfCell(earlierMatches);
      const coverage =
        cell.known === cell.total
          ? ""
          : `（终局已知 ${String(cell.known)}/${String(cell.total)} 局）`;
      const body =
        cell.known === 0
          ? "终局未知，未将缺失解释为零，不报告平均名次与平均领土分"
          : `平均名次 ${number2(cell.rank)}，平均名次积分 ${number2(cell.points)}，平均领土分 ${number2(cell.territory)}（第一名 ${number2(cell.first)}，分差 ${number2(cell.gap)}），末位 ${String(cell.lastPlace)} 局${coverage}`;
      rows.push(
        `  座位${String(seat)} / ${map}：${String(cell.total)} 局，${body}；${changeOf(cell, earlier)}`,
      );
    }
  }
  return [
    "一、对差表（座位 × 地图聚合；Δ = 本阶段 − 上一阶段，分差 = 第一名领土分 − 候选领土分，末位 = 名次为本场最差名次、含并列、四方全并列时不算）",
    ...rows,
  ].join("\n");
};

/** 该场轮空的是哪一份陪练：网格的 `comboIndex` 就是在 `scripts` 里被轮空的那一份。 */
const sittingOutOf = (plan: TrialPlan, match: TrialPlanMatch): string | undefined =>
  // v1（三份基准全上、comboIndex 恒 0）没有轮空这一说，不能硬套网格的读法。
  plan.version === 1 ? undefined : plan.scripts[match.comboIndex]?.id;

/** 陪练角色的中文讲法（与 `docs/gdd.md` 的排行榜口径一致；`benchmark` 只出现在 v1 计划里）。 */
const ROLE_LABELS = {
  benchmark: "基准",
  top: "榜首",
  mid: "中位",
  last: "末位",
  incumbent: "在位",
} as const satisfies Readonly<Record<TrialSparringRole, string>>;

/** `role:slug` → `slug`（分隔符的真源在 schema，不在这里另写一份）。 */
const nameOfScript = (id: string): string =>
  id.slice(id.indexOf(TRIAL_SCRIPT_ID_SEPARATOR) + TRIAL_SCRIPT_ID_SEPARATOR.length);

/**
 * 陪练池：本阶段的对手是什么身份、从哪份存档装载、有没有代位。
 *
 * 代位是**来源**（`source` 带 `#substitute` 后缀）而不是另一个角色（见 runner 的
 * `sparring-pool.ts`），所以只读计划里已有的 `role` / `id` / `source`，不把身份在反馈里另存一份。
 * 于是「本阶段以 X 代位」这句话能直接从计划重建（反馈文本可从观测与计划复现）。
 */
const renderSparringPool = (plan: TrialPlan): string => {
  const rows = plan.scripts.map((script) => {
    const substitute = script.source.endsWith(TRIAL_SUBSTITUTE_SOURCE_SUFFIX);
    return `  ${ROLE_LABELS[script.role]} ${script.id} ← ${script.source}${
      substitute ? `；本阶段以 ${nameOfScript(script.id)} 代位` : ""
    }`;
  });
  return ["陪练池（本阶段的对手；每个组合轮空其中一份）：", ...rows].join("\n");
};

/**
 * 与候选**字节相同**的对手 id：候选就是那一位的镜像，那些场次照跑（确定性镜像，不回避）。
 *
 * 候选自己的编译产物摘要不进计划（候选的身份是字节），所以由调用方给；给不出就不标注——
 * 不猜、不拿「看起来一样」当字节相同。
 */
const mirroredScriptIds = (
  plan: TrialPlan,
  candidateScriptSha256: string | undefined,
): ReadonlySet<string> =>
  candidateScriptSha256 === undefined
    ? new Set()
    : new Set(
        plan.scripts
          .filter((script) => script.scriptSha256 === candidateScriptSha256)
          .map((script) => script.id),
      );

/**
 * 第二层：逐场一行。列序在表头写死，行里只放值。终局未知的场次三列都写「未知」，
 * 不把缺失写成 0 分或 0 名，也不猜结束原因。
 *
 * 候选与该场某位对手字节相同时逐场加一句「本场对手与你字节相同」：镜像局是确定性重演，
 * 照跑不回避，但读者必须能在**这一场**上认出来，而不是自己去对摘要。
 */
const renderMatchList = (
  plan: TrialPlan,
  facts: readonly MatchFacts[],
  mirrored: ReadonlySet<string>,
): string => {
  const rows = facts.map((fact) => {
    const sittingOut = sittingOutOf(plan, fact.match);
    const combo = `${String(fact.match.comboIndex)}（${sittingOut === undefined ? "无轮空" : `轮空 ${sittingOut}`}）`;
    const value =
      fact.kind === "observed"
        ? [String(fact.rank), fact.territories.join("/"), fact.summary.reason]
        : ["未知", "未知", "未知"];
    const mirror = fact.match.seats.some((id) => mirrored.has(id)) ? "｜本场对手与你字节相同" : "";
    return `  #${String(fact.match.matchIndex).padStart(2, "0")} | ${fact.match.map} | 座位${String(fact.match.candidateSeat)} | 组合${combo} | ${value.join(" | ")}${mirror}`;
  });
  return [
    "二、逐场一行（列序：场次 | 图 | 候选座位 | 组合（该场轮空的陪练） | 候选名次 | 四方领土分（按座位 0..3） | 结束原因；「本场对手与你字节相同」= 候选编译产物与该场某位对手的脚本摘要相同，镜像局照跑）",
    ...rows,
  ].join("\n");
};

/**
 * 最差三场的排序（确定且与输入顺序无关）：
 *
 * 1. 候选名次积分**升序**（分低者更差）；
 * 2. 再按候选领土分**升序**（积分相同时领土分低者更差）；
 * 3. 再按 `matchIndex` **升序**（前两键相同时靠场次定序，保证总序唯一）。
 *
 * 终局未知的场次**不进排序**（既不算作零分，也不占三席），若三席没满则按场次序把它们排进来
 * 展开——它们的缺失本身也是要看的事实。
 */
const worstMatches = (facts: readonly MatchFacts[]): readonly MatchFacts[] => {
  const ranked = facts
    .filter((fact): fact is ObservedMatch => fact.kind === "observed")
    .sort(
      (left, right) =>
        left.points - right.points ||
        left.territory - right.territory ||
        left.match.matchIndex - right.match.matchIndex,
    );
  const unknown = facts
    .filter((fact) => fact.kind === "unknown" && fact.reading !== undefined)
    .sort((left, right) => left.match.matchIndex - right.match.matchIndex);
  return [...ranked, ...unknown].slice(0, DETAIL_MATCHES);
};

/** 第三层：只展开最差三场的现有三栏事实（行动三栏 + 终局事实）。 */
const renderWorst = (facts: readonly MatchFacts[]): string => {
  const worst = worstMatches(facts);
  const blocks = worst.map((fact) => {
    const reading = fact.reading;
    const snapshot =
      reading === undefined
        ? "本场没有观测行，快照读数与终局事实都未知，未将缺失解释为零。"
        : `快照 delivered=${String(reading.delivered)}，captures=${String(reading.captures)}，noScoreSource=${String(reading.noScoreSource)}。`;
    return `- 第 ${String(fact.match.matchIndex + 1)} 个对局：${snapshot}\n${renderActions(reading)}\n${renderTerminal(fact.kind === "observed" ? fact.summary : null)}`;
  });
  const empty = worst.length === 0 ? ["  （没有可展开的场次：既无终局事实，也无观测行。）"] : [];
  return [
    "三、最差三场（排序：候选名次积分升序 → 候选领土分升序 → 场次升序；终局未知的场次不进排序、不足三场时按场次补足，不当作零分）",
    ...empty,
    ...blocks,
  ].join("\n");
};

/** 口径尾注：解释各栏怎么读，不解释为什么。 */
const FEEDBACK_TRAILER =
  "调用、即时错误返回与结算事实分别计量；undefined 返回不代表行动生效。movedSteps 是实际格移动次数，captureEvents 是占点事件次数，productionOrdersStarted 是开始订单数。快照读数不覆盖全部结算变化。终局 tick 是已执行 tick 数；淘汰 tick 为从零开始的编号。名次积分按并列占用名次区间均分；timeout 的第一名不代表胜利。这些观测不说明原因；依据既有契约返回完整脚本。";

/**
 * 事实回喂的入口：陪练池身份与覆盖声明 → 对差表 → 逐场一行 → 最差三场明细。
 *
 * `previous` 是**上一阶段**同一张网格的读数（首轮没有上一阶段 → undefined，对差表写「无上一阶段」）。
 * `candidateScriptSha256` 是本阶段候选的编译产物摘要：给了才能把「候选与某位对手字节相同」的
 * 场次逐场标出来（阈值判定就是字节相等，不靠名字或分数猜）。
 * 只陈述本候选的白名单事实；不从读数推断原因或给策略建议。
 */
export const renderScoreSourceFeedback = (
  readings: readonly TrialObservationLine[],
  plan: TrialPlan,
  previous?: readonly TrialObservationLine[],
  candidateScriptSha256?: string,
): string => {
  const facts = factsOf(plan, readings);
  const earlier = previous === undefined ? undefined : factsOf(plan, previous);
  return [
    `试跑观测：本候选实际完成的 ${String(readings.length)} 个对局。`,
    renderSparringPool(plan),
    coverageLine(plan, facts),
    renderDiffTable(plan, facts, earlier),
    renderMatchList(plan, facts, mirroredScriptIds(plan, candidateScriptSha256)),
    renderWorst(facts),
    FEEDBACK_TRAILER,
  ].join("\n");
};

/** 座位序（对差表的行序：先座位、再地图）。 */
const SEATS = [0, 1, 2, 3] as const satisfies readonly TrialPlanSeat[];

/** 只有这三场展开完整明细；三层里剩下两层每场只占一行（或一格）。 */
const DETAIL_MATCHES = 3;
/** matchIndex 列表：短就全列，长就列前五个并写明总数（体积上限下仍逐场可辨）。 */
const indexList = (indexes: readonly number[]): string => {
  const format = (values: readonly number[]): string =>
    values.map((index) => `#${String(index).padStart(2, "0")}`).join(" / ");
  return indexes.length <= 5
    ? format(indexes)
    : `${format(indexes.slice(0, 5))} … 共 ${String(indexes.length)} 场`;
};

/**
 * 覆盖声明：读数少于计划场数时单独说一句，不把没跑到的场次当零分插进平均。
 *
 * 行动事实的覆盖也在这里说**全网格**的账：完整多少场、缺失多少场、不完整多少场，并在有缺口时
 * 点名场次。否则「只有最差三场报告行动事实」会让其余场次的缺失看起来不存在（那正是把缺失
 * 写成零）。
 */
const coverageLine = (plan: TrialPlan, facts: readonly MatchFacts[]): string => {
  const known = facts.filter((fact) => fact.kind === "observed").length;
  const readings = facts.filter((fact) => fact.reading !== undefined).length;
  const actionOf = (fact: MatchFacts) => fact.reading?.actionFacts;
  const missing = facts.filter((fact) => actionOf(fact) === undefined);
  const partial = facts.filter((fact) => {
    const actionFacts = actionOf(fact);
    return actionFacts !== undefined && actionFacts.complete !== true;
  });
  const complete = facts.length - missing.length - partial.length;
  const detailOf = (indexes: readonly MatchFacts[]): string =>
    indexes.length === 0 ? "" : `（${indexList(indexes.map((fact) => fact.match.matchIndex))}）`;
  return (
    `覆盖：计划 ${String(plan.matches.length)} 场，读数 ${String(readings)} 场，终局可用 ${String(known)} 场；` +
    `行动事实完整 ${String(complete)} 场，缺失 ${String(missing.length)} 场${detailOf(missing)}，` +
    `不完整 ${String(partial.length)} 场${detailOf(partial)}；缺失一律不补零。`
  );
};
