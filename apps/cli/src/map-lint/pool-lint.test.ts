/**
 * `map-lint` 池级规则的自测(spec《Testing Decisions》主缝的池级那半边)。
 *
 * 断言对象仍是**纯函数**:「一个地图池 → 一组带定位的违规」。目录遍历与退出码不在这儿
 * (「目录薄壳不单独测」沿用票 03 与仓库既有先例),那部分在 `cli.test.ts` 的进程级断言里。
 *
 * ── 合规池是程序内构造的,不是落库的 ──────────────────────────────────────────
 * 落库的 `maps/` 现在只有一张图,而池级判据要求至少 3 张。本票**不落三张图**(那是票 05 的活),
 * 所以这里现场构造:共用落库那张图(开阔对攻图)的点位,只改墙。
 * 用落库那张图当原料是有意的——它保证「最近一圈归属」这些判据面对的是真布局,不是玩具布局。
 *
 * 墙从**候选变体轨道**里取(`variantSlots`):那 8 条轨道实测一格不压点位及其八邻域、
 * 天生四重对称,于是「换一组墙」不必重画一张图,也不会顺手造出别的违规。
 * 落库文件本身只在测试开头读一次,反例从它改出来,所以「反例真的只坏了那一处」是可读的。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { MapDefinition } from "@model-war/schema";
import { expect, it } from "vitest";

import { validateMap } from "../validator.js";
import {
  MAX_MINE_ROUTE,
  MAX_WALL_JACCARD,
  POOL_MIN_MAP_COUNT,
  poolMapFileNames,
  poolViolations,
} from "./pool.js";
import { renderPoolViolations } from "./render.js";
import { mapViolations, orbitOf, type MapLintRule, type MapLintViolation } from "./rules.js";

/** 仓库里落库的合规地图(开阔对攻图)。读它而不是重抄一份:重抄的那份迟早与 `maps/` 漂移。 */
const OPEN: MapDefinition = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../maps/open-clash.json", import.meta.url)), "utf8"),
);

const rulesOf = (pool: readonly MapDefinition[]): readonly MapLintRule[] => [
  ...new Set(poolViolations(pool).map((violation) => violation.rule)),
];

const violationsOf = (pool: readonly MapDefinition[]): readonly MapLintViolation[] =>
  poolViolations(pool);

/** 空白网格:`size` 行、每行 `size` 个平原。 */
const blankGrid = (size: number): string[] => Array.from({ length: size }, () => ".".repeat(size));

/**
 * 造一张图:点位照抄落库那张图,墙由给定的几条候选轨道决定。
 *
 * 参数类型刻意宽松(`Record<string, unknown>` / `unknown[]`)与票 03 同理由:
 * 反例必须能从「文件读进来的 JSON 值」那一侧进来,规则层才有机会证明它判得了。
 */
const withWalls = (
  name: string,
  orbitIndexes: readonly number[],
  patch: Record<string, unknown> = {},
  size: number = OPEN.size,
): MapDefinition => {
  const rows = blankGrid(size);
  for (const index of orbitIndexes) {
    for (const [x, y] of OPEN.variantSlots[index] ?? []) {
      const row = rows[y] ?? "";
      rows[y] = `${row.slice(0, x)}#${row.slice(x + 1)}`;
    }
  }
  return { ...OPEN, name, size, terrain: rows, ...patch } as MapDefinition;
};

/** 造一张图:任意一组墙格。**会破坏地形对称**,只在 Jaccard 判据的用例里用——
 *  墙格数必须是 4 的倍数才能凑出恰好 0.15 的相似度(轨道天然满足),而对称性不是本判据的事。 */
const withRawWalls = (
  name: string,
  cells: readonly (readonly [number, number])[],
): MapDefinition => {
  const rows = blankGrid(OPEN.size);
  for (const [x, y] of cells) {
    const row = rows[y] ?? "";
    rows[y] = `${row.slice(0, x)}#${row.slice(x + 1)}`;
  }
  return { ...OPEN, name, terrain: rows } as MapDefinition;
};

/**
 * 造一张图:把给定的一批格子各自展开成完整四重轨道当墙。
 *
 * **给矿路红线的反例用**:那张反例要的形状是「家与自家矿坐标上很近、中间隔一道墙」,
 * 而这个形状没法从 `variantSlots` 的候选轨道里凑出来(那 8 条实测离点位八邻域都远)。
 * 展开成轨道是为了保持地形四重对称——否则反例就同时坏了单图层,作者分不清自己踩的是哪一条。
 * 用例里都断言 `mapViolations(fixture)` 为空,所以这个承诺是被检查的,不是口头说说。
 */
const withWallOrbits = (
  name: string,
  cells: readonly (readonly [number, number])[],
  size: number = OPEN.size,
): MapDefinition => {
  const rows = blankGrid(size);
  for (const [x, y] of cells) {
    for (const [ox, oy] of orbitOf(x, y, size)) {
      const row = rows[oy] ?? "";
      rows[oy] = `${row.slice(0, ox)}#${row.slice(ox + 1)}`;
    }
  }
  return { ...OPEN, name, size, terrain: rows } as MapDefinition;
};

/** 把某个点位的坐标搬走(反例的通用手法),`null` owner 也要能搬。 */
const moveSite = (
  map: MapDefinition,
  id: number,
  x: number,
  y: number,
  patch: Record<string, unknown> = {},
): MapDefinition =>
  ({
    ...map,
    sites: map.sites.map((site) => (site.id === id ? { ...site, x, y, ...patch } : site)),
    ...patch,
  }) as MapDefinition;

/** 落库那张图里四方开局归属的那四个矿(#12–#15)。它们合起来恰好是**一条**完整四重轨道。 */
const OWNED_MINE_IDS: readonly number[] = [12, 13, 14, 15];

/**
 * 把那四个矿按给定顺序挪到另一组坐标上。**必须四个一起挪**:归属判据要求四方最近一圈的并集
 * 由完整轨道构成,只挪一个会把那条轨道拆散(`nearest-ring-not-orbit` 会报),反例就不干净了。
 */
const repointMines = (
  map: MapDefinition,
  cells: readonly (readonly [number, number])[],
): MapDefinition =>
  ({
    ...map,
    sites: map.sites.map((site) => {
      const index = OWNED_MINE_IDS.indexOf(site.id);
      const target = index < 0 ? undefined : cells[index];
      return target === undefined ? site : { ...site, x: target[0], y: target[1] };
    }),
  }) as MapDefinition;

/** 合规池:三张图、size 一致、墙两两不重叠(两两 Jaccard 0)、点位沿用真布局。 */
const POOL: readonly MapDefinition[] = [
  withWalls("pool-a", [0]),
  withWalls("pool-b", [1, 2]),
  withWalls("pool-c", [3]),
];

/** 测试侧独立算一遍墙格相似度:规则层算错时这里是第二份实现,两边对不上就红。 */
const jaccardOf = (left: MapDefinition, right: MapDefinition): number => {
  const walls = (map: MapDefinition): ReadonlySet<string> => {
    const cells = new Set<string>();
    map.terrain.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] === "#") cells.add(`${x},${y}`);
      }
    });
    return cells;
  };
  const a = walls(left);
  const b = walls(right);
  const intersection = [...a].filter((cell) => b.has(cell)).length;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
};

const poolWith = (pair: readonly [MapDefinition, MapDefinition]): readonly MapDefinition[] => [
  pair[0],
  pair[1],
  withWalls("pool-c", []),
];

// ── 合规池:零违规 ────────────────────────────────────────────────────────────

it("程序内构造的三图合规池零违规", () => {
  expect(violationsOf(POOL)).toEqual([]);
});

it("落库的布局本身满足最近一圈归属(断言的是真布局,不是玩具布局)", () => {
  // 四方各拿内圈轨道上的一个点:合起来恰好是一条完整四重轨道、数量是 4 的倍数。
  const rules = rulesOf(POOL);
  expect(rules).not.toContain("nearest-ring-mismatch");
  expect(rules).not.toContain("nearest-ring-tie");
  expect(rules).not.toContain("nearest-ring-not-orbit");
  expect(rules).not.toContain("mine-route-too-long");
});

// ── 池的成色:张数与 size ──────────────────────────────────────────────────────

it("池内 size 不一致被拒", () => {
  const odd = withWalls("pool-wide", [], {}, OPEN.size + 32);
  const rules = rulesOf([...POOL.slice(0, 2), odd]);
  expect(rules).toContain("pool-size-mismatch");
});

it("池内地图数不足下限被拒", () => {
  expect(rulesOf(POOL.slice(0, POOL_MIN_MAP_COUNT - 1))).toContain("pool-too-few-maps");
});

it("池里一张地图都没有时判失败(而不是静默通过)", () => {
  expect(rulesOf([])).toEqual(["pool-empty"]);
});

it("目录里混进非地图文件不算地图,也不让一次 lint 失败", () => {
  // `.gitkeep` / `README.md` / 编辑器残留都在真实目录里出现过,它们不该被当成地图。
  expect(poolMapFileNames([".gitkeep", "README.md", "open-clash.json", "notes.txt"])).toEqual([
    "open-clash.json",
  ]);
});

it("进池顺序按文件名升序,与调用方给的顺序无关", () => {
  // 入口喂的是 `readdirSync` 的结果,而文件系统不承诺枚举顺序。池层拿池内第一张当
  // `size` 比对的基准、并把两图名字写进 Jaccard 诊断,所以顺序不定会让同一份代码
  // 在两台机器上对同一组图给出不同文本——那条「违规序列可 diff」的承诺就废了。
  // 末尾 `sort(compareViolations)` 救不了:它排的是行,排不掉行里的名字。
  const scrambled = ["open-clash.json", ".gitkeep", "corridor-split.json", "fortress-core.json"];
  expect(poolMapFileNames(scrambled)).toEqual([
    "corridor-split.json",
    "fortress-core.json",
    "open-clash.json",
  ]);
  expect(poolMapFileNames([...scrambled].reverse())).toEqual(poolMapFileNames(scrambled));
});

// ── 最近一圈归属 ──────────────────────────────────────────────────────────────

it("把某家的最近矿判给别家被拒", () => {
  const moved = moveSite(withWalls("pool-a", [0]), 12, 6, 16, { initialOwner: 1 });
  const found = violationsOf([moved, ...POOL.slice(1)]);
  expect(found.map((violation) => violation.rule)).toContain("nearest-ring-mismatch");
  // 定位必须是地图名:池层违规同样要能定位到「是哪张图」。
  expect(found.find((violation) => violation.rule === "nearest-ring-mismatch")?.where).toBe(
    "pool-a",
  );
});

it("等距并列判失败,而不是替作者挑一个(等距反例)", () => {
  // 给座位 0 补一个资源点 (10,4):它到家 (10,10) 的 Chebyshev 距离是 6,
  // 与它现有的最近矿 #12 (6,16) 同为 6 —— 「最近一圈」于是不唯一。
  const base = withWalls("pool-a", [0]);
  const tied: MapDefinition = {
    ...base,
    sites: [...base.sites, { id: 90, kind: "resource", x: 10, y: 4, initialOwner: null }],
  } as MapDefinition;
  const found = violationsOf([tied, ...POOL.slice(1)]);
  expect(found.map((violation) => violation.rule)).toContain("nearest-ring-tie");
  expect(found.filter((violation) => violation.rule === "nearest-ring-tie")[0]?.message).toContain(
    "并列",
  );
});

it("归属集合不是完整四重轨道被拒(四方对等那条不变量)", () => {
  // 只把 #13 从 (47,6) 挪到 (50,6):对座位 1 而言它仍是自己最近的一个资源点(4 格),
  // 所以「归属 == 最近一圈」仍成立;但四方最近一圈的并集不再在旋转下自洽 —— 这条判据专治这一处。
  const moved = moveSite(withWalls("pool-a", [0]), 13, 50, 6);
  const found = violationsOf([moved, ...POOL.slice(1)]);
  // 只有这一条:并发(归属/矿路)都没坏,坏的是「四方对等」。
  expect([...new Set(found.map((violation) => violation.rule))]).toEqual([
    "nearest-ring-not-orbit",
  ]);
});

// ── 矿路红线 ──────────────────────────────────────────────────────────────────
//
// 这里的 d 一律指**八向最短路**(墙不可通行)。边界那两条的矿路上恰好没有墙,所以路长 = 坐标差,
// 它们仍钉在同一条线上;真正区分「理论距离」与「路长」的是下面两张反例。

it(`矿路 d = ${MAX_MINE_ROUTE} 必过`, () => {
  // 把 #12 挪到家正下方 MAX 格:这是边界内侧,依据是枯竭 599 仍在 400–600 窗口内。
  const stretched = moveSite(withWalls("pool-a", [0]), 12, 10, 10 + MAX_MINE_ROUTE);
  expect(rulesOf([stretched, ...POOL.slice(1)])).not.toContain("mine-route-too-long");
});

it(`矿路 d = ${MAX_MINE_ROUTE + 1} 必被拒`, () => {
  // 再往下挪一格就是 629,顶破 600 的窗口上界。
  const stretched = moveSite(withWalls("pool-a", [0]), 12, 10, 11 + MAX_MINE_ROUTE);
  const found = violationsOf([stretched, ...POOL.slice(1)]);
  expect(found.map((violation) => violation.rule)).toContain("mine-route-too-long");
  // 这一张的矿路上没有墙,所以路长 = 坐标差;文案不得反过来声称“是墙把路拉长的”——
  // 那是作者照着改图时会跟着跑偏的一句话。
  expect(found.find((violation) => violation.rule === "mine-route-too-long")?.message).toContain(
    "两点之间没有墙挡路",
  );
});

it("反例:坐标上很近、但被墙隔开绕路超红线,必被拒(这条判据存在的理由)", () => {
  // 形状:x=7 上一道从 y=6 拉到 y=20 的墙(连同它的旋转伙伴),把家 (10,10) 与自家矿 #12 (6,16)
  // 隔在两侧。直线距离只有 6 格,红线以下的旧判据(理论距离)会**放行**这张图;而家必须绕过墙头
  // (或墙尾)才走得到矿,八向最短路是 MAX+6 格。
  const barrier: readonly (readonly [number, number])[] = Array.from(
    { length: 15 },
    (_, index) => [7, 6 + index] as const,
  );
  const walled = withWallOrbits("pool-a", barrier);
  // 反例本身得是一张**合法的图**:它只坏了池层那条红线,不能顺手坏了单图层。
  expect(mapViolations(walled)).toEqual([]);

  const found = violationsOf([walled, ...POOL.slice(1)]);
  expect([...new Set(found.map((violation) => violation.rule))]).toEqual(["mine-route-too-long"]);
  const message =
    found.find((violation) => violation.rule === "mine-route-too-long")?.message ?? "";
  // 文案里两个数都在:量的是路长(16 格),理由写明坐标差只有 6 格。
  // 6 < 红线 10,所以旧判据(理论距离)会放行这张图——这条用例钉住的就是那个差别。
  expect(message).toContain("要走 16 格");
  expect(message).toContain("两点只隔 6 格");
  // 四方对称,所以这张图上四方的矿路都被拉长;一张图坏在同一个地方,诊断文本也就一样。
  expect(found).toHaveLength(4);
});

it("反例:坐标差按曼哈顿算是 12(已越过红线)、但一条直路就走得到,不被这条红线误伤", () => {
  // 把四方归属的四个矿整体挪到对角线那条轨道上:(16,16)/(47,16)/(47,47)/(16,47)。
  // 每方到自家矿的 Chebyshev 与八向路长都是 6(红线以内),而按曼哈顿算是 12 —— 已经越过红线 10。
  // 红线量的是**走过去要走多少格**,不是两点离多远;把它读成曼哈顿/欧氏距离就会误伤这张图。
  const diagonal = repointMines(withWalls("pool-a", [0]), orbitOf(16, 16, OPEN.size));
  expect(mapViolations(diagonal)).toEqual([]);
  expect(violationsOf([diagonal, ...POOL.slice(1)])).toEqual([]);
});

it("反例:墙把自家矿围死(走不到),报「没有可走的路」而不是当成路长", () => {
  // 在 #12 (6,16) 四周套一整圈墙:理论距离仍是 6,但八向 BFS 到不了。
  // 走不通比走太远更糟,所以它归同一条判据,文案必须与「太长」那个读法分得开。
  const ring: readonly (readonly [number, number])[] = [
    [5, 15],
    [7, 15],
    [5, 16],
    [7, 16],
    [5, 17],
    [7, 17],
    [6, 15],
    [6, 17],
  ];
  const sealed = withWallOrbits("pool-a", ring);
  expect(mapViolations(sealed)).toEqual([]);
  const found = violationsOf([sealed, ...POOL.slice(1)]);
  expect([...new Set(found.map((violation) => violation.rule))]).toEqual(["mine-route-too-long"]);
  expect(found[0]?.message).toContain("没有可走的路");
});

// ── 风格判据:两两 Jaccard ─────────────────────────────────────────────────────

it("两两 Jaccard 为 0 的合规池通过", () => {
  expect(jaccardOf(POOL[0] as MapDefinition, POOL[1] as MapDefinition)).toBe(0);
  expect(violationsOf(POOL)).toEqual([]);
});

it("负对照:「同结构挪几格」那一档必被 0.15 挡住(0.2 那条线会放过它)", () => {
  // a 只有第 0 条轨道,b 是「同一条轨道 + 另外 5 条」:交集 4 格、并集 24 格 → J ≈ 0.167。
  // 这个数落在原型量到的缝里(真图 0.025 ↔ 最小结构共享 0.195),正是阈值从 0.2 收到 0.15 的理由。
  const a = withWalls("a", [0]);
  const b = withWalls("b", [0, 1, 2, 3, 4]);
  const similarity = jaccardOf(a, b);
  expect(similarity).toBeGreaterThan(MAX_WALL_JACCARD);
  expect(similarity).toBeLessThanOrEqual(0.2);
  const found = violationsOf(poolWith([a, b]));
  expect(found.map((violation) => violation.where)).toContain("a ↔ b");
  expect(found.map((violation) => violation.rule)).toContain("wall-jaccard-too-high");
});

it("负对照:同风格只加密度(原型实测 0.509 那一档)必被挡住", () => {
  const a = withWalls("a", [0]);
  const b = withWalls("b", [0, 1]);
  expect(jaccardOf(a, b)).toBeGreaterThanOrEqual(0.5);
  expect(rulesOf(poolWith([a, b]))).toContain("wall-jaccard-too-high");
});

it("两图地形完全相同判失败(相似度取 1,不是「无法判定」)", () => {
  const a = withWalls("a", [0]);
  const b = withWalls("b", [0]);
  expect(rulesOf([a, b, withWalls("pool-c", [])])).toContain("wall-jaccard-too-high");
});

it("相似度恰好等于上限时放行(判据是上界,不是严格小于)", () => {
  // 交集 3 / 并集 20 = 0.15。整数除法正确舍入,0.15 的字面量与 3/20 是同一个双精度数,
  // 所以比较不需要 epsilon;这条用例把「等于阈值」那一格钉住。
  const shared: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [2, 0],
  ];
  const extra: readonly (readonly [number, number])[] = Array.from(
    { length: 17 },
    (_, index) => [3 + index, 1] as const,
  );
  const a = withRawWalls("a", shared);
  const b = withRawWalls("b", [...shared, ...extra]);
  expect(jaccardOf(a, b)).toBe(MAX_WALL_JACCARD);
  expect(rulesOf(poolWith([a, b]))).not.toContain("wall-jaccard-too-high");
});

it("风格由地形判:自报一个 style 标签的地图在装载期就被拒(七字段契约不动)", () => {
  const result = validateMap({ ...OPEN, style: "open" } as never);
  expect(result.ok).toBe(false);
});

// ── 两层输出:池层与单图层的诊断要分得开 ─────────────────────────────────────

it("池层渲染的抬头说「地图池」,且每行标出是哪一层", () => {
  const broken = moveSite(withWalls("pool-a", [0]), 12, 6, 16, { initialOwner: 1 });
  const text = renderPoolViolations(violationsOf([broken, ...POOL.slice(1)]));
  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toContain("地图池校验未通过");
  expect(text).toContain("[池级]");
});

it("零违规的池渲染成「通过」那一句", () => {
  expect(renderPoolViolations([])).toBe("地图池校验通过:没有违规。\n");
});

it("池层违规的文本里不出现内部记号", () => {
  const broken = moveSite(withWalls("pool-a", [0]), 12, 6, 16, { initialOwner: 1 });
  const text = renderPoolViolations(violationsOf([broken, ...POOL.slice(1)]));
  expect(text).not.toContain("nearest-ring-mismatch");
});

// ── 违规序列的顺序是契约(两轮结果要能 diff) ─────────────────────────────────

it("同一个池两次判定给出同一组违规(顺序也一样)", () => {
  const broken = moveSite(withWalls("pool-a", [0]), 12, 6, 16, { initialOwner: 1 });
  const pool = [broken, ...POOL.slice(1)];
  expect(violationsOf(pool)).toEqual(violationsOf(pool));
});
