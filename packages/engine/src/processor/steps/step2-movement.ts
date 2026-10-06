/**
 * 步 2 · movement:移动结算(hld §4.4、`rules.md` §3)。
 *
 * ── 两相位 ──
 * 「一轮只以该轮开始时的占位为准」把「算目标」与「落子」分成两个相位:先把本轮全部候选算出来
 * (基线从头到尾不变),再按目标格做竞争裁决、把赢家按对象数值 id 升序落子。逐条就地写状态做不到
 * 这件事——一个单位能不能进某格,取决于**同时提交**的其他单位想进哪一格。
 *
 * ── 轮转优先 ──
 * 同格竞争按 `(tick + playerIndex) mod 4` 的**值大者胜**。四个座位的优先值互不相同,所以
 * 跨座位的竞争没有平手。**同一座位的两个单位争同一格**时优先值相同(座位与 tick 都相同),
 * 票面那句话没覆盖这一格:这里的裁决是「按意图的确定序取先者」,而意图序是 `(seat, 单位 id)`
 * 升序,于是低 id 胜。这条补进 `## Answer`。
 *
 * ── 骑兵的二次移动 ──
 * hld §4.4:「重复整轮结算一次——第一轮结算后的占位即第二轮的基准,轮转优先中的 `tick` 值不变」。
 * 实现是「每轮重跑同一套裁决」,第 N 轮的基准换成第 N−1 轮结算之后的状态;`tick` 取自 `state.tick`
 * (步 6 才加一),所以两轮同值。轮数 = 全场最大 `speed`(见 `movement.ts` 的 `maxMoveRounds`)。
 *
 * ── 首触 ──
 * 本步的槽位也收 `first-contact`(收集器 `STEP_OF` 把它挂在步 2)。判定在**移动结算之后**做,
 * 这样记下的是「真的碰上了」的那个位置,而不是「下完单、还没动」的位置。
 */

import { apply } from "../../driver/apply.js";
import {
  checkMove,
  isMoveIntent,
  maxMoveRounds,
  runMove,
  unitById,
  type MoveCandidate,
  type MoveIntent,
} from "../movement.js";
import type { RulesetView } from "../../ruleset-loader/index.js";
import type { GameState, PlayerIndex, Unit } from "../../world/state.js";
import type { Step } from "../context.js";

/** 座位下标。它是**编号**不是参数,与浮点禁令无关。 */
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/**
 * 首触判据的接近度阈值:任意敌对单位 Chebyshev 距离 ≤ 2。
 *
 * 出处(一次性标定环的桩数据,`gdd.md:123` 只有定性的半句「首触判据吃的是接近度」):
 * `.scratch/rules-landing/blind/fixture-check/tables-1336-rerun-2026-10-04.md:51`
 * 「首触(任意敌对单位 Chebyshev ≤2)| 窗口 0–40」。欠账在 gdd 那一侧(补正文是 gdd 那一格的事)。
 *
 * 真引擎上的首触实测复核(票 11)已就地补在 `gdd.md:123` 那一段的末尾:三张真图在本判据下
 * 的首触读数、以及必须随引用一起带的那条基线偏差(无墙夹具中位 34 vs 设计锚点 40),都在那里;
 * 判据本身不改。夹具在 `packages/engine/src/fixtures/fixtures.test.ts`。
 *
 * ── 为什么这个阈值**不进**规则集 ──
 * 它是**观测量**:只给事件流标一个时刻,不判胜负、不判合法、不影响移动。判据是「凡观测量不进参数表」,
 * 与真源包那个「键数是 21 不是 22」的裁决同源——所以 `rulesets/v1.json` 保持 21 键是对的,
 * 它**不是**那个裁决的反例。不写这句理由,后来者会按「一切数值都该进规则集」把它加成第 22 键。
 */
const FIRST_CONTACT_CHEBYSHEV = 2;

/** 一条候选与它属于哪个座位。竞争裁决要座位算轮转优先值。 */
type Candidate = {
  readonly seat: PlayerIndex;
  readonly change: MoveCandidate;
};

/** 轮转优先值:`(tick + playerIndex) mod 4`,值大者胜(gdd §3.3 / rules.md §3.1)。 */
const priorityOf = (tick: number, seat: PlayerIndex): number => (tick + seat) % 4;

/**
 * 一轮的竞争裁决:目标格相同的候选挑出唯一的赢家,其余本轮原地不动。
 *
 * 遍历序是 `(seat, 对象数值 id)` 升序(步 1 的定序),所以「优先值相同取先者」= 同座位取低 id。
 * 返回的赢家按对象数值 id 升序排——落子顺序是确定序的一部分。
 */
const winnersOf = (tick: number, candidates: readonly Candidate[]): readonly MoveCandidate[] => {
  const best = new Map<string, { readonly priority: number; readonly change: MoveCandidate }>();
  for (const { seat, change } of candidates) {
    const key = `${String(change.x)}:${String(change.y)}`;
    const priority = priorityOf(tick, seat);
    const current = best.get(key);
    if (current === undefined || priority > current.priority) {
      best.set(key, { priority, change });
    }
  }
  return [...best.values()]
    .map(({ change }) => change)
    .sort((left, right) => left.unitId - right.unitId);
};

/** 这一轮该单位还走不走得动:单位存在且 `speed > round`。骑兵 2 轮,其余 1 轮。 */
const eligible = (
  view: GameState,
  ruleset: RulesetView,
  round: number,
  intent: MoveIntent,
): boolean => {
  const unit = unitById(view, intent.unitId);
  return unit !== undefined && ruleset.statsOf(unit.type).speed > round;
};

/** 一条单位是否与某个敌对单位 Chebyshev ≤ 2。 */
const hasEnemyWithin = (state: GameState, unit: Unit): boolean =>
  state.units.some(
    (other) =>
      other.owner !== unit.owner &&
      Math.max(Math.abs(unit.x - other.x), Math.abs(unit.y - other.y)) <= FIRST_CONTACT_CHEBYSHEV,
  );

/**
 * 首触事件的主体:按对象数值 id 升序,取**第一个**存在敌对单位与之 Chebyshev ≤ 2 的单位 id。
 *
 * 这个选取是确定性的,且与「步内按对象数值 id 升序」这条定序语义同源——换一个遍历序就会
 * 让同一局的回放出现不同的 `subjectId`。
 */
const firstContactSubject = (state: GameState): number | null => {
  for (const unit of state.units) {
    if (hasEnemyWithin(state, unit)) {
      return unit.id;
    }
  }
  return null;
};

export const step2Movement: Step = (context) => {
  const { ruleset, collector } = context;
  const rounds = maxMoveRounds(ruleset);
  // 步 1 只把移动两条放行到这里,但类型上仍是六条的联合(收窄由 `isMoveIntent` 在这一层再做一次,
  // 这样即使有人直接拿未过滤的上下文调步 2,它也只谈移动)。
  const moves = context.intents.flatMap(({ seat, intent }) =>
    isMoveIntent(intent) ? [{ seat, intent }] : [],
  );
  let state = context.state;
  let calls = context.pathfindingCalls;

  for (let round = 0; round < rounds; round++) {
    // 本轮基准 = 上一轮结算之后的状态。**整轮候选都从这一份基线算**,中途不改 state。
    const view = state;
    const evaluated = moves.map(({ seat, intent }) => {
      if (!eligible(view, ruleset, round, intent)) {
        return { seat, pathCall: 0, change: null as MoveCandidate | null };
      }
      const valid = checkMove(view, seat, intent);
      // A* 只在 check 放行后调用(与 runMove 的调用点一致),账才是真的调用量。
      const pathCall = valid && intent.kind === "moveTo" ? 1 : 0;
      const change = valid ? runMove(view, seat, ruleset, round, intent) : null;
      return { seat, pathCall, change };
    });

    const delta = SEATS.map((seat) =>
      evaluated.reduce((sum, item) => sum + (item.seat === seat ? item.pathCall : 0), 0),
    );
    calls = calls.map((count, seat) => count + (delta[seat] ?? 0));

    const candidates = evaluated.flatMap((item) =>
      item.change === null ? [] : [{ seat: item.seat, change: item.change }],
    );
    for (const change of winnersOf(state.tick, candidates)) {
      state = apply(state, ruleset.raw, change);
    }
  }

  // 首触:整局一条,判在移动之后;记忆进状态(唯一跨 tick 的东西),写它走 apply() 的登记。
  if (state.firstContactTick === null) {
    const subject = firstContactSubject(state);
    if (subject !== null) {
      collector.firstContact(subject);
      state = apply(state, ruleset.raw, { kind: "mark-first-contact", tick: state.tick });
    }
  }

  return { ...context, state, pathfindingCalls: calls };
};
