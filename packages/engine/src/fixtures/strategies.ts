/**
 * 票 11 的**代理策略**:真引擎上没有可跑的真脚本(那 12 份要沙箱执行器,归节点 G),
 * 而首触复核与三条桩夹具都需要「会动、会采集、会造兵」的对局。这里给出两条**确定性**的
 * 代理策略——普通 TS 函数经 `stubRunner` 接进结算管线(ADR-0005),不经字符串、不经 VM。
 *
 * ── 它们是代理,不是那 12 个真脚本 ──
 *
 * 任何引用本文件读数的结论都必须写明「这是 F 侧的代理策略」。代理策略的行为面远小于真脚本
 * (没有模型判断、没有自记队列、没有盲写契约的错法),所以读数与真脚本那一代**不可互比**——
 * 可比的只有夹具(地图)与判据(例如首触的切比雪夫 ≤ 2)。
 *
 * ── 确定性的做法 ──
 *
 * 两条策略对**同一份快照**给出**同一批 intent**:输入只有这一 tick 的只读快照**,输出只由它
 * 决定;任何并列都按对象数值 id 升序取第一个(与引擎「数值升序是唯一被声明的定序语义」同源)。
 * 没有 `Date`、没有随机、没有跨局共享的模块级状态——采集策略的「记忆」挂在它自己的闭包里,
 * 每局每座位一份新闭包,所以十次重跑拿到的策略是十个互不影响的对象(FR-2 AC1 的前提)。
 *
 * ── 为什么不用引擎的 `moveTo` ──
 *
 * `moveTo` 由引擎现算 A* 取下一步,**目标格(或下一格)被占时本轮移动整体失败**。开局几 tick
 * 里几个农民同时挤向同一个矿、同一条窄道时会互相顶死,一局只采到个位数资源(这不是引擎 bug,
 * 是 `moveTo` 的既定语义)。采集策略因此自己走一步:**从当前格出发,按 (到目标的切比雪夫距离,
 * 对角优先, 方向序) 在**未被本 tick 任一单位占用的空格**里挑一格**,再用 `move` 提交。
 * 被顶住一 tick 就记住上次想走的格并避开它——这是把「谁先被遍历到」这种实现自由挡在夹具外面的
 * 唯一办法。
 */

import type { Ruleset } from "@model-war/replay";

import type { Intent } from "../processor/intents.js";
import type { StubStrategy } from "../runner/stub.js";
import type { PlayerIndex, Site, Snapshot, Unit } from "../world/state.js";

/** 切比雪夫距离。与 `processor/economy.ts` / `step3-combat.ts` 的射程判定同一个度量。 */
const chebyshev = (ax: number, ay: number, bx: number, by: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** 按 (切比雪夫距离, 数值 id) 升序取最近者——并列取低 id,顺序确定。 */
const nearestUnit = (from: Unit, candidates: readonly Unit[]): Unit | undefined => {
  let best: Unit | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = chebyshev(from.x, from.y, candidate.x, candidate.y);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate.id < best.id)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/** 按 (切比雪夫距离, 数值 id) 升序取最近的点位。 */
const nearestSite = (from: Unit, candidates: readonly Site[]): Site | undefined => {
  let best: Site | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = chebyshev(from.x, from.y, candidate.x, candidate.y);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate.id < best.id)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * **全军压上**:每个己方单位都朝最近的敌方单位走;已经贴到(切比雪夫 ≤1)就不动。
 *
 * 首触复核专用的**最小代理**:它不采集、不造兵,只把两端的单位直线拉近,好让「首触判据」由
 * 「真的碰上了」触发。用引擎的 `moveTo` 即可——开局离得远,不会堵。
 */
export const marchToNearestEnemy = (seat: PlayerIndex): StubStrategy => {
  return (snapshot: Snapshot): readonly Intent[] => {
    const enemies = snapshot.units.filter((unit) => unit.owner !== seat);
    if (enemies.length === 0) {
      return [];
    }
    const orders: Intent[] = [];
    for (const unit of snapshot.units) {
      if (unit.owner !== seat) {
        continue;
      }
      const target = nearestUnit(unit, enemies);
      if (target === undefined) {
        continue;
      }
      if (chebyshev(unit.x, unit.y, target.x, target.y) <= 1) {
        continue;
      }
      orders.push({ kind: "moveTo", unitId: unit.id, x: target.x, y: target.y });
    }
    return orders;
  };
};

/** 某一席在射程内的最近敌方单位(没有则 `undefined`)。 */
const nearestInRange = (
  from: Unit,
  candidates: readonly Unit[],
  range: number,
): Unit | undefined => {
  const inRange = candidates.filter(
    (candidate) => chebyshev(from.x, from.y, candidate.x, candidate.y) <= range,
  );
  return nearestUnit(from, inRange);
};

/** 一个单位上一 tick 的走位记忆:上次想进的格(被顶住时下一 tick 避开它)。 */
type StepMemory = {
  readonly x: number;
  readonly y: number;
  readonly tried: string | null;
};

/** 方向序:先对角、再正交,值固定——所有单位按同一顺序比较,只有目标与占位不同。 */
const DIRECTIONS: readonly (readonly [-1 | 0 | 1, -1 | 0 | 1])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * 朝 `target` 走一格(与 `moveTo` 的区别:自己按**本 tick 的占位**挑空格,不交给引擎的下一格)。
 * 没有可走的格就返回 `null`(原地不动,下 tick 再试)。
 */
const stepToward = (
  snapshot: Snapshot,
  unit: Unit,
  target: { readonly x: number; readonly y: number },
  memories: Map<number, StepMemory>,
): Intent | null => {
  const occupied = new Set<string>();
  for (const other of snapshot.units) {
    occupied.add(`${String(other.x)},${String(other.y)}`);
  }
  const memory = memories.get(unit.id);
  const moved = memory === undefined || memory.x !== unit.x || memory.y !== unit.y;
  const previousTried = moved ? null : (memory?.tried ?? null);

  let best: {
    readonly dx: -1 | 0 | 1;
    readonly dy: -1 | 0 | 1;
    readonly key: readonly number[];
  } | null = null;
  for (const [dx, dy] of DIRECTIONS) {
    const nextX = unit.x + dx;
    const nextY = unit.y + dy;
    if (nextX < 0 || nextY < 0 || nextX >= snapshot.size || nextY >= snapshot.size) {
      continue;
    }
    if (snapshot.terrain[nextY]?.[nextX] === true) {
      continue;
    }
    const cell = `${String(nextX)},${String(nextY)}`;
    if (occupied.has(cell) || cell === previousTried) {
      continue;
    }
    const key = [
      chebyshev(nextX, nextY, target.x, target.y),
      // 先对角后正交:对角一步缩两轴,平原上收敛更快。
      dx === 0 || dy === 0 ? 1 : 0,
      dx,
      dy,
    ] as const;
    if (best === null || compareKey(key, best.key) < 0) {
      best = { dx, dy, key };
    }
  }
  if (best === null) {
    return null;
  }
  memories.set(unit.id, {
    x: unit.x,
    y: unit.y,
    tried: `${String(unit.x + best.dx)},${String(unit.y + best.dy)}`,
  });
  return { kind: "move", unitId: unit.id, dx: best.dx, dy: best.dy };
};

const compareKey = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < left.length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

/** 采集型经济:农民在自家矿与自家基地之间往返,基地按需造 `spawnType`;非农民朝目标走。 */
export type EconomyOptions = {
  /** 基地空产线时造的兵种。缺省 `worker`(把经济拉满)。 */
  readonly spawnType?: "worker" | "melee" | "ranged" | "cavalry";
  /** 是否在基地空产线且资金够时下单。`false` = 只采集、不产兵。 */
  readonly reinforce?: boolean;
  /**
   * 非农民单位的打法。`"units"`(缺省)= 追最近的敌方单位;
   * `"bases"` = 推敌方基地(站上点位格累积占领),路上顺手打射程内的敌人。
   * 后者才可能把对局推入「淘汰」那一档形(终局形态夹具需要非全超时的样本)。
   */
  readonly objective?: "units" | "bases";
  /** 该席位的单位数上限:到了就不再下单。缺省 `Infinity`(把经济拉满)。 */
  readonly maxUnits?: number;
};

/**
 * **农民经济 + 单兵种补充**。
 *
 * - 农民:`carrying > 0` 就近交付给自家基地;否则就近采集自家未采空的资源点;两者都要先走到
 *   射程内(`worker.range`,当前 1)。
 * - 非农民:朝最近的敌方单位走,进射程就 `attack`。
 * - 基地:`reinforce` 且空产线且资金够 `spawnType` 造价时下 `spawnUnit` 一单。
 *
 * 产线忙碌是**静默丢弃**(引擎不报错),所以这里只判 `producing === null` 再下单,与
 * 契约面「先读产线、为空才下单」一致。造价从传入的规则集读,策略里不出现魔数。
 */
export const harvestEconomy = (
  seat: PlayerIndex,
  ruleset: Ruleset,
  options: EconomyOptions = {},
): StubStrategy => {
  const spawnType = options.spawnType ?? "worker";
  const reinforce = options.reinforce ?? true;
  const objective = options.objective ?? "units";
  const maxUnits = options.maxUnits ?? Infinity;
  // 记忆挂在闭包里:每局每座位一份,不跨局共享(十次重跑的前提)。
  const memories = new Map<number, StepMemory>();
  return (snapshot: Snapshot): readonly Intent[] => {
    const orders: Intent[] = [];
    const own = snapshot.units.filter((unit) => unit.owner === seat);
    const mines = snapshot.sites.filter(
      (site) => site.kind === "resource" && site.owner === seat && (site.remaining ?? 0) > 0,
    );
    const bases = snapshot.sites.filter((site) => site.kind === "base" && site.owner === seat);
    const enemyBases = snapshot.sites.filter(
      (site) => site.kind === "base" && site.owner !== seat && site.owner !== -1,
    );
    const enemies = snapshot.units.filter((unit) => unit.owner !== seat);
    const workerRange = ruleset.worker.range;

    for (const unit of own) {
      if (unit.type !== "worker") {
        const inRange = nearestInRange(unit, enemies, ruleset[unit.type].range);
        if (inRange !== undefined) {
          orders.push({ kind: "attack", unitId: unit.id, targetId: inRange.id });
          continue;
        }
        const target =
          objective === "bases" ? nearestSite(unit, enemyBases) : nearestUnit(unit, enemies);
        if (target === undefined) {
          continue;
        }
        // 已站在目标点位上:不动,让占领进度自己累积(离开就清零)。
        if (unit.x === target.x && unit.y === target.y) {
          continue;
        }
        const step = stepToward(snapshot, unit, target, memories);
        if (step !== null) {
          orders.push(step);
        }
        continue;
      }
      if (unit.carrying > 0) {
        const base = nearestSite(unit, bases);
        if (base === undefined) {
          continue;
        }
        if (chebyshev(unit.x, unit.y, base.x, base.y) <= workerRange) {
          orders.push({ kind: "transfer", unitId: unit.id });
        } else {
          const step = stepToward(snapshot, unit, base, memories);
          if (step !== null) {
            orders.push(step);
          }
        }
        continue;
      }
      const mine = nearestSite(unit, mines);
      if (mine === undefined) {
        continue;
      }
      if (chebyshev(unit.x, unit.y, mine.x, mine.y) <= workerRange) {
        orders.push({ kind: "harvest", unitId: unit.id, siteId: mine.id });
      } else {
        const step = stepToward(snapshot, unit, mine, memories);
        if (step !== null) {
          orders.push(step);
        }
      }
    }

    const base = bases[0];
    const player = snapshot.players.find((candidate) => candidate.index === seat);
    if (
      reinforce &&
      own.length < maxUnits &&
      base !== undefined &&
      player !== undefined &&
      base.producing === null &&
      player.resources >= ruleset[spawnType].cost
    ) {
      orders.push({ kind: "spawnUnit", baseId: base.id, unitType: spawnType });
    }
    return orders;
  };
};
