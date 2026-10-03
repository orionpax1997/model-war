/**
 * `map-lint` 单图规则的自测(spec《Testing Decisions》的主缝)。
 *
 * 断言对象是**「一份地图数据 → 一组带定位的违规」**这个纯函数,不碰文件系统、不碰退出码。
 * 「目录薄壳不单独测」沿用仓库既有先例(禁浮点门禁 / 声明依赖门禁),所以本文件里没有 `mkdtemp`。
 *
 * 每条断言都配一个**能被弄红的反例**,而且反例是从**合规地图**改出来的——
 * 同一份 `OPEN` 一边当正例一边当反例的原料,这样「反例真的只坏了那一处」是可读的。
 * 地图的字段来自 `maps/open-clash.json` 的**同一份数据**(用 `satisfies MapDefinition` 约束),
 * 所以这张合规图不是本文件自己编的样本,而是仓库里真实落库的那一张。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { MapDefinition } from "@model-war/schema";
import { expect, it } from "vitest";

import { renderMapViolations } from "./render.js";
import { mapViolations, type MapLintRule } from "./rules.js";

/** 仓库里落库的合规地图。读它而不是重抄一份:重抄的那份迟早与 `maps/` 里的漂移。 */
const OPEN: MapDefinition = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../maps/open-clash.json", import.meta.url)), "utf8"),
);

const rulesOf = (map: MapDefinition): readonly MapLintRule[] => [
  ...new Set(mapViolations(map).map((violation) => violation.rule)),
];

const violationsOf = (map: MapDefinition) => mapViolations(map);

/**
 * 把一张合规图改坏。
 *
 * **参数类型刻意是 `Record<string, unknown>`**:类型层已经挡住一条长度不足 4 的槽位
 * (`tsc -b` 就红),而从文件读进来的 JSON 挡不住——形状层由 `validateMap` 担,
 * 跨字段层与它无干。所以反例必须从 JSON 值那一侧进来,规则层才有机会证明它判得了。
 * 这也是「规则层一个形状都不自己存」的含义:它判的是**数据**,不是类型。
 */
const broken = (patch: Record<string, unknown>): MapDefinition =>
  ({ ...OPEN, ...patch }) as MapDefinition;

// ── 合规地图:零违规 ──────────────────────────────────────────────────────────

it("落库的开阔对攻图过全部单图判据,零违规", () => {
  expect(violationsOf(OPEN)).toEqual([]);
});

it("每一条违规都带定位(不定位的违规等于让人回去肉眼数 4096 格)", () => {
  // 反例:把一处墙改掉,制造一条必然带位置的违规。
  const rows = [...OPEN.terrain];
  rows[5] = `${rows[5]?.slice(0, 3) ?? "..."}#${rows[5]?.slice(4) ?? ""}`;
  for (const violation of violationsOf(broken({ terrain: rows }))) {
    expect(violation.where, `${violation.rule} 缺定位`).not.toBeNull();
    expect(violation.message).not.toBe("");
  }
});

// ── 四重旋转对称:terrain 与 sites 是两条独立断言 ─────────────────────────────

it("terrain 破坏四重对称被拒", () => {
  const rows = [...OPEN.terrain];
  rows[0] = `${".".repeat(3)}#${".".repeat(60)}`;
  expect(rulesOf(broken({ terrain: rows }))).toContain("terrain-symmetry");
});

it("sites 破坏四重对称被拒(与 terrain 走不同代码路径,反例独立)", () => {
  // 挪走一个点位,另一个象限的对称伙伴就没了——terrain 一格没动。
  const sites = OPEN.sites.filter((site) => site.id !== 5);
  const rules = rulesOf(broken({ sites }));
  expect(rules).toContain("sites-symmetry");
  expect(rules).not.toContain("terrain-symmetry");
});

it("对称断言报的是「哪一格」而不是「这张图不对称」", () => {
  const rows = [...OPEN.terrain];
  rows[0] = `${".".repeat(3)}#${".".repeat(60)}`;
  const found = violationsOf(broken({ terrain: rows })).filter(
    (violation) => violation.rule === "terrain-symmetry",
  );
  expect(found.length).toBeGreaterThan(0);
  expect(found[0]?.where).toMatch(/^terrain\[\d+\]\[\d+\]$/);
});

// ── 点位:不重叠、不在墙上、不越界 ─────────────────────────────────────────────

it("点位重叠被拒", () => {
  const sites = OPEN.sites.map((site, index) =>
    index === 1 ? { ...site, x: OPEN.sites[0]?.x ?? 0, y: OPEN.sites[0]?.y ?? 0 } : site,
  );
  expect(rulesOf(broken({ sites }))).toContain("site-overlap");
});

it("点位压在墙上被拒", () => {
  // 找一堵真实的墙,把一个点位搬上去。
  const wallY = OPEN.terrain.findIndex((row) => row.includes("#"));
  expect(wallY).toBeGreaterThanOrEqual(0);
  const wallX = OPEN.terrain[wallY]?.indexOf("#") ?? -1;
  const sites = OPEN.sites.map((site, index) =>
    index === 0 ? { ...site, x: wallX, y: wallY } : site,
  );
  const rules = rulesOf(broken({ sites }));
  expect(rules).toContain("site-on-wall");
  expect(rules).toContain("sites-symmetry");
});

it("点位越界被拒", () => {
  const sites = OPEN.sites.map((site, index) =>
    index === 0 ? { ...site, x: OPEN.size + 3 } : site,
  );
  const rules = rulesOf(broken({ sites }));
  expect(rules).toContain("site-out-of-bounds");
  // 越界的那个点位**本身**不再出一条对称性违规:它已经由「越界」报过,再报一次是同一个
  // 错法的两条诊断,作者不知道先看哪条。它空出来的格子仍会拆散旋转伙伴的配对,
  // 那是另一条真违规(也确实验到了),不该被这条断言一起抹掉。
  const oob = OPEN.sites[0];
  expect(
    violationsOf(broken({ sites })).some(
      (violation) => violation.rule === "sites-symmetry" && violation.where === `sites[${oob?.id}]`,
    ),
  ).toBe(false);
});

// ── terrain 自洽:行数与行长 ─────────────────────────────────────────────────

it("terrain 行数与 size 不符被拒", () => {
  expect(rulesOf(broken({ terrain: OPEN.terrain.slice(1) }))).toContain("terrain-shape");
});

it("terrain 行长与 size 不符被拒", () => {
  const rows = [...OPEN.terrain];
  rows[3] = `${rows[3] ?? ""}.`;
  expect(rulesOf(broken({ terrain: rows }))).toContain("terrain-shape");
});

// ── 变体槽位:必须是完整四重轨道,且不压点位/起始位 ────────────────────────────

it("变体槽位长度不足 4 被拒", () => {
  expect(
    rulesOf(
      broken({
        variantSlots: [
          [
            [1, 1],
            [1, 2],
            [1, 3],
          ],
        ],
      }),
    ),
  ).toContain("variant-slot-not-orbit");
});

it("变体槽位不是轨道(4 格但不是某一格的旋转)被拒", () => {
  expect(
    rulesOf(
      broken({
        variantSlots: [
          [
            [1, 1],
            [1, 2],
            [1, 3],
            [1, 4],
          ],
        ],
      }),
    ),
  ).toContain("variant-slot-not-orbit");
});

it("变体槽位压在点位格上被拒", () => {
  const home = OPEN.sites.find((site) => site.kind === "base" && site.initialOwner === 0);
  expect(home).toBeDefined();
  if (home === undefined) return;
  expect(rulesOf(broken({ variantSlots: [orbitAt(home.x, home.y)] }))).toContain(
    "variant-slot-on-site",
  );
});

it("变体槽位压在点位八邻域内被拒(压邻域同样改变点位可达性)", () => {
  const home = OPEN.sites.find((site) => site.kind === "base" && site.initialOwner === 1);
  expect(home).toBeDefined();
  if (home === undefined) return;
  // 取主基地斜上方一格:它落在八邻域内,但不是点位格本身——两条判据都要能分别认出它。
  expect(rulesOf(broken({ variantSlots: [orbitAt(home.x + 1, home.y - 1)] }))).toContain(
    "variant-slot-on-site",
  );
});

it("变体槽位覆盖初始单位落点被拒", () => {
  const home = OPEN.sites.find((site) => site.kind === "base" && site.initialOwner === 2);
  const unit = OPEN.spawnUnits.find((entry) => entry.owner === 2);
  expect(home).toBeDefined();
  expect(unit).toBeDefined();
  if (home === undefined || unit === undefined) return;
  const rules = rulesOf(
    broken({ variantSlots: [orbitAt(home.x + unit.offset[0], home.y + unit.offset[1])] }),
  );
  expect(rules).toContain("variant-slot-on-spawn");
  // 初始单位落点与主基地挨着,所以它同时落在主基地的八邻域里——两条诊断都该在。
  expect(rules).toContain("variant-slot-on-site");
});

/** 从一格出发的那条完整四重轨道,与规则层同一条 `rot`。 */
const orbitAt = (x: number, y: number): readonly (readonly [number, number])[] => {
  const size = OPEN.size;
  const cells: [number, number][] = [];
  let cursor: [number, number] = [x, y];
  for (let turn = 0; turn < 4; turn += 1) {
    cells.push([cursor[0], cursor[1]]);
    cursor = [size - 1 - cursor[1], cursor[0]];
  }
  return cells;
};

// ── 违规序列的顺序是契约(两轮 lint 结果要能 diff) ────────────────────────────

it("同一份地图两次判定给出同一组违规(顺序也一样)", () => {
  const rows = [...OPEN.terrain];
  rows[0] = `${".".repeat(3)}#${".".repeat(60)}`;
  const brokenMap = broken({ terrain: rows });
  expect(violationsOf(brokenMap)).toEqual(violationsOf(brokenMap));
});

// ── 两层输出:同类合并成一行 ─────────────────────────────────────────────────

it("同类合并:逐格违规并成一行,而不是列出几千行", () => {
  const rows = [...OPEN.terrain];
  rows[0] = `${".".repeat(3)}#${".".repeat(60)}`;
  const text = renderMapViolations(violationsOf(broken({ terrain: rows })));
  const lines = text.trimEnd().split("\n");
  // 抬头一句 + 一条合并行。破坏一格会连带 3 格旋转伙伴,逐行列出的话这里是五行。
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("地形未四重旋转对称");
  expect(lines[1]).toContain("处");
});

it("面向作者的一行里带全部定位,且定位本身有序", () => {
  const rows = [...OPEN.terrain];
  rows[0] = `${".".repeat(3)}#${".".repeat(60)}`;
  const text = renderMapViolations(violationsOf(broken({ terrain: rows })));
  const positions = (text.match(/terrain\[\d+\]\[\d+\]/g) ?? []).map((token) =>
    Number(token.slice(8, token.indexOf("]"))),
  );
  expect(positions.length).toBeGreaterThan(1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

it("面向作者的一行里不出现内部记号", () => {
  const text = renderMapViolations(violationsOf(broken({ sites: OPEN.sites.slice(1) })));
  expect(text).not.toContain("sites-symmetry");
});

it("零违规渲染成「通过」那一句", () => {
  expect(renderMapViolations([])).toBe("地图校验通过:没有违规。\n");
});

// ── 同源:规则层一个形状都不自己存 ───────────────────────────────────────────

it("规则层不自己存槽位形状:收紧真源包的类型与 schema,判据随之改变", () => {
  // 断言对象是「同一批数据在两侧给出同一份判决」:合规图在票 01 收紧后的形状下零违规,
  // 而一条**长度不足 4** 的槽位——它在收紧前是合法的 JSON——现在被判失败。
  // 这条断言要抓的失败模式是「校验器把 `MapVariantSlot` 的形状抄了第二份」。
  expect(OPEN.variantSlots.every((slot) => slot.length === 4)).toBe(true);
  expect(
    violationsOf(
      broken({
        variantSlots: [
          [
            [1, 1],
            [1, 2],
            [1, 3],
          ],
        ],
      }),
    ),
  ).not.toEqual([]);
});
