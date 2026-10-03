// PROTOTYPE (throwaway) —— 三张 64×64 墙图 + 度量。
//
// 手法：每张图由「左上象限的一组形状」+ 4 次 90° 旋转展开得到，
// 于是四重旋转对称是**构造保证**而不是事后断言。四图共享同一套点位（沿用桩的 center-fortress@64）。
// 形状是作者面（比手写 32×32 ASCII 抗错）；展开后用终端 ASCII 肉眼看。

import { buildMap } from '../../rules-calibration/sim/map.mjs';

export const SIZE = 64;
export const HALF = SIZE / 2; // 32

// 与桩 map.mjs 同一行 rot（那边未导出，这里复刻一行；下面用桩产出的 sites/spawn 反证一致）
export function rot(x, y, size = SIZE) {
  return [size - 1 - y, x];
}

// --- 作者面：形状 -> 单元格集合（作者只在左上象限写坐标，展开器负责 4 次旋转）---
const cell = (x, y) => [x, y];
const rect = (x0, y0, w, h) => {
  const out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(cell(x, y));
  return out;
};
const vline = (x, y0, y1) => rect(x, y0, 1, y1 - y0 + 1);
const hline = (y, x0, x1) => rect(x0, y, x1 - x0 + 1, 1);
const poly = (...cs) => cs.map(([x, y]) => cell(x, y));
export const flat = (...shapes) => shapes.flat();
export { rect, vline, hline, poly };

// 4 重闭包：作者写 1 个象限，展开器补齐另外 3 个（缺口的另外 3 份也在这里被补出来）
export function orbit4(x, y) {
  const out = [];
  let cur = [x, y];
  for (let i = 0; i < 4; i++) {
    out.push(cur);
    cur = rot(cur[0], cur[1]);
  }
  return out;
}

// 方环：盒 [lo,hi]² 的边框，挖掉 gapSeeds 的 4 重闭包
// 注意：缺口必须一次给出 4 份（否则 4 重闭包会把另外 3 份补回来，等于没挖）。
const ring = (lo, hi, gapSeeds = []) => {
  const out = [];
  for (let x = lo; x <= hi; x++) out.push(cell(x, lo), cell(x, hi));
  for (let y = lo + 1; y < hi; y++) out.push(cell(lo, y), cell(hi, y));
  const drop = new Set(gapSeeds.flatMap(([x, y]) => orbit4(x, y)).map(([x, y]) => `${x},${y}`));
  return out.filter(([x, y]) => !drop.has(`${x},${y}`));
};
export { ring };

const OPEN = flat(
  poly([21, 9], [22, 9], [22, 10]),                      // 三格 L
  rect(12, 20, 2, 2),                                    // 2×2 块
  hline(29, 7, 9),                                       // 三格横条
  poly([13, 5], [14, 5], [14, 6]),                      // 三格 L
  rect(21, 19, 2, 2),                                    // 2×2 块
  hline(11, 24, 25),                                     // 两格短条
  poly([5, 22], [5, 23], [6, 23]),                      // 三格 L
  vline(30, 24, 25),                                     // 两格短条
  hline(30, 16, 17),                                     // 两格短条
  poly([2, 4], [2, 5], [3, 5]),                          // 三格 L
  // 唯二「站在路上」的两小撮：否则开阔图的墙对移动零影响（378 个点位对全 1.00），
  // 那就等于「无墙图」，风格差异全靠密度而不是靠墙。
  poly([22, 22], [23, 23]),                              // 压在 次内圈矿 → 中心基地 的对角线
  poly([22, 26], [23, 26]),                              // 压在 更内圈矿 → 中心基地 的横线
);

const CORRIDOR = flat(
  // 内环（盒 [21,42]）：4 个 5 格宽的偏心口，风车排布（口宽 5 是试出来的：3 格会把中路推到 21，见 corridor-try.mjs）
  ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]),
  // 外环（盒 [13,50]）：4 个 3 格宽的偏心口，与内环同样风车
  ring(13, 50, [[17, 13], [18, 13], [19, 13]]),
);

const FORTRESS = flat(
  // 中心内环（盒 [28,35]）：4 个 2 格宽的正门
  ring(28, 35, [[31, 28], [32, 28]]),
  // 外层碉堡线：四角 L（盒 [22,41] 的四角，各留一个宽口）
  poly([22, 22], [23, 22], [24, 22], [25, 22], [22, 23], [22, 24], [22, 25]),
  // 每家角落的一道短幕墙（不挡家门→自家矿的路）
  poly([5, 8], [5, 9], [5, 10], [6, 5], [7, 5], [8, 5]),
);

export const STYLES = [
  { key: 'open', label: '开阔对攻图', shapes: OPEN, intent: '墙少、分散、不成线' },
  { key: 'corridor', label: '廊道分割图', shapes: CORRIDOR, intent: '两层同心方环，战场被切成 3 条同心带' },
  { key: 'fortress', label: '中心要塞图', shapes: FORTRESS, intent: '中心紧环 + 四角碉堡线，进出只有 4 个门' },
];

/** 象限形状 → 64×64 字符矩阵（'#' 墙 / '.' 平原），四重旋转由构造保证 */
export function expand(shapes) {
  const grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill('.'));
  for (const [x0, y0] of shapes) {
    let cur = [x0, y0];
    for (let i = 0; i < 4; i++) {
      if (cur[0] < 0 || cur[1] < 0 || cur[0] >= SIZE || cur[1] >= SIZE) {
        throw new Error(`形状越界：${x0},${y0} 的第 ${i} 次旋转 ${cur}`);
      }
      grid[cur[1]][cur[0]] = '#';
      cur = rot(cur[0], cur[1]);
    }
  }
  return grid;
}

/** 一张图 = 桩的点位/起始单位 + 自己画的 terrain */
export function buildStyled(styleKey) {
  const style = STYLES.find((s) => s.key === styleKey);
  if (!style) throw new Error(`unknown style ${styleKey}`);
  const base = buildMap(1, { size: SIZE, variant: 'center-fortress' });
  const grid = expand(style.shapes);
  const map = {
    ...base,
    name: styleKey,
    terrain: grid.map((row) => row.map((c) => (c === '#' ? 'wall' : 'plain'))),
  };
  return { map, style, grid, sites: base.sites, spawnUnits: base.spawnUnits };
}

/** rot 一致性反证：象限定稿器复刻的 rot 必须把桩的点位轨道原样搬出来 */
export function assertRotMatchesStub(styled) {
  for (const s of styled.sites) {
    const [x, y] = rot(s.x, s.y);
    const hit = styled.sites.find((o) => o.x === x && o.y === y);
    if (!hit || hit.kind !== s.kind) {
      throw new Error(`rot 与桩不一致：点位 ${s.x},${s.y} 旋到 ${x},${y} 找不到同类点位`);
    }
  }
}
