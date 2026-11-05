/**
 * 自证桩与真图的接缝:每张落库地图都必须能被桩装载,且「地图 + 种子 → 地形」是纯函数。
 *
 * ── 为什么这条留在 unit,而不只在夜间的 `check:selfproof` 里 ──
 * `check:selfproof` 按设计不进快链(hld §11:它要真跑 64 场对局,代价与「提交前跑一遍」不匹配),
 * 于是**桩与真图脱节**这类故障只能在夜里被发现。这条用例是它的哨兵:只装载地图、不跑对局,
 * 单次几毫秒,却正是那次脱节的形态——桩侧「带 `mapFile` 就走真图」的接缝丢过一次
 * (标定环桩迁进 `packages/tools/selfproof/stub/` 时),而全仓没有任何东西会因此变红:
 * 桩的夹具表里没有真图名,`check:selfproof` 一跑就 throw,可它没人跑。
 *
 * ── 它不代替自证门禁 ──
 * 这里只问「装得上、装着对」,不问四问的取值。判据(契约能不能让模型写出合规脚本并打出正常终局)
 * 仍然只在 `check:selfproof` 里,位置不动。
 */

import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { repoRoot } from "../gates-harness.ts";

/** 桩的对局跑批入口所在文件(它是 `.mjs`,没有类型面;下面只声明本文件读到的几项)。 */
const STUB_HARNESS = `${repoRoot}packages/tools/selfproof/stub/harness.mjs`;

type StubMap = {
  readonly name: string;
  readonly variant: string;
  readonly size: number;
  readonly seed: number;
  readonly terrain: readonly (readonly string[])[];
  readonly sites: readonly { readonly kind: string; readonly owner: number }[];
  readonly spawnUnits: readonly { readonly x: number; readonly y: number }[];
  readonly variantSlots: readonly (readonly (readonly [number, number])[])[];
};

/** 桩侧的 job 形状(只写本文件真填的那几项)。 */
type StubJob = {
  readonly seatScripts: readonly string[];
  readonly seed: number;
  readonly mirror: boolean;
  readonly variant: string;
  readonly size: number;
  readonly mapFile: string;
};

/**
 * 用桩对真实跑批时走的那一道入口装地图(而不是直调装载器)。
 *
 * 连的是 `matchArgsOf`:门禁把 `mapFile` 放到 job 上、由它决定「读真图还是用夹具」，
 * 而丢过的那条接缝正好在这一层。直调 `loadMapFile` 只能证明「装载器写对了」,
 * 证明不了「有人调它」——那种漂移会以另一种形态再发生一次。
 *
 * 用**文件 URL** + `@vite-ignore` 而不是静态 `import`:被测对象是仓库里那份 `.mjs` 本身
 * (它不参与 TypeScript 构建、也没有声明文件),让 Node 直接加载它,才测得到真正跑对局的那份文件。
 */
const loadMap = async (file: string, seed: number): Promise<StubMap> => {
  const stub = (await import(/* @vite-ignore */ pathToFileURL(STUB_HARNESS).href)) as {
    readonly matchArgsOf: (job: StubJob) => { readonly map: StubMap };
  };
  return stub.matchArgsOf({
    seatScripts: [],
    seed,
    mirror: false,
    variant: "真图",
    size: 0,
    mapFile: file,
  }).map;
};

/** 落库地图池:`maps/` 目录本身(与 map-lint 的池口径同源,不另立一份清单)。 */
const MAP_FILES = readdirSync(`${repoRoot}maps`)
  .filter((name) => name.endsWith(".json"))
  .sort();

/** 与自证门禁同一组种子(桩的 `SEEDS_PROBE` 口径)。 */
const SEEDS = [11, 23, 41, 71] as const;

it("maps/ 至少有一张真图可装载", () => {
  expect(MAP_FILES.length).toBeGreaterThan(0);
});

it("每张落库地图都能被自证桩装载,且形状自洽", async () => {
  for (const fileName of MAP_FILES) {
    const map = await loadMap(`${repoRoot}maps/${fileName}`, SEEDS[0]);
    expect(map.size, `${fileName} 的 size 没读出来`).toBeGreaterThan(0);
    expect(map.terrain.length, `${fileName} 的地形行数与 size 不符`).toBe(map.size);
    for (const [y, row] of map.terrain.entries()) {
      expect(row.length, `${fileName} 地形第 ${y} 行长度与 size 不符`).toBe(map.size);
      // 桩引擎只认这两档:别的地形字符会在跑对局时变成「不可走也不可建」的第三种格子。
      for (const cell of row) {
        expect(["plain", "wall"]).toContain(cell);
      }
    }
    expect(map.sites.length, `${fileName} 没有读入任何点位`).toBeGreaterThan(0);
    expect(map.spawnUnits.length, `${fileName} 没有读入任何起始单位`).toBeGreaterThan(0);
  }
});

it("走 job 上的 `mapFile` 真拿到真图,而不是退回夹具", async () => {
  // 夹具臂与真图臂的区分就在这一条:同一张图四个名字里,夹具只有两个变体名,
  // 而真图的名字来自 `maps/*.json` 自己。装载器写对了但没人调,这里就会退回夹具或直接抛。
  for (const fileName of MAP_FILES) {
    const map = await loadMap(`${repoRoot}maps/${fileName}`, SEEDS[0]);
    expect(map.variant, `${fileName} 被当成了夹具变体`).toBe(fileName.replace(/\.json$/u, ""));
    expect(map.name).toContain("realmap/");
  }
});

it("「地图 + 种子 → 地形」是纯函数:同种子同图", async () => {
  for (const fileName of MAP_FILES) {
    const file = `${repoRoot}maps/${fileName}`;
    const first = await loadMap(file, SEEDS[1]);
    const again = await loadMap(file, SEEDS[1]);
    expect(again.terrain, `${fileName} 同种子两次装载的地形不同`).toEqual(first.terrain);
    expect(again.variantSlots, `${fileName} 同种子两次装载的变体槽位不同`).toEqual(
      first.variantSlots,
    );
  }
});

it("变体墙真的接上了种子:四颗种子至少得到两种地形", async () => {
  // 桩的变体墙是**装饰性微扰**,不改变点位与起始单位;但若这条接缝丢了,四颗种子会退化成
  // 「同一张图跑四遍」,而四问的读数看不出这件事——它们只比策略之间的差,不比种子之间的差。
  for (const fileName of MAP_FILES) {
    const shapes = new Set<string>();
    for (const seed of SEEDS) {
      const map = await loadMap(`${repoRoot}maps/${fileName}`, seed);
      shapes.add(map.terrain.map((row) => row.join("")).join("\n"));
    }
    expect(shapes.size, `${fileName} 四颗种子得到同一张地形(变体墙没接上种子)`).toBeGreaterThan(1);
  }
});
