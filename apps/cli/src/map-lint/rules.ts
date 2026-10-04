/**
 * 地图校验的**纯规则层**:一份地图数据 → 一组带定位的违规。**不碰文件系统、不读时钟、不设退出码**。
 *
 * ── 为什么是纯函数 ───────────────────────────────────────────────────────────
 * 分界与 `validateRuleset` 那条一样(见 `validator.ts`):**本文件只判,不取**。
 * 读目录、读文件名、设退出码是入口那层薄壳(`index.ts`)的活。理由是断言对象:
 * 「一段地图数据 → 一组违规」可以直接在测试里构造任意反例,不必先造一个文件系统;
 * 而目录遍历薄壳不重复实现规则,沿用仓库既有先例(禁浮点门禁 / 声明依赖门禁)。
 *
 * ── 本层判什么、不判什么 ────────────────────────────────────────────────────
 * 判的是**单张地图自己跟自己比**的那些东西:四重旋转对称(terrain 与 sites 各一条独立断言)、
 * 点位不压不重不越界、变体槽位是不是真轨道、槽位压没压住点位与已有的墙。
 * 判不了、也不该在这里判的是:
 * - 形状层(`MAP_JSON_SCHEMA` 管的那部分:字段有没有、类型对不对、字符集)。本层假定调用方
 *   已经过了 `validateMap`,所以 terrain 只判行数与行长——字符集归 schema,再判一次就是第二真源;
 * - **池级**判据(`size` 一致、地图数量下限、最近一圈归属、矿路红线、Jaccard 风格判据),
 *   它们跨图,单图判不了,在同目录的 `pool.ts` 里。
 *
 * ── 一条纪律:位置必须能定位 ──────────────────────────────────────────────────
 * 每条违规都带出「哪个字段、哪一格」。一张 64×64 的图有 4096 格,不定位的违规等于让人回去肉眼数格。
 */

import type { MapDefinition, MapVariantSlot } from "@model-war/schema";

/** 违规类别。`map` 层的类别名同时是机器层 diff 的兜底键,不进面向作者的文本。 */
export type MapLintRule =
  // ── `map` 层:一张地图自己跟自己比 ───────────────────────────────────────────
  /** terrain 绕中心 90° 旋转后与自身逐格不同。 */
  | "terrain-symmetry"
  /** 点位集合绕中心 90° 旋转后与自身不同。 */
  | "sites-symmetry"
  /** 两个点位落在同一格。 */
  | "site-overlap"
  /** 点位压在墙上。 */
  | "site-on-wall"
  /** 点位坐标越出 `size` 范围。 */
  | "site-out-of-bounds"
  /** terrain 的行数或行长不等于 `size`。 */
  | "terrain-shape"
  /** 变体槽位不是一条完整四重轨道。 */
  | "variant-slot-not-orbit"
  /** 变体槽位压住点位格或它的八邻域。 */
  | "variant-slot-on-site"
  /** 变体槽位覆盖初始单位落点。 */
  | "variant-slot-on-spawn"
  /** 变体槽位与地形里**已有的**墙格重叠。 */
  | "variant-slot-on-wall"
  // ── `pool` 层:跨图判据,单张地图判不了(见 `pool.ts`)────────────────────────
  /** 池里一张地图也没有(目录里找不到任何地图文件)。 */
  | "pool-empty"
  /** 池内地图数不足下限。 */
  | "pool-too-few-maps"
  /** 池内 `size` 不一致。 */
  | "pool-size-mismatch"
  /** 某方主基地到不止一个资源点距离相同,「最近一圈」不唯一。 */
  | "nearest-ring-tie"
  /** 某方开局归属的资源点集合不等于它的最近一圈。 */
  | "nearest-ring-mismatch"
  /** 四方开局归属的资源点合起来不构成完整的四重轨道(或数量不是 4 的倍数)。 */
  | "nearest-ring-not-orbit"
  /** 某方家到最近自家资源点的距离超过红线。 */
  | "mine-route-too-long"
  /** 池内两张图的墙格集合相似度超过上限。 */
  | "wall-jaccard-too-high";

/**
 * 一条违规。`scope` 区分「这张图画错了」与「这组图凑不齐」——两种失效模式的读法不同,
 * 诊断文案也该分开(`pool.ts` 产出的那条 `scope` 是 `pool`)。
 */
export type MapLintViolation = {
  readonly scope: "map" | "pool";
  readonly rule: MapLintRule;
  /** 面向地图作者的一句话:哪里错了、改什么。 */
  readonly message: string;
  /** 定位:`(x,y)` / `terrain[12]` 这类坐标或下标;池层违规给地图名或两图名。 */
  readonly where: string | null;
};

/**
 * 四重旋转:`(x, y)` 绕中心 90°。与桩、生成器同一条 `rot` 行,换一条就换一套地图。
 *
 * 导出是因为池层判据(最近一圈归属要判「归属集合是不是完整轨道」)必须用**同一条**旋转:
 * 两层各抄一份旋转,它们就会在某次改动后悄悄分叉,而分叉的表象是一张对称的图被判成不对称。
 */
export const rotate = (x: number, y: number, size: number): readonly [number, number] => [
  size - 1 - y,
  x,
];

/** 从一格出发的那条完整四重轨道(4 格,依次是 0/1/2/3 次旋转)。导出理由同上。 */
export const orbitOf = (
  x: number,
  y: number,
  size: number,
): readonly (readonly [number, number])[] => {
  const cells: [number, number][] = [];
  let cursor: readonly [number, number] = [x, y];
  for (let turn = 0; turn < 4; turn += 1) {
    cells.push([cursor[0], cursor[1]]);
    cursor = rotate(cursor[0], cursor[1], size);
  }
  return cells;
};

const key = (x: number, y: number): string => `${x},${y}`;

const isInside = (x: number, y: number, size: number): boolean =>
  x >= 0 && y >= 0 && x < size && y < size;

/**
 * terrain 行数与行长必须等于 `size`。字符集归 `MAP_JSON_SCHEMA`,这里不重复判——
 * 再判一次就是第二真源,而本层假定调用方已经过了 `validateMap`。
 */
const terrainShapeViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const found: MapLintViolation[] = [];
  if (map.terrain.length !== map.size) {
    found.push({
      scope: "map",
      rule: "terrain-shape",
      message: `terrain 有 ${map.terrain.length} 行,size 是 ${map.size};两者必须相等。`,
      where: "terrain",
    });
  }
  for (const [index, row] of map.terrain.entries()) {
    if (row.length !== map.size) {
      found.push({
        scope: "map",
        rule: "terrain-shape",
        message: `terrain 第 ${index} 行有 ${row.length} 个字符,size 是 ${map.size};两者必须相等。`,
        where: `terrain[${index}]`,
      });
    }
  }
  return found;
};

/** terrain 绕中心 90° 旋转后与自身逐格相同。 */
const terrainSymmetryViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const size = map.size;
  const found: MapLintViolation[] = [];
  const wallAt = (x: number, y: number): string | undefined =>
    isInside(x, y, size) ? map.terrain[y]?.[x] : undefined;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [rx, ry] = rotate(x, y, size);
      if (wallAt(x, y) !== wallAt(rx, ry)) {
        found.push({
          scope: "map",
          rule: "terrain-symmetry",
          message: `(${x},${y}) 与它旋转 90° 得到的 (${rx},${ry}) 不是同一地形;地形须四重旋转对称。`,
          where: `terrain[${y}][${x}]`,
        });
      }
    }
  }
  return found;
};

/**
 * 点位集合绕中心 90° 旋转后与自身相同。判据是**坐标集合**,不是编号。
 *
 * 越界的点位在这里**跳过**:它已经由「点位越界」那条报过了,再报一次对称性是同一个错法的
 * 两条诊断,而作者不知道该先看哪条(而且旋转一个越界坐标得到的格子必然也不在集合里,
 * 于是每个越界点位会凭空多出一条对称性违规)。
 */
const siteSymmetryViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const size = map.size;
  const found: MapLintViolation[] = [];
  const present = new Set(map.sites.map((site) => key(site.x, site.y)));
  for (const site of map.sites) {
    if (!isInside(site.x, site.y, size)) continue;
    const [rx, ry] = rotate(site.x, site.y, size);
    if (!present.has(key(rx, ry))) {
      found.push({
        scope: "map",
        rule: "sites-symmetry",
        message: `点位 #${site.id} 在 (${site.x},${site.y}),它旋转 90° 得到的 (${rx},${ry}) 上没有点位;点位须四重旋转对称。`,
        where: `sites[${site.id}]`,
      });
    }
  }
  return found;
};

const sitePlacementViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const found: MapLintViolation[] = [];
  const seen = new Map<string, number>();
  for (const site of map.sites) {
    const cell = key(site.x, site.y);
    const rival = seen.get(cell);
    if (rival !== undefined) {
      found.push({
        scope: "map",
        rule: "site-overlap",
        message: `点位 #${site.id} 与点位 #${rival} 落在同一格 (${cell});一个格子最多一个点位。`,
        where: `sites[${site.id}]`,
      });
    } else {
      seen.set(cell, site.id);
    }
    if (!isInside(site.x, site.y, map.size)) {
      found.push({
        scope: "map",
        rule: "site-out-of-bounds",
        message: `点位 #${site.id} 在 (${site.x},${site.y}),越出 size=${map.size} 的网格。`,
        where: `sites[${site.id}]`,
      });
      continue;
    }
    if (map.terrain[site.y]?.[site.x] === "#") {
      found.push({
        scope: "map",
        rule: "site-on-wall",
        message: `点位 #${site.id} 压在 (${site.x},${site.y}) 的墙上;点位必须落在平原上。`,
        where: `sites[${site.id}]`,
      });
    }
  }
  return found;
};

/**
 * 变体槽位必须是**一条完整四重轨道**:4 格恰是其中某格的旋转轨道。
 * 定长 4 元组已经由类型与 schema 保证长度,这一条判的是「这 4 格是不是同一条轨道」——
 * 类型层管不到「它们是不是一伙的」。
 */
const variantSlotViolations = (map: MapDefinition): readonly MapLintViolation[] => {
  const size = map.size;
  const found: MapLintViolation[] = [];

  // 卫生判定所需的格子集合:点位格、点位八邻域、起始单位落点。
  const siteCells = new Set<string>();
  for (const site of map.sites) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) siteCells.add(key(site.x + dx, site.y + dy));
    }
  }
  const spawnCells = new Set<string>();
  for (const unit of map.spawnUnits) {
    const home = map.sites.find((site) => site.kind === "base" && site.initialOwner === unit.owner);
    if (home !== undefined) spawnCells.add(key(home.x + unit.offset[0], home.y + unit.offset[1]));
  }

  const cellsOf = (slot: MapVariantSlot): readonly (readonly [number, number])[] =>
    slot.map((coord) => [coord[0], coord[1]] as const);

  map.variantSlots.forEach((slot, index) => {
    const where = `variantSlots[${index}]`;
    const cells = cellsOf(slot);
    const wanted = new Set(cells.map(([x, y]) => key(x, y)));
    const isOrbit =
      cells.length === 4 &&
      cells.every(([x, y]) => isInside(x, y, size)) &&
      orbitOf(cells[0]?.[0] ?? 0, cells[0]?.[1] ?? 0, size)
        .map(([x, y]) => key(x, y))
        .every((cell) => wanted.has(cell));
    if (!isOrbit) {
      found.push({
        scope: "map",
        rule: "variant-slot-not-orbit",
        message: "变体槽位不是一条完整四重轨道:它必须恰好是 4 格,且这 4 格互为绕中心 90° 的旋转。",
        where,
      });
      return;
    }
    for (const [x, y] of cells) {
      if (siteCells.has(key(x, y))) {
        found.push({
          scope: "map",
          rule: "variant-slot-on-site",
          message: `变体槽位压住了 (${x},${y}),那是某个点位或其八邻域;墙格压住点位会改变点位可达性与初始条件的对称性。`,
          where,
        });
      }
      if (spawnCells.has(key(x, y))) {
        found.push({
          scope: "map",
          rule: "variant-slot-on-spawn",
          message: `变体槽位覆盖了 (${x},${y}) 上的初始单位落点。`,
          where,
        });
      }
      // 判据的另一半在 `MapVariantSlot` 的类型头注里承诺过(「槽位格不得与地形里已有的墙格
      // 重叠」),却在这一层缺席了很久:文档与类型都宣称了一条零强制力的断言。
      // 它的内容与上面两条不重合——点位八邻域里不许有墙(画墙的硬规则),所以真图上
      // 「压点位」与「压墙」判不到同一格上;而压墙这一条治的是种子往已有墙格里填格子,
      // 那会让这一格永远填不进东西(候选清单变成一张有死格的清单)。
      if (map.terrain[y]?.[x] === "#") {
        found.push({
          scope: "map",
          rule: "variant-slot-on-wall",
          message:
            `变体槽位的 (${x},${y}) 上地形里已经是一堵墙;候选轨道必须落在平原上,` +
            "否则这一格无论种子怎么选都填不进东西。",
          where,
        });
      }
    }
  });

  return found;
};

/**
 * 定位全序:没有定位的排在有定位的之后,与 `compareViolations` 把无位置的放末尾同一理由。
 *
 * 导出是因为池层也要用它:两层各写一份排序,作者就会在某次改动后看到「改一张图时违规顺序变了」
 * 这种与数据无关的抖动,而 diff 两轮 lint 结果的人正是靠顺序读噪声的。
 */
export const compareViolations = (left: MapLintViolation, right: MapLintViolation): number => {
  const ruleOrder = left.rule.localeCompare(right.rule);
  if (ruleOrder !== 0) return ruleOrder;
  const leftWhere = left.where ?? "";
  const rightWhere = right.where ?? "";
  return leftWhere === rightWhere
    ? left.message.localeCompare(right.message)
    : leftWhere === ""
      ? 1
      : rightWhere === ""
        ? -1
        : leftWhere.localeCompare(rightWhere);
};

/**
 * 一张地图 → 一组带定位的违规。**空数组 = 合规**。
 *
 * 违规按「类别名 + 定位」排全序:地图作者改一次图、跑一次 lint,两轮结果要能 diff 出来,
 * 而遍历顺序跟着数据顺序走不保证稳定(与 `compareViolations` 同一个理由)。
 */
export const mapViolations = (map: MapDefinition): readonly MapLintViolation[] =>
  [
    ...terrainShapeViolations(map),
    ...terrainSymmetryViolations(map),
    ...siteSymmetryViolations(map),
    ...sitePlacementViolations(map),
    ...variantSlotViolations(map),
  ].sort(compareViolations);
