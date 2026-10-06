/**
 * 寻路(hld §4.7):八邻域、固定方向表、整数步长与 Chebyshev×2 启发式。
 *
 * ── 同一实现,两处消费者 ──
 * 现在的唯一调用点是移动裁决里的 `moveTo`(本 tick 走一步);将来沙箱 runtime bundle 暴露的
 * `findPath` 脚本 API 要**复用同一个实现**(hld §4.7「同一实现保证脚本查询结果与引擎实际移动一致」)。
 * 所以本模块**只吃数据、只吐数据**:地形 + 尺寸 + 起点 + 终点 → 路径或「不可达」,
 * 不碰 `GameState`、不碰随机、不碰时钟。它一旦与 `moveTo` 分叉,脚本算出的路与引擎走的路就会不同。
 *
 * ── v1 的 CostMatrix:墙不可通行,其余等价 ──
 * 地形之外只看边界。**完全不看单位占位**——占位是移动裁决那一层的事(hld §4.4),
 * 寻路的地图里开放格一律等价。把占位塞进寻路会把「本 tick 的基准」这件跨 tick 的事实
 * 带进一个本该无状态的查询里。
 *
 * ── 全整数 ──
 * 直走与斜走同为 `STEP = 2`,启发式是 `2 * max(|dx|, |dy|)`(Chebyshev 的两倍,与步长同量纲、
 * 可采纳、且一致)。这样代价与启发式都不出现分数、平方根或小数,`check:no-float` 门禁不会红,
 * 也不需要任何 `Math.sqrt` / `1.5` —— 那类写法即便门禁漏网,也会让「同一局重跑得到逐项相同的路径」
 * 变成一件依赖浮点舍入的事。
 *
 * ── 平手怎么破 ──
 * `f` 相同时按格子的**线性下标** `y * size + x` 升序取先者。票面写的是「平手按 id 破」,
 * 那是宽泛说法——格子没有对象 id,它在本仓对应的确定序就是线性下标(与「步内按对象数值 id 升序」
 * 同源的书写顺序)。
 */

import type { Terrain } from "../world/state.js";

/** 网格坐标。与 `world/state.ts` 的 `Unit.x/y` 同一坐标域。 */
export type Point = {
  readonly x: number;
  readonly y: number;
};

/**
 * 一步的代价。直走与斜走同价——八邻域下这是「一步就是一格」的代价读法。
 * 它是本文件里出现的唯一一个步长数值,启发式与它的倍率绑在一起(见 `HEURISTIC_SCALE`)。
 */
const STEP = 2;

/**
 * 启发式的倍率。它**必须与步长同量纲**(也就是等于 `STEP`):Chebyshev 距离乘 2 之后,
 * 「离目标的格数」与「已经走过的代价」才在同一个刻度上。启发式放大(比如 ×4)会让 A*
 * 变得不再可采纳,于是它会把绕远路当成最优;缩小只会多探几格,不至于错,但会让代价与启发式
 * 不在同一刻度的理由消失。两处一起改才安全,所以它们并排写在这里。
 */
const HEURISTIC_SCALE = 2;

/**
 * 八邻域方向表。
 *
 * **表的顺序是确定性的一部分,不是实现细节,改序即改结果**:它同时是「谁先被算进 open 集」的
 * 书写顺序,而代价相同时先到者定下前驱。故这张表是 `as const` 的固定元组,顺序按方位
 * 从北起顺时针列(北、东北、东、东南、南、西南、西、西北),不是随手排的。
 */
const DIRECTIONS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/** 线性下标。它是格子在本文件里的唯一身份,也是平手时的确定序键。 */
const indexOf = (x: number, y: number, size: number): number => y * size + x;

/**
 * 一格能否通行:在界内且不是墙。
 *
 * 斜走**只看目标格**:v1 的 CostMatrix 没有「防割角」这一条,而最省事的读法是「目标格不是墙即可」。
 * 也就是说,两墙夹住的对角格是**可通行**的——这一步显式定死并配用例,免得后来者按「应该防割角」
 * 顺手改掉它,那会是一次规则变更而不是重构。
 */
const passable = (terrain: Terrain, size: number, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return false;
  }
  return terrain[y]?.[x] !== true;
};

/** Chebyshev 距离 × 2。与 `STEP` 同量纲,可采纳且一致。 */
const heuristic = (from: Point, to: Point): number =>
  HEURISTIC_SCALE * Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));

const less = (left: number, right: number, f: Int32Array): boolean =>
  f[left]! < f[right]! || (f[left] === f[right] && left < right);

/** 上浮。手写二叉堆,避免依赖任何容器库(engine 不新增依赖)。 */
const heapPush = (heap: number[], node: number, f: Int32Array): void => {
  heap.push(node);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!less(heap[at]!, heap[parent]!, f)) {
      break;
    }
    [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
    at = parent;
  }
};

/** 下沉。返回堆顶(本轮 `f` 最小的格),堆空则 `undefined`。 */
const heapPop = (heap: number[], f: Int32Array): number | undefined => {
  if (heap.length === 0) {
    return undefined;
  }
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let smallest = at;
      if (left < heap.length && less(heap[left]!, heap[smallest]!, f)) {
        smallest = left;
      }
      if (right < heap.length && less(heap[right]!, heap[smallest]!, f)) {
        smallest = right;
      }
      if (smallest === at) {
        break;
      }
      [heap[at], heap[smallest]] = [heap[smallest]!, heap[at]!];
      at = smallest;
    }
  }
  return top;
};

/**
 * 起点到终点的最短路径(含起点与终点);终点不可达时 `null`。
 *
 * 不可达包括:终点越界或本身是墙、起点被完全封死、以及起点终点之间存在无路可走的墙群。
 * 起点与终点相同时返回只含起点的一项数组(「已经在那儿」是合法查询,不是不可达)。
 */
export const findPath = (
  terrain: Terrain,
  size: number,
  from: Point,
  to: Point,
): readonly Point[] | null => {
  if (!passable(terrain, size, to.x, to.y)) {
    return null;
  }
  if (from.x === to.x && from.y === to.y) {
    return [{ x: from.x, y: from.y }];
  }

  const count = size * size;
  // `-1` 是「还没探到」的哨兵。用它而不是 `Infinity`:同一条整数闭包的理由。
  const best = new Int32Array(count).fill(-1);
  const estimate = new Int32Array(count).fill(-1);
  const parent = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);

  const start = indexOf(from.x, from.y, size);
  const goal = indexOf(to.x, to.y, size);
  best[start] = 0;
  estimate[start] = heuristic(from, to);

  const open: number[] = [];
  heapPush(open, start, estimate);

  while (true) {
    const current = heapPop(open, estimate);
    if (current === undefined) {
      return null;
    }
    if (current === goal) {
      break;
    }
    if (closed[current] === 1) {
      continue;
    }
    closed[current] = 1;
    // 由线性下标取回坐标。`Math.floor` 在白名单内,商与余数都是整数。
    const cx = current % size;
    const cy = Math.floor(current / size);
    for (const [dx, dy] of DIRECTIONS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!passable(terrain, size, nx, ny)) {
        continue;
      }
      const next = indexOf(nx, ny, size);
      if (closed[next] === 1) {
        continue;
      }
      const tentative = best[current]! + STEP;
      if (best[next] === -1 || tentative < best[next]!) {
        best[next] = tentative;
        parent[next] = current;
        estimate[next] = tentative + heuristic({ x: nx, y: ny }, to);
        heapPush(open, next, estimate);
      }
    }
  }

  const path: Point[] = [];
  let node = goal;
  while (node !== -1) {
    path.push({ x: node % size, y: Math.floor(node / size) });
    node = parent[node]!;
  }
  return path.reverse();
};
