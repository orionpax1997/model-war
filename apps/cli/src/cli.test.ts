import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MapDefinition } from "@model-war/schema";

/**
 * 命令行的外部可观察行为只有两件:帮助信息列出哪几条子命令,以及未实现的子命令怎么退。
 *
 * 断言对象是**打好的单文件产物**,不是 `src/index.ts` 里的内部函数——改了内部结构而
 * 让这些断言失效,就是坏断言(见 spec《Testing Decisions》)。所以这里跑真实的 bundle。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const mapPath = fileURLToPath(new URL("../../../maps/open-clash.json", import.meta.url));

const COMMANDS = ["gen", "run", "match", "replay", "verify", "map-lint"] as const;

/**
 * 尚未落地的子命令。`map-lint` 不在其中:它已实现,被下面那组自己的断言盯着。
 * 这张名单会随实现推进缩短——把一条命令搬出这张名单是“它有断言了”的信号。
 */
const UNIMPLEMENTED = ["gen", "run", "match", "replay", "verify"] as const;

let bundle = "";
let scratch = "";
let poolSeq = 0;

const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: repoRoot, encoding: "utf8" });

beforeAll(async () => {
  // 各包的 exports 指向 dist/,先让类型闸门把 dist 备齐。增量构建是空操作(实测 ~0.1s)。
  const typecheck = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
      "-b",
      "--pretty",
      "false",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(typecheck.status, `tsc -b 失败:\n${typecheck.stdout}${typecheck.stderr}`).toBe(0);

  scratch = mkdtempSync(`${tmpdir()}/modelwar-cli-`);
  bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/**
 * 在临时目录里造一个地图池并返回它的路径。
 *
 * `map-lint` 现在收的是**目录**,而 `maps/` 里只有一张图(池级判据要求至少 3 张,三张真图是
 * 票 05 的活),所以进程级断言得自己造池。造法与 `pool-lint.test.ts` 同源:沿用落库那张图的点位,
 * 墙从它的候选变体轨道里取——那 8 条轨道实测一格不压点位、天生四重对称。
 */
const writePool = (maps: readonly { name: string; terrain?: string[] }[]): string => {
  // 目录名带序号:同一个临时根下造两个池时不会互相覆盖(否则断言顺序一变就读到别人的文件)。
  poolSeq += 1;
  const dir = join(scratch, `pool-${poolSeq}`);
  mkdirSync(dir, { recursive: true });
  const source = openMap();
  for (const map of maps) {
    writeFileSync(join(dir, `${map.name}.json`), JSON.stringify({ ...source, ...map }));
  }
  return dir;
};

/** 落库那张开阔对攻图(进程级断言的原料;它本身是合规的)。 */
const openMap = (): MapDefinition => JSON.parse(readFileSync(mapPath, "utf8"));

/** 把候选变体轨道填进地形:第 `indexes` 几条。先清空原有墙,免得两图共享墙格。 */
const terrainWithOrbits = (source: MapDefinition, indexes: readonly number[]): string[] => {
  const rows = source.terrain.map((row) => row.replaceAll("#", ".").split(""));
  for (const index of indexes) {
    for (const [x, y] of source.variantSlots[index] ?? []) {
      const row = rows[y];
      if (row !== undefined) row[x] = "#";
    }
  }
  return rows.map((row) => row.join(""));
};

it("帮助信息列出全部六条子命令", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  for (const command of COMMANDS) {
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it("未知子命令非零退出", () => {
  const result = run(["not-a-command"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("未知子命令");
});

it("六条子命令都登记在册(帮助之外的入口也存在)", () => {
  for (const command of COMMANDS) {
    const result = run([command, "--help"]);
    expect(result.status, `${command} --help 应当成功`).toBe(0);
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it.each(UNIMPLEMENTED)("未实现的 %s 显式失败,不静默返回成功", (command) => {
  const result = run([command]);
  expect(result.status).not.toBe(0);
  // 退出码非零还不够:必须是"未实现"这条路径,而不是别处的崩溃。
  expect(result.stderr).toContain("未实现");
});

it("`map-lint` 不再走「未实现」那条路径", () => {
  const source = openMap();
  const dir = writePool([
    { name: "pool-a", terrain: terrainWithOrbits(source, [0]) },
    { name: "pool-b", terrain: terrainWithOrbits(source, [1, 2]) },
    { name: "pool-c", terrain: terrainWithOrbits(source, [3]) },
  ]);
  const result = run(["map-lint", dir]);
  expect(result.stderr).not.toContain("未实现");
  // 三张图合规(三张真图是票 05 的活,这里造的是同一套点位下的最小合规池),所以这一跑必须放行。
  expect(result.stdout).toContain("通过");
  expect(result.status).toBe(0);
});

it("`map-lint` 对不合法的地图池非零退出(退出码由处理器返回,不是 index.ts 给的)", () => {
  // 断言对象是退出码本身:`index.ts` 调完处理器无条件 `return 0`,处理器没有返回值通道,
  // 所以「非零退出」这条只能靠处理器把退出码一路返回到顶层。这里用一张改坏的图钉住它。
  const source = openMap();
  const rows = terrainWithOrbits(source, [0]);
  rows[0] = `${".".repeat(3)}#${".".repeat((rows[0]?.length ?? 0) - 4)}`;
  const dir = writePool([
    { name: "pool-a", terrain: rows },
    { name: "pool-b", terrain: terrainWithOrbits(source, [1, 2]) },
    { name: "pool-c", terrain: terrainWithOrbits(source, [3]) },
  ]);
  const result = run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地形未四重旋转对称");
});

it("`map-lint` 拿到一个不存在的目录时非零退出", () => {
  // 「目录不存在」这一格:不给它一句明确的失败,调用方会把「没查」读成「通过」。
  const result = run(["map-lint", join(scratch, "no-such-pool")]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("读不到目录");
});

it("`map-lint` 拿到一个空目录时判失败(而不是静默通过)", () => {
  const dir = join(scratch, "pool-empty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitkeep"), "");
  const result = run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地图池里没有地图");
});

it("`--version` 报的版本与 apps/cli/package.json 一致", () => {
  // index.ts 里的 CLI_VERSION 是写死的(打包后不读盘),而"与 package.json 同步"这句
  // 光写在注释里没有任何东西在盯。这里把它变成断言:改了一边不改另一边,这条会红。
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const result = run(["--version"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`modelwar ${manifest.version} `);
});
