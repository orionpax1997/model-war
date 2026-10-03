/**
 * 地图池的**纯规则层**:一个地图池 → 一组带定位的违规。**不碰文件系统、不读时钟、不设退出码**。
 *
 * ── 为什么这一层单列一个文件 ──────────────────────────────────────────────────
 * `rules.ts` 判的是「一张地图自己跟自己比」的那些东西。本文件判的是**单图结构上判不了**的那些:
 * 池内 `size` 是否一致、地图数是否够、最近一圈资源点的归属、矿路红线、墙体的两两相似度。
 * 分界的理由与 `rules.ts` 的文件头同源:**判据按「一条输入能不能提供全部事实」分**,
 * 于是每一层的测试都能自己构造反例,不必先造一个文件系统或一个真实地图池。
 *
 * ── 「一个形状都不自己存」 ────────────────────────────────────────────────────
 * 字段有没有、类型对不对、坐标是不是非负整数——那些归 `MAP_JSON_SCHEMA`,本层假定调用方
 * 已经过了 `validateMap`。本层只判 JSON Schema 表达不了的跨图语义:距离比较、集合相等、相似度。
 *
 * ── 距离:两处都用 Chebyshev 理论距离,一个「绕墙」的字都没有 ──────────────────
 * gdd §4 已经把 Chebyshev 定为移动度量(八向移动,对角与直行等价),所以「最近」是同一件事的
 * 同一把尺。**理论距离 = 直接算坐标差,不是网格最短路**:一条矿路绕不绕墙在这里根本不是问题。
 *
 * 为什么对点位不变量尤其不能改成路径距离:改一堵墙就可能改掉某家的开局矿归属,于是
 * 「迭代这张图」变成「每加一堵墙重验四条归属」的排雷。理论距离下点位与墙是两个正交的设计维度。
 * 代价记在这里,让日后想换度量的人先看见当初量到了什么:原型阶段三张真图的矿路拉伸比是
 * 1.000(路径距离 = 理论距离 = 6),所以**真图上两种读法结论完全一致**,分歧只在
 * 「刻意把矿路绕远」的图上才出现。
 *
 * ── 三个阈值都是具名常量,依据写在这里 ─────────────────────────────────────────
 * 它们是**校验器这一侧的判据**,不是地图数据、也不是规则集的键(hld §7.2 的七字段契约不动)。
 * 依据来自原型阶段的实测,原文在 `.scratch/map-pool/proto/metrics.txt` 与 `findings.md`,
 * 「让日后想改阈值的人先看见当初量到了什么」是它们不写进文档、而写在代码里的理由。
 */

import type { MapDefinition, MapSite } from "@model-war/schema";

import { compareViolations, orbitOf, type MapLintViolation } from "./rules.js";

/**
 * 池内地图数下限。gdd §4 把地图池的三种风格定为下限 3 张;下界是「风格各异」这条要求能
 * 成立的最小规模(两张图只能给出一个差值,谈不上一池三态)。
 */
export const POOL_MIN_MAP_COUNT = 3;

/**
 * 矿路红线的上界(格)。依据是采集往返 `2d + 20` 的线性放大实测:
 * `d=6` → 枯竭 479、`d=8` → 539、`d=10` → 599、**`d=11` → 629 顶破 600**
 * (400–600 是规则给枯竭时点定的窗口,原型基线 479 落在窗口内)。
 * 所以「家门到自家矿那一小片不许被墙拉过 10 格」是命题① 的真正设计约束,不是风格偏好。
 */
export const MAX_MINE_ROUTE_CHEBYSHEV = 10;

/**
 * 两图墙格集合的 Jaccard 相似度上限。判据是 `|A∩B| / |A∪B|`,A、B 是两张图的墙格集合。
 *
 * 依据是原型阶段量的那道缝:三张真图两两为 0.0000 / 0.0200 / 0.0247;而「同风格只把外环挪
 * 1 格」这个**最像真实手误**的探针是 0.195,「同风格只加密度」是 0.509。0.2 那条线落在
 * 0.025 ↔ 0.195 这道缝的外侧,会放过前者;0.15 对真图留 6 倍余量,仍把最小结构共享探针挡在门外。
 * 不放宽:放宽没有证据支持,只会让这条断言在第一次压力下退化成摆设。
 */
export const MAX_WALL_JACCARD = 0.15;

/**
 * 一个目录里哪些文件名算地图,**按文件名升序**。
 *
 * **只按后缀认,不猜内容**:`*.json` 是地图的落库形状,其余一律跳过(`.gitkeep`、`README.md`、
 * 编辑器留下的 `.DS_Store` 都不该让一次 lint 失败)。而「这个 `.json` 是不是一张形状合规的地图」
 * 不在本层——它归 `validateMap`,那一件事已经有一个家了。
 *
 * ── 为什么在这里排升序(而不是在入口) ────────────────────────────────────────
 * 入口喂进来的是 `readdirSync` 的结果,而**文件系统不承诺目录项的枚举顺序**(同一份
 * `maps/` 在 ext4 / APFS / NTFS 上顺序可以不同)。池层判据认它:
 * `poolCompositionViolations` 拿池内**第一张**当 `size` 比对的基准,
 * `wallJaccardViolations` 按下标成对遍历并把两图名字写进诊断文案。
 * 不排序的话,「基准是谁」「A ↔ B 还是 B ↔ A」就随建目录的文件系统而变——
 * 同一份代码在两台机器上对同一组图给出不同的诊断文本,而违规序列的「可 diff」承诺就废了。
 * 末尾那道 `sort(compareViolations)` 救不了:它只排**行**,排不掉**行里的名字**。
 *
 * 排序放在本层而不是入口,是因为「哪些文件、按什么顺序进池」本身就是池的读法,
 * 它得在纯函数里(测试直接构造 `fileNames` 数组就能钉住),而入口只负责 `readdirSync`。
 *
 * 跳过之后池里一张都没有,交给 `poolViolations([])` 判失败(而不是静默通过):
 * 「没找到地图」与「地图都合规」在退出码上必须分得开。
 */
export const poolMapFileNames = (fileNames: readonly string[]): readonly string[] =>
  fileNames
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));

/** Chebyshev 距离(理论距离:直接算坐标差,与墙无关)。 */
const chebyshev = (ax: number, ay: number, bx: number, by: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

const cellKey = (x: number, y: number): string => `${x},${y}`;

const isInside = (x: number, y: number, size: number): boolean =>
  x >= 0 && y >= 0 && x < size && y < size;

/**
 * 越界的点位在这里**跳过**,与 `rules.ts` 的对称性判据同一条理由:
 * 越界已经由 `site-out-of-bounds` 报过,池层再报一次是同一个错法的两条诊断。
 * 而且越界坐标的旋转伙伴必然也不在集合里,留着它会让「归属集合是不是完整轨道」凭空多报一条。
 */
const inBoundsOf = (map: MapDefinition, sites: readonly MapSite[]): readonly MapSite[] =>
  sites.filter((site) => isInside(site.x, site.y, map.size));

const ownedResourcesOf = (map: MapDefinition, owner: number): readonly MapSite[] =>
  inBoundsOf(
    map,
    map.sites.filter((site) => site.kind === "resource" && site.initialOwner === owner),
  );

const idsOf = (sites: readonly MapSite[]): string =>
  sites.length === 0 ? "无" : sites.map((site) => `#${site.id}`).join("、");

// ── 池的成色:张数与 size ──────────────────────────────────────────────────────

const poolCompositionViolations = (maps: readonly MapDefinition[]): readonly MapLintViolation[] => {
  if (maps.length === 0) {
    return [
      {
        scope: "pool",
        rule: "pool-empty",
        message: "地图池里一张地图也没有:目录里找不到任何 *.json 地图文件。",
        where: null,
      },
    ];
  }
  if (maps.length < POOL_MIN_MAP_COUNT) {
    return [
      {
        scope: "pool",
        rule: "pool-too-few-maps",
        message:
          `地图池只有 ${maps.length} 张,规则要求至少 ${POOL_MIN_MAP_COUNT} 张;` +
          "风格各异这条要求在两三张图上不成立。",
        where: null,
      },
    ];
  }
  // 与第一张比:文件名已由 `poolMapFileNames` 排过序,所以「基准是谁」与遍历顺序无关(可 diff)。
  const reference = maps[0];
  const found: MapLintViolation[] = [];
  for (const map of maps.slice(1)) {
    if (map.size === reference?.size) continue;
    found.push({
      scope: "pool",
      rule: "pool-size-mismatch",
      message:
        `地图 ${map.name} 的 size 是 ${map.size},池内第一张 ${reference?.name ?? "?"} 是 ` +
        `${reference?.size ?? "?"};池内 size 必须一致——它锁死引擎对整池的地图假设。`,
      where: map.name,
    });
  }
  return found;
};

// ── 最近一圈资源点的归属 ──────────────────────────────────────────────────────

/** 候选集里离 `home` 最近的那一个,连同它与距离。候选集非空才调用(调用点已经判过)。 */
const nearestTo = (
  candidates: readonly MapSite[],
  home: MapSite,
): readonly [number, number, number] => {
  let best = candidates[0] as MapSite;
  let bestDistance = chebyshev(home.x, home.y, best.x, best.y);
  for (const site of candidates) {
    const d = chebyshev(home.x, home.y, site.x, site.y);
    if (d >= bestDistance) continue;
    best = site;
    bestDistance = d;
  }
  return [best.x, best.y, bestDistance];
};

/** 资源点非空才调用(调用点已经判过)。 */
const nearestRingOf = (
  resources: readonly MapSite[],
  home: MapSite,
): readonly { readonly site: MapSite; readonly d: number }[] => {
  const dMin = nearestTo(resources, home)[2] ?? 0;
  return resources
    .map((site) => ({ site, d: chebyshev(home.x, home.y, site.x, site.y) }))
    .filter((entry) => entry.d === dMin);
};

/**
 * 每方开局归属的资源点**恰好**等于它家最近的那一圈;并列即失败。
 *
 * ── 「那组点构成完整四重轨道」的读法(这一处最容易读错,故写全) ────────────────
 * 判据分两层,第一层逐方、第二层跨四方:
 * 1. 逐方:`initialOwner` 指向该方的资源点集合 == 距离等于 `d_min` 的那组点(且无并列);
 * 2. 跨四方:**四方各自的最近一圈合起来**必须由完整的四重轨道构成,数量是 4 的倍数。
 *
 * 为什么轨道那一条只能落在第二层:落库的 `open-clash` 里,内圈高危矿(四点同一条轨道)是
 * **每方各拿一个**——每方最近一圈是 1 个点。「每方自己那组点是完整轨道」在它上面恒为假,
 * 于是那条判据会把这张图判失败,而它正是本仓唯一的合规图。所以轨道这条不变量的真正内容是
 * FR-1 的**四方对等**:归属集合在旋转下必须自洽,而旋转把座位 0 的矿映成座位 1 的矿,
 * 因此「四方最近一圈的并集 = 若干条完整轨道」才是可判、也该判的那一句。
 */
const nearestRingViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const found: MapLintViolation[] = [];
  const resources = inBoundsOf(
    map,
    map.sites.filter((site) => site.kind === "resource"),
  );
  if (resources.length === 0) return found;

  const homes = inBoundsOf(
    map,
    map.sites.filter((site) => site.kind === "base" && site.initialOwner !== null),
  );

  /** 四方最近一圈的并集(跨四方那条轨道判据的原料)。 */
  const union = new Set<string>();

  for (const home of homes) {
    const owner = home.initialOwner;
    if (owner === null) continue;
    const ringEntries = nearestRingOf(resources, home);
    const ring = ringEntries.map((entry) => entry.site);
    const dMin = ringEntries[0]?.d ?? 0;
    const owned = ownedResourcesOf(map, owner);

    if (ring.length > 1) {
      // 并列不选一个:任何自动 tie-break 都会把一个设计歧义悄悄定死。
      found.push({
        scope: "pool",
        rule: "nearest-ring-tie",
        message:
          `座位 ${owner} 的主基地 (${home.x},${home.y}) 到 ${ring.length} 个资源点同为 ${dMin} 格` +
          `(${idsOf(ring)}):「最近一圈」不唯一,请把其中几个挪远或撤掉;并列一律判失败,` +
          "校验器不会替你挑一个。",
        where: map.name,
      });
    }

    const ownedKeys = new Set(owned.map((site) => cellKey(site.x, site.y)));
    const ringKeys = new Set(ring.map((site) => cellKey(site.x, site.y)));
    const sameSet =
      ownedKeys.size === ringKeys.size && [...ringKeys].every((cell) => ownedKeys.has(cell));
    if (!sameSet) {
      found.push({
        scope: "pool",
        rule: "nearest-ring-mismatch",
        message:
          `座位 ${owner} 的主基地 (${home.x},${home.y}) 最近的一圈资源点是 ${idsOf(ring)}` +
          `(d=${dMin}),而它开局归属的是 ${idsOf(owned)};归属集合必须**恰好**等于最近的那一圈。`,
        where: map.name,
      });
    }

    for (const site of ring) union.add(cellKey(site.x, site.y));
  }

  // 跨四方:并集由完整四重轨道构成,数量是 4 的倍数(偶数边长下每条轨道恒为 4 格)。
  if (union.size > 0 && union.size % 4 !== 0) {
    found.push({
      scope: "pool",
      rule: "nearest-ring-not-orbit",
      message:
        `地图 ${map.name} 的四方开局归属资源点合起来是 ${union.size} 个,不是 4 的倍数;` +
        "归属集合必须由完整的四重轨道组成,否则四方初始条件不再对等。",
      where: map.name,
    });
  }
  for (const cell of union) {
    const [x = 0, y = 0] = cell.split(",").map(Number);
    const complete = orbitOf(x, y, map.size).every(([ox, oy]) => union.has(cellKey(ox, oy)));
    if (complete) continue;
    found.push({
      scope: "pool",
      rule: "nearest-ring-not-orbit",
      message:
        `地图 ${map.name} 的归属资源点 (${cell}) 的旋转伙伴不在归属集合里;` +
        "归属集合必须由完整的四重轨道组成,否则四方初始条件不再对等。",
      where: map.name,
    });
  }

  return found;
};

/** 家到最近自家资源点的那个资源点与它的距离(`d_min`)。候选集非空才调用。 */

// ── 矿路红线 ──────────────────────────────────────────────────────────────────

/**
 * 家 → 最近**自家**资源点的距离不得超过红线。判据是 Chebyshev 理论距离(与最近一圈同一把尺)。
 *
 * 为什么与「最近一圈」看起来重复却仍要单列一条:最近一圈判的是**声明**与**最近**是否一致,
 * 红线判的是**一致之后那个数本身有多大**。一张归属写错(把自家矿判给别家)的图,最近一圈那条
 * 会先报它;而一条只写「d ≤ 10」的红线永远看得见经济后果。两者的差别在反例里才显形:
 * 把某家的最近矿判给别家,归属那家的矿路立刻变成半张地图那么长。
 */
const mineRouteViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const found: MapLintViolation[] = [];
  const homes = inBoundsOf(
    map,
    map.sites.filter((site) => site.kind === "base" && site.initialOwner !== null),
  );
  for (const home of homes) {
    const owner = home.initialOwner;
    if (owner === null) continue;
    const owned = ownedResourcesOf(map, owner);
    // 一条自家矿都没有的图由 `nearest-ring-mismatch` 报(归属集合空 ≠ 最近一圈非空),
    // 这里不重复报一条「矿路无穷远」:那不是作者能照着改的建议。
    if (owned.length === 0) continue;
    const [mx, my, d] = nearestTo(owned, home);
    if (d <= MAX_MINE_ROUTE_CHEBYSHEV) continue;
    found.push({
      scope: "pool",
      rule: "mine-route-too-long",
      message:
        `座位 ${owner} 的家 (${home.x},${home.y}) 到最近自家资源点 (${mx},${my}) 有 ${d} 格,` +
        `超过红线 ${MAX_MINE_ROUTE_CHEBYSHEV};依据是采集往返 2d+20 的线性实测` +
        "(d=10 → 枯竭 599,d=11 → 629 顶破 600 的窗口)。家门到自家矿那一小片必须留空。",
      where: map.name,
    });
  }
  return found;
};

// ── 风格判据:两两 Jaccard ─────────────────────────────────────────────────────

const wallCellsOf = (map: MapDefinition): ReadonlySet<string> => {
  const cells = new Set<string>();
  map.terrain.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === "#") cells.add(cellKey(x, y));
    }
  });
  return cells;
};

/**
 * 两图的墙格相似度。**并集为空时取 1**(两张图都没墙,地形一模一样):
 * 0/0 不是「无法判定」,而是「完全相同」——而地图池要的是风格各异,不是无法判定。
 */
const wallJaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  let intersection = 0;
  for (const cell of left) {
    if (right.has(cell)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
};

const wallJaccardViolations = (maps: readonly MapDefinition[]): readonly MapLintViolation[] => {
  const found: MapLintViolation[] = [];
  const cells = maps.map(wallCellsOf);
  for (let i = 0; i < maps.length; i += 1) {
    for (let j = i + 1; j < maps.length; j += 1) {
      const left = cells[i] as ReadonlySet<string>;
      const right = cells[j] as ReadonlySet<string>;
      const similarity = wallJaccard(left, right);
      // 浮点比较在这里是精确的:阈值 0.15 与任意「恰好等于 0.15」的比值(如 3/20)在 IEEE-754
      // 下是同一个双精度数——整数除法正确舍入,字面量取的是同一个最近数。判据写成 `<=`,
      // 与票面的「上限 0.15」同向;真图离阈值有 6 倍余量,这条精度只在比值恰等于阈值时才被碰到。
      if (similarity <= MAX_WALL_JACCARD) continue;
      found.push({
        scope: "pool",
        rule: "wall-jaccard-too-high",
        message:
          `${maps[i]?.name ?? "?"} 与 ${maps[j]?.name ?? "?"} 的墙格相似度 ` +
          `J=${similarity.toFixed(4)},超过上限 ${MAX_WALL_JACCARD};风格由地形判、不自报标签,` +
          "复制一张图微调几格后交付正是这条要挡的(原型实测那种探针是 0.195)。",
        where: `${maps[i]?.name ?? "?"} ↔ ${maps[j]?.name ?? "?"}`,
      });
    }
  }
  return found;
};

/**
 * 一个地图池 → 一组带定位的违规。**空数组 = 合规**。
 *
 * 池层判据只产出 `scope: "pool"` 的违规;单图判据(`rules.ts`)由入口对每张图各跑一遍再合并,
 * 这样「这张图画错了」与「这组图凑不齐」在诊断里始终分得开。
 *
 * 排序与 `mapViolations` 同理:违规序列是契约,两轮 lint 的结果要能 diff 出来。
 */
export const poolViolations = (maps: readonly MapDefinition[]): readonly MapLintViolation[] =>
  [
    ...poolCompositionViolations(maps),
    ...maps.flatMap(nearestRingViolations),
    ...maps.flatMap(mineRouteViolations),
    ...wallJaccardViolations(maps),
  ].sort(compareViolations);
