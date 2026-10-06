/**
 * 夹具 #9「终局形态的已知边界」(`docs/gdd.md` §8 #9)的可跑宿主。
 *
 * ── 原桩那条探针的定义(逐字抽自聚合器与取证表) ──
 *
 * 桩 `tables.mjs` §1.4 把每批矩阵的**收口形态**印成一行:场次、`结局 tick 中位`、
 * `400 前结束`、`全点位胜 / 捷径胜 / 超时` 三个原因计数。§8 再补三项结构质量:
 * `领先者易手次数`(每 5 tick 采样的领土分榜首变化)、`末位翻盘夺冠`(tick≥300 时排第 4 → 终局第 1)、
 * `首淘汰` tick。**本夹具量同一批量**:
 *
 * - `reason` / `outcomeTick` / `before400` —— 收口形态(§1.4 那三栏);
 * - `firstEliminationTick` —— 第一条 `player-eliminated` 事件所在 tick(§8);
 * - `leaderChanges` —— 每 5 tick 取领土分榜首,数它换了几次(§8);
 * - `comeback` —— 采样点(≤300 的最后一帧)里领土分最低、终局却排第 1 的那一席(§8)。
 *
 * ── 领土分从哪来 ──
 *
 * 领土分的唯一实现在 `processor/outcome.ts` 的 `territoryScoreOf`。本夹具**不重抄公式**:
 * 把回放的一行还原成一份状态(只换 `players` / `units` / `sites` 三栏,其余借终局状态),
 * 再调那份唯一实现——公式因此只有一个家。复验时拿这批形态读数去对 §8 #9 的「接受 + 记录」
 * 与 §1.4 的窗口;**本票不下结论**。
 */

import type { Ruleset, ReplaySite, ReplayTickLine } from "@model-war/replay";

import { territoryScoreOf } from "../processor/outcome.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import type { GameState, Owner, PlayerIndex, Site } from "../world/state.js";
import type { FixtureMatch } from "./harness.js";
import { SEATS, tickLinesOf } from "./harness.js";

/** 领先者易手次数的采样间隔(与桩一致:每 5 tick)。 */
const LEADER_SAMPLE_EVERY = 5;

/** 中途名次快照的时点(与桩一致:tick≈300)。 */
const HALF_TICK = 300;

/** 回放里的点位属主是宽 `number`,引擎状态里是 `Owner`。转换时逐条收窄,不收就抛。 */
const toOwner = (value: number): Owner => {
  if (value === -1 || value === 0 || value === 1 || value === 2 || value === 3) {
    return value;
  }
  throw new Error(`回放里出现了非法属主:${String(value)}`);
};

const toSite = (site: ReplaySite): Site => ({
  ...site,
  owner: toOwner(site.owner),
  progressOwner: toOwner(site.progressOwner),
});

/** 把回放的一行还原成一份状态:只换三栏,其余借终局状态(公式只读这三栏)。 */
const stateAtTick = (match: FixtureMatch, line: ReplayTickLine): GameState => ({
  ...match.finalState,
  tick: line.tick,
  players: line.players,
  units: line.units,
  sites: line.sites.map(toSite),
});

/** 一条对局的终局形态读数。 */
export type EndgameForm = {
  readonly reason: FixtureMatch["result"]["reason"];
  readonly outcomeTick: number;
  readonly before400: boolean;
  readonly firstEliminationTick: number | null;
  readonly leaderChanges: number;
  readonly comeback: boolean;
};

export const endgameFormOf = (match: FixtureMatch, ruleset: Ruleset): EndgameForm => {
  const view = loadRuleset(ruleset);
  const lines = tickLinesOf(match.parsed);

  const firstElimination = lines.find((line) =>
    line.events.some((event) => event.kind === "player-eliminated"),
  );

  let leaderChanges = 0;
  let previousLeader: PlayerIndex | null = null;
  let halfScores: readonly number[] | null = null;
  for (const line of lines) {
    if (line.tick % LEADER_SAMPLE_EVERY !== 0) {
      continue;
    }
    const state = stateAtTick(match, line);
    const scores = SEATS.map((seat) => territoryScoreOf(state, view, seat));
    if (line.tick <= HALF_TICK) {
      halfScores = scores;
    }
    let leader: PlayerIndex = 0;
    let best = -Infinity;
    SEATS.forEach((seat) => {
      const score = scores[seat] ?? -Infinity;
      if (score > best) {
        best = score;
        leader = seat;
      }
    });
    if (previousLeader !== null && leader !== previousLeader) {
      leaderChanges += 1;
    }
    previousLeader = leader;
  }

  // 「末位翻盘夺冠」:采样点里领土分最低的那一席,终局是否排第 1。并列取高座位(末位口径)。
  let comeback = false;
  if (halfScores !== null) {
    let lowest: PlayerIndex = 0;
    let worst = Infinity;
    SEATS.forEach((seat) => {
      const score = halfScores[seat] ?? Infinity;
      if (score <= worst) {
        worst = score;
        lowest = seat;
      }
    });
    comeback = match.result.rankings[lowest] === 1;
  }

  return {
    reason: match.result.reason,
    outcomeTick: match.tickCount,
    before400: match.tickCount < 400,
    firstEliminationTick: firstElimination?.tick ?? null,
    leaderChanges,
    comeback,
  };
};

export const endgameFormsOf = (
  matches: readonly FixtureMatch[],
  ruleset: Ruleset,
): readonly EndgameForm[] => matches.map((match) => endgameFormOf(match, ruleset));
